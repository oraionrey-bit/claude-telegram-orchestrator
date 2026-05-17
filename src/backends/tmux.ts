// ── TmuxBackend: drives interactive `claude` (no -p) inside a detached tmux session ──
//
// Why this exists: hedge against `claude --print` (the pipe backend) being
// deprecated or breaking. The interactive UI is the supported product surface,
// so it's the most likely thing to keep working.
//
// Mechanics:
//   1. Each session gets a tmux session named `oraion-{sanitized-key}`.
//   2. We generate a per-session settings JSON at /tmp/oraion-settings-{key}.json
//      that registers PreToolUse / PostToolUse / Stop / UserPromptSubmit hooks.
//      Each hook is a one-liner shell command that appends the raw stdin JSON
//      (plus an event-name tag) to /tmp/oraion-hook-events-{key}.jsonl.
//   3. We `tmux new-session -d -s {tmuxName} … 'claude --settings <file> …'`
//      and wait for the welcome screen to render (trust prompt may need Enter).
//   4. To send a message: `tmux send-keys -t {tmuxName} -l '<text>'` then Enter.
//      Newlines inside the literal text are accepted as multi-line input.
//   5. We tail the hook events file. PreToolUse / PostToolUse drive tool
//      progress callbacks. The Stop hook's `last_assistant_message` field
//      gives us the FULL final assistant text — no pane-scraping needed.
//   6. For streaming text deltas, we tail the transcript JSONL (path is
//      provided in every hook payload) and emit assistant text per turn.
//
// Crash resilience: on spawn(), if `tmux has-session -t {name}` succeeds, we
// REUSE the existing tmux (Claude is still running from before the orchestrator
// restart) and re-attach to its event/transcript logs. If we can't recover the
// transcript path, we fall back to a fresh spawn.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, watch as fsWatch, statSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  BackendCallbacks,
  OnDeltaCallback,
  OnToolUseCallback,
  OnToolCompleteCallback,
  SessionBackend,
  SpawnOpts,
} from "./types";
import type { ContentBlock } from "../types";
import { saveSessionMeta } from "../memory";
import type { Logger } from "../utils";
import { describeToolInvocation } from "./pipe";

const HOOK_HELPER_PATH = "/tmp/oraion-hook-emit.sh";
const SETTINGS_DIR = "/tmp";
const EVENTS_DIR = "/tmp";

// Time we wait after spawning tmux for Claude's UI to come up + the trust
// prompt to be answered. The trust prompt only appears once per workdir per
// machine, but we always send Enter after the wait — extra Enter is harmless.
const SPAWN_SETTLE_MS = 5000;

// Time we allow between send-keys submit and the Stop hook firing before we
// give up. Matches the pipe backend's TOTAL_TIMEOUT_MS.
const TOTAL_TIMEOUT_MS = 30 * 60 * 1000;

// If no hook events arrive for this long after submit, treat as dead.
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

interface HookEvent {
  ts: number;
  event: "PreToolUse" | "PostToolUse" | "Stop" | "UserPromptSubmit" | "SessionStart";
  payload: {
    session_id?: string;
    transcript_path?: string;
    cwd?: string;
    hook_event_name?: string;
    tool_name?: string;
    tool_input?: Record<string, unknown>;
    tool_response?: { stdout?: string; stderr?: string };
    tool_use_id?: string;
    duration_ms?: number;
    last_assistant_message?: string;
    stop_hook_active?: boolean;
    prompt?: string;
  };
}

interface PendingTurn {
  resolve: (text: string) => void;
  // The latest text we've seen from the transcript for THIS turn. Updated as
  // assistant messages arrive in the JSONL. Used as the response if Stop
  // arrives without a `last_assistant_message`.
  accumulatedText: string;
  callbacks: BackendCallbacks;
  startedAt: number;
  lastActivity: number;
  // For dedup: don't fire onToolComplete twice for the same tool_use_id.
  pendingTools: Map<string, { name: string; startedAt: number }>;
  // We only consider Stop events that occur AFTER the UserPromptSubmit for
  // this turn. Without this, an in-flight session could trip on a stale Stop
  // from a prior interaction.
  promptSeen: boolean;
}

/** Sanitize a session key into a tmux-safe name. */
function tmuxNameFor(key: string): string {
  return `oraion-${key.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

function settingsPathFor(key: string): string {
  return join(SETTINGS_DIR, `oraion-settings-${key.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);
}

function eventsPathFor(key: string): string {
  return join(EVENTS_DIR, `oraion-hook-events-${key.replace(/[^a-zA-Z0-9_-]/g, "_")}.jsonl`);
}

/** Write the shared hook-emit shell helper. Idempotent. */
function ensureHookHelper(): void {
  // The helper takes (event_name, events_file) and appends a JSON line of
  // {ts, event, payload: <stdin JSON>}. We use jq to safely embed the payload;
  // if jq is unavailable we fall back to raw concat.
  // Note on timestamps: macOS BSD `date` does NOT support %N (nanoseconds) the
  // way GNU date does — `date +%s%3N` literally produces e.g. "1778744095N",
  // which breaks JSON parsing. We use plain epoch seconds (sufficient for
  // ordering since hook events are inherently serialized at the OS-fork
  // level) and let JS Date.now() upgrade to ms precision on the consumer
  // side via observation order.
  const script = `#!/usr/bin/env bash
# Hook emitter for the TmuxBackend. Reads JSON from stdin, appends a tagged
# event line to the events file. Args: <event_name> <events_file>.
set -uo pipefail
EVENT="$1"
EVENTS_FILE="$2"
INPUT=$(cat)
TS=$(date +%s)
# Best-effort: if input isn't valid JSON, wrap it as a string.
if echo "$INPUT" | jq empty 2>/dev/null; then
  printf '{"ts":%s,"event":"%s","payload":%s}\\n' "$TS" "$EVENT" "$INPUT" >> "$EVENTS_FILE"
else
  ESCAPED=$(printf '%s' "$INPUT" | jq -Rs .)
  printf '{"ts":%s,"event":"%s","payload":%s}\\n' "$TS" "$EVENT" "$ESCAPED" >> "$EVENTS_FILE"
fi
`;
  writeFileSync(HOOK_HELPER_PATH, script, { mode: 0o755 });
}

/** Generate the per-session settings.json that registers our hooks. */
function writeSessionSettings(key: string): string {
  const path = settingsPathFor(key);
  const eventsFile = eventsPathFor(key);
  const cmd = (event: string) => `${HOOK_HELPER_PATH} ${event} ${eventsFile}`;
  // We register the four lifecycle events we care about. Settings does NOT
  // disable other user-level hooks (--setting-sources still loads user scope),
  // so the user's ghost hooks continue to fire too.
  const settings = {
    permissions: { defaultMode: "bypassPermissions" },
    hooks: {
      PreToolUse: [{ hooks: [{ type: "command", command: cmd("PreToolUse"), timeout: 5000 }] }],
      PostToolUse: [{ hooks: [{ type: "command", command: cmd("PostToolUse"), timeout: 5000 }] }],
      UserPromptSubmit: [{ hooks: [{ type: "command", command: cmd("UserPromptSubmit"), timeout: 5000 }] }],
      Stop: [{ hooks: [{ type: "command", command: cmd("Stop"), timeout: 5000 }] }],
    },
  };
  writeFileSync(path, JSON.stringify(settings, null, 2));
  return path;
}

/** Run a tmux command synchronously and return success. */
function tmux(args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync("tmux", args, { encoding: "utf-8" });
  return { ok: r.status === 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function tmuxHasSession(name: string): boolean {
  return tmux(["has-session", "-t", name]).ok;
}

export class TmuxBackend implements SessionBackend {
  readonly kind = "tmux" as const;
  private logger: Logger;
  private model: string;
  private workDir: string;
  private sessionId: string | null;
  private tmuxName: string;
  private settingsPath: string;
  private eventsPath: string;
  private transcriptPath: string | null = null;
  private lastActivity: number = Date.now();
  private messageCount: number = 0;
  private pendingTurn: PendingTurn | null = null;
  private spawnedAt: number = 0;
  private alive: boolean = false;
  // Tail position bookkeeping: byte offset into the events file we've consumed.
  private eventsOffset: number = 0;
  private transcriptOffset: number = 0;
  private eventsWatcher: ReturnType<typeof fsWatch> | null = null;
  private transcriptWatcher: ReturnType<typeof fsWatch> | null = null;
  // Mutex for serializing sendMessage calls per session. Without this, two
  // overlapping sends would both wait on `pendingTurn` and one would silently
  // hijack the other's response.
  private inflightChain: Promise<unknown> = Promise.resolve();

  constructor(public readonly key: string, opts: SpawnOpts) {
    this.logger = opts.logger;
    this.model = opts.model;
    this.workDir = opts.workdir;
    this.sessionId = opts.previousSessionId ?? null;
    this.tmuxName = tmuxNameFor(key);
    this.settingsPath = settingsPathFor(key);
    this.eventsPath = eventsPathFor(key);
  }

  async spawn(opts: SpawnOpts): Promise<void> {
    this.workDir = opts.workdir;
    this.model = opts.model;
    if (opts.previousSessionId && !this.sessionId) {
      this.sessionId = opts.previousSessionId;
    }

    // Reuse path: if the tmux session already exists, just re-attach our tail.
    // Don't truncate the events file — old events from the previous run will
    // be skipped because we seek to current end before submitting.
    const existed = tmuxHasSession(this.tmuxName);
    if (existed) {
      this.logger.info(`[tmux:${this.key}] Reusing existing tmux session ${this.tmuxName}`);
      this.alive = true;
      this.startEventsTail();
      return;
    }

    // Fresh spawn. Truncate events file to a known starting point.
    ensureHookHelper();
    writeSessionSettings(this.key);
    try { mkdirSync(this.workDir, { recursive: true }); } catch { /* ok */ }
    // Truncate events file
    writeFileSync(this.eventsPath, "");
    this.eventsOffset = 0;
    this.transcriptOffset = 0;
    this.transcriptPath = null;

    const claudeArgs: string[] = [
      "claude",
      "--model", this.model,
      "--permission-mode", "bypassPermissions",
      "--settings", this.settingsPath,
      "--setting-sources", "project,user",  // Keep user-level hooks (ghost) loaded
    ];

    // MCP config — same as PipeBackend
    const mcpConfig = join(process.env.HOME || homedir(), ".claude", "mcp_servers.json");
    if (existsSync(mcpConfig)) {
      claudeArgs.push("--mcp-config", mcpConfig);
    }

    if (this.sessionId) {
      claudeArgs.push("--resume", this.sessionId);
      this.logger.info(`[tmux:${this.key}] Resuming Claude session ${this.sessionId}`);
    }

    // Compose the command for tmux. We pass a single shell string so tmux
    // executes it directly — quote any args with spaces.
    const cmdString = claudeArgs.map(quoteShell).join(" ");
    const tmuxArgs = [
      "new-session", "-d",
      "-s", this.tmuxName,
      "-x", "200", "-y", "50",  // Force a wide pane so Claude doesn't wrap aggressively
      "-c", this.workDir,
      cmdString,
    ];

    this.logger.info(`[tmux:${this.key}] Spawning tmux session ${this.tmuxName} in ${this.workDir}`);
    const r = tmux(tmuxArgs);
    if (!r.ok) {
      this.logger.error(`[tmux:${this.key}] tmux new-session failed: ${r.stderr}`);
      throw new Error(`tmux new-session failed: ${r.stderr}`);
    }

    this.spawnedAt = Date.now();
    this.alive = true;

    // Wait for Claude to settle (welcome screen + possible trust prompt). We
    // send Enter after the settle period — if there's a trust prompt it gets
    // confirmed; if there isn't, the Enter on an empty input box is harmless.
    await sleep(SPAWN_SETTLE_MS);
    tmux(["send-keys", "-t", this.tmuxName, "Enter"]);
    // Small extra delay so the welcome panel collapses and the input box is ready.
    await sleep(800);

    this.startEventsTail();
  }

  sendMessage(content: ContentBlock[], callbacks?: BackendCallbacks): Promise<string> {
    // Serialize: one in-flight send per session. The `inflightChain` makes
    // back-to-back calls run strictly sequentially.
    const next = this.inflightChain.then(() => this.doSend(content, callbacks ?? {}));
    this.inflightChain = next.catch(() => {});
    return next;
  }

  private async doSend(content: ContentBlock[], callbacks: BackendCallbacks): Promise<string> {
    if (!this.alive || !tmuxHasSession(this.tmuxName)) {
      this.logger.warn(`[tmux:${this.key}] tmux gone, respawning`);
      this.alive = false;
      await this.spawn({
        workdir: this.workDir,
        model: this.model,
        previousSessionId: this.sessionId ?? undefined,
        logger: this.logger,
      });
    }

    this.lastActivity = Date.now();
    this.messageCount++;

    // Convert content blocks → a single text payload. Images are NOT supported
    // by tmux send-keys (it's a text channel). The bot layer is expected to
    // either downconvert or save-and-reference; here we politely refuse.
    const textParts: string[] = [];
    for (const block of content) {
      if (block.type === "text") {
        textParts.push(block.text);
      } else if (block.type === "image") {
        // Save the image to inbox/ and reference it by path. The receiving
        // Claude can Read() the file.
        const inboxDir = join(this.workDir, "inbox");
        try { mkdirSync(inboxDir, { recursive: true }); } catch { /* ok */ }
        const ext = block.source.media_type.split("/").pop() || "bin";
        const fname = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
        const fpath = join(inboxDir, fname);
        try {
          writeFileSync(fpath, Buffer.from(block.source.data, "base64"));
          textParts.push(`[Image attached at ${fpath} — please use the Read tool to view it.]`);
        } catch (err) {
          this.logger.warn(`[tmux:${this.key}] Failed to save image attachment: ${err}`);
          textParts.push("[Image attachment could not be saved.]");
        }
      }
    }
    const messageText = textParts.join("\n").trim();
    if (!messageText) {
      return "(empty message — nothing to send)";
    }

    // Snapshot the current end of BOTH log files. Any subsequent events /
    // transcript entries belong to this turn. Without this, the transcript
    // tail can replay the previous turn's assistant text into the new turn's
    // onDelta callback (because the transcript poll may not have caught the
    // last write before Stop resolved the previous turn).
    const preSubmitEventsOffset = currentSize(this.eventsPath);
    this.eventsOffset = Math.max(this.eventsOffset, preSubmitEventsOffset);
    if (this.transcriptPath) {
      const preSubmitTranscriptOffset = currentSize(this.transcriptPath);
      this.transcriptOffset = Math.max(this.transcriptOffset, preSubmitTranscriptOffset);
    }

    // Slash-command short-circuit: client-side commands like /cost, /compact,
    // /context, /clear are handled by Claude's UI WITHOUT hitting the model.
    // No Stop hook fires, so awaiting it would hang until our 30min timeout.
    // We send-keys, give the UI a beat to render, then capture the pane and
    // return it as the "response". Best-effort — the pane has UI chrome we
    // strip with a simple ANSI/box filter.
    const isClientSlash = /^\/(cost|compact|context|clear|memory|doctor|login|logout|help|model|status|agents|skill|skills|init|review|config|hooks|permissions|effort|continue|resume|approved-tools|disallow-tool|allow-tool|reload-skills|tools|debug|list-skills|chrome|ide|export|theme|vim|brief|notify)\b/.test(messageText.trim());
    if (isClientSlash) {
      const r = tmux(["send-keys", "-t", this.tmuxName, "-l", messageText]);
      if (!r.ok) {
        return "(failed to send slash command to tmux)";
      }
      tmux(["send-keys", "-t", this.tmuxName, "Enter"]);
      // Give the UI ~2s to render
      await sleep(2000);
      const pane = tmux(["capture-pane", "-t", this.tmuxName, "-p", "-S", "-50"]);
      // Strip ANSI escape sequences and return the visible text. Pane has lots
      // of chrome (banner, hints, footer); we keep it all and let the bot
      // present it as-is — slash commands are diagnostic by nature.
      const stripped = stripAnsi(pane.stdout)
        .split("\n")
        .filter((line) => line.trim() && !/^[─━]+$/.test(line.trim()))
        .join("\n")
        .trim();
      return stripped || "(slash command sent — no visible output)";
    }

    // Send the message text, then Enter.
    // tmux send-keys -l takes a single literal string. Newlines are accepted.
    // We split on chunks of ~1k chars to avoid blowing the OS argv limit on
    // very long messages (e.g. PDF text dumps).
    const CHUNK = 8000;
    if (messageText.length <= CHUNK) {
      const r = tmux(["send-keys", "-t", this.tmuxName, "-l", messageText]);
      if (!r.ok) {
        this.logger.error(`[tmux:${this.key}] send-keys failed: ${r.stderr}`);
        return "(failed to send message to tmux)";
      }
    } else {
      for (let i = 0; i < messageText.length; i += CHUNK) {
        const piece = messageText.slice(i, i + CHUNK);
        const r = tmux(["send-keys", "-t", this.tmuxName, "-l", piece]);
        if (!r.ok) {
          this.logger.error(`[tmux:${this.key}] send-keys chunk failed: ${r.stderr}`);
          return "(failed to send message to tmux)";
        }
        // Tiny pause between chunks so the input buffer stays sane.
        await sleep(20);
      }
    }
    // Submit
    tmux(["send-keys", "-t", this.tmuxName, "Enter"]);

    // Set up the pending turn and wait for Stop.
    return new Promise<string>((resolve) => {
      const turn: PendingTurn = {
        resolve,
        accumulatedText: "",
        callbacks,
        startedAt: Date.now(),
        lastActivity: Date.now(),
        pendingTools: new Map(),
        promptSeen: false,
      };
      this.pendingTurn = turn;

      // Watchdog: if no hook events arrive for IDLE_TIMEOUT_MS, or we exceed
      // TOTAL_TIMEOUT_MS, give up gracefully with whatever text we have.
      const watchdog = setInterval(() => {
        if (this.pendingTurn !== turn) {
          clearInterval(watchdog);
          return;
        }
        const idle = Date.now() - turn.lastActivity;
        const total = Date.now() - turn.startedAt;
        if (idle > IDLE_TIMEOUT_MS || total > TOTAL_TIMEOUT_MS) {
          const reason = idle > IDLE_TIMEOUT_MS
            ? `idle ${Math.round(idle / 1000)}s`
            : `total ${Math.round(total / 60_000)}min`;
          this.logger.warn(`[tmux:${this.key}] Response timeout (${reason})`);
          clearInterval(watchdog);
          this.pendingTurn = null;
          resolve(turn.accumulatedText || "(response timed out — no partial text available)");
        }
      }, 30_000);
    });
  }

  isAlive(): boolean {
    return this.alive && tmuxHasSession(this.tmuxName);
  }

  inflightCount(): number {
    return this.pendingTurn !== null ? 1 : 0;
  }

  hasInflightResponses(): boolean {
    return this.pendingTurn !== null;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  touch(): void {
    this.lastActivity = Date.now();
  }

  getLastActivity(): number {
    return this.lastActivity;
  }

  getMessageCount(): number {
    return this.messageCount;
  }

  async kill(): Promise<void> {
    if (this.eventsWatcher) {
      try { this.eventsWatcher.close(); } catch { /* ok */ }
      this.eventsWatcher = null;
    }
    if (this.transcriptWatcher) {
      try { this.transcriptWatcher.close(); } catch { /* ok */ }
      this.transcriptWatcher = null;
    }
    if (tmuxHasSession(this.tmuxName)) {
      tmux(["kill-session", "-t", this.tmuxName]);
      this.logger.info(`[tmux:${this.key}] Killed tmux session ${this.tmuxName}`);
    }
    this.alive = false;
    if (this.pendingTurn) {
      this.pendingTurn.resolve(this.pendingTurn.accumulatedText || "(session killed)");
      this.pendingTurn = null;
    }
  }

  // ── Internal: tail the hook events file ──

  private startEventsTail(): void {
    if (this.eventsWatcher) return;
    // Seek to current end so we don't replay history.
    this.eventsOffset = currentSize(this.eventsPath);
    // Use fs.watch + a poller fallback (fs.watch on macOS can miss events on
    // append-heavy files). We poll every 200ms which is plenty fast for
    // human-perceivable updates.
    const poll = setInterval(() => {
      this.drainEvents().catch((err) => {
        this.logger.warn(`[tmux:${this.key}] drainEvents error: ${err}`);
      });
    }, 200);
    // Wrap setInterval as a watcher-like object so kill() can stop it.
    this.eventsWatcher = {
      close: () => clearInterval(poll),
    } as unknown as ReturnType<typeof fsWatch>;
  }

  private async drainEvents(): Promise<void> {
    const size = currentSize(this.eventsPath);
    if (size <= this.eventsOffset) return;
    const fh = await open(this.eventsPath, "r");
    try {
      const len = size - this.eventsOffset;
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, this.eventsOffset);
      this.eventsOffset = size;
      const text = buf.toString("utf-8");
      const lines = text.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const ev = JSON.parse(trimmed) as HookEvent;
          this.handleHookEvent(ev);
        } catch {
          this.logger.debug(`[tmux:${this.key}] Non-JSON hook line: ${trimmed.slice(0, 120)}`);
        }
      }
    } finally {
      await fh.close();
    }
  }

  private handleHookEvent(ev: HookEvent): void {
    const turn = this.pendingTurn;

    // Always update sessionId / transcriptPath from any event payload — this
    // lets us learn the transcript path even on the very first prompt.
    if (ev.payload.session_id && ev.payload.session_id !== this.sessionId) {
      this.sessionId = ev.payload.session_id;
      saveSessionMeta(this.key, { sessionId: this.sessionId });
    }
    if (ev.payload.transcript_path && ev.payload.transcript_path !== this.transcriptPath) {
      this.transcriptPath = ev.payload.transcript_path;
      // Start tailing the transcript for streaming text deltas.
      this.startTranscriptTail();
    }

    if (!turn) return;
    turn.lastActivity = Date.now();

    switch (ev.event) {
      case "UserPromptSubmit":
        turn.promptSeen = true;
        break;

      case "PreToolUse": {
        const name = ev.payload.tool_name;
        const id = ev.payload.tool_use_id;
        if (!name || !id) break;
        const desc = describeToolInvocation(name, ev.payload.tool_input);
        turn.pendingTools.set(id, { name, startedAt: Date.now() });
        if (turn.callbacks.onToolUse) {
          try { turn.callbacks.onToolUse(name, desc); } catch { /* ignore callback errors */ }
        }
        break;
      }

      case "PostToolUse": {
        const name = ev.payload.tool_name;
        const id = ev.payload.tool_use_id;
        if (!name || !id) break;
        const tracked = turn.pendingTools.get(id);
        const startedAt = tracked?.startedAt ?? (Date.now() - (ev.payload.duration_ms ?? 0));
        const duration = ev.payload.duration_ms ?? (Date.now() - startedAt);
        turn.pendingTools.delete(id);
        if (turn.callbacks.onToolComplete) {
          try { turn.callbacks.onToolComplete(name, duration); } catch { /* ignore */ }
        }
        break;
      }

      case "Stop": {
        // Only honor Stop AFTER we've seen the prompt for this turn.
        if (!turn.promptSeen) {
          this.logger.debug(`[tmux:${this.key}] Stop fired before UserPromptSubmit — ignoring`);
          break;
        }
        // Use last_assistant_message as the authoritative response text. If
        // empty or missing, fall back to whatever we accumulated from the
        // transcript tail.
        const text = (ev.payload.last_assistant_message ?? "").trim() || turn.accumulatedText;
        // Fire one final delta with the complete text, in case the bot is
        // doing streaming UI and hasn't seen the closing tail yet.
        if (text && turn.callbacks.onDelta) {
          try { turn.callbacks.onDelta(text); } catch { /* ignore */ }
        }
        this.logger.info(`[tmux:${this.key}] Response ready (${text.length} chars)`);
        this.pendingTurn = null;
        turn.resolve(text || "(no response)");
        break;
      }
    }
  }

  // ── Internal: tail the transcript JSONL for streaming assistant text ──
  //
  // Each line in the transcript is a JSON event. We care about lines where
  // type === "assistant" and message.content[].type === "text" — those are
  // the assistant's narrated text per turn. We accumulate text within a turn
  // and fire onDelta as it grows.

  private startTranscriptTail(): void {
    if (this.transcriptWatcher || !this.transcriptPath) return;
    // Seek to current end so we don't replay history (resumed sessions have
    // long transcripts already; we only want the new turn).
    if (existsSync(this.transcriptPath)) {
      this.transcriptOffset = currentSize(this.transcriptPath);
    } else {
      this.transcriptOffset = 0;
    }
    const poll = setInterval(() => {
      this.drainTranscript().catch((err) => {
        this.logger.warn(`[tmux:${this.key}] drainTranscript error: ${err}`);
      });
    }, 250);
    this.transcriptWatcher = {
      close: () => clearInterval(poll),
    } as unknown as ReturnType<typeof fsWatch>;
  }

  private async drainTranscript(): Promise<void> {
    if (!this.transcriptPath || !existsSync(this.transcriptPath)) return;
    const size = currentSize(this.transcriptPath);
    if (size <= this.transcriptOffset) return;
    const fh = await open(this.transcriptPath, "r");
    try {
      const len = size - this.transcriptOffset;
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, this.transcriptOffset);
      this.transcriptOffset = size;
      const text = buf.toString("utf-8");
      const lines = text.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const entry = JSON.parse(trimmed) as {
            type?: string;
            timestamp?: string;
            message?: {
              role?: string;
              content?: Array<{ type?: string; text?: string }>;
            };
          };
          if (entry.type === "assistant" && entry.message?.role === "assistant") {
            // Drop entries written before this turn started — Claude's
            // transcript poll may lag the Stop hook by a few hundred ms, so
            // the previous turn's assistant text can land in the file AFTER
            // we've seeked past it. Filter by timestamp to be safe.
            if (this.pendingTurn && entry.timestamp) {
              const entryTs = Date.parse(entry.timestamp);
              if (Number.isFinite(entryTs) && entryTs < this.pendingTurn.startedAt) {
                continue;
              }
            }
            const content = entry.message.content ?? [];
            let chunk = "";
            for (const block of content) {
              if (block.type === "text" && block.text) chunk += block.text;
            }
            if (chunk && this.pendingTurn) {
              // Each transcript "assistant" line represents one assistant
              // turn (text + tool calls). The text is the FULL turn text,
              // not a delta. Append turns as we see them — for a typical
              // reply there's one turn; for tool-use sequences there may be
              // a narration turn before tools and a final text turn after.
              if (this.pendingTurn.accumulatedText) {
                this.pendingTurn.accumulatedText += "\n\n" + chunk;
              } else {
                this.pendingTurn.accumulatedText = chunk;
              }
              this.pendingTurn.lastActivity = Date.now();
              if (this.pendingTurn.callbacks.onDelta) {
                try {
                  this.pendingTurn.callbacks.onDelta(this.pendingTurn.accumulatedText);
                } catch { /* ignore */ }
              }
            }
          }
        } catch {
          // Non-JSON line or malformed — skip.
        }
      }
    } finally {
      await fh.close();
    }
  }
}

// ── Tiny utilities ──

function quoteShell(s: string): string {
  // POSIX single-quote escape: end the quote, escape ', re-open. Cheap and
  // safe for tmux's "command string" interpretation.
  if (/^[a-zA-Z0-9_\-./=]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function currentSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

// Lightweight ANSI escape stripper. Matches CSI sequences (most colors and
// cursor-movement) and OSC sequences (terminal title etc.). Good enough for
// pane captures we present as text. Avoids pulling in the strip-ansi npm
// dependency for a few lines of regex.
const ANSI_REGEX = /[][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-PR-TZcf-nq-uy=><]/g;
const ANSI_OSC_REGEX = /\][^]*/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_REGEX, "").replace(ANSI_OSC_REGEX, "");
}


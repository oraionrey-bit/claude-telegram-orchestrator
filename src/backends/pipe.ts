// ── PipeBackend: drives `claude --print` over stream-json stdio ──
//
// This is the original (and currently default) backend. Mechanics:
//   1. Spawn `claude --print --input-format stream-json --output-format stream-json …`
//   2. Write user messages as one-line stream-json objects to stdin.
//   3. Read assistant events back from stdout (also one-line stream-json),
//      dispatch them: text deltas → onDelta, tool_use → onToolUse, etc.
//   4. A "result" event marks the end of an assistant turn → resolve the
//      pending sendMessage promise with the accumulated text.
//
// All behavior here is identical to what was previously in src/session.ts —
// this is a refactor, not a rewrite. The bot continues to behave the same
// for any session not opted into TmuxBackend.

import { join } from "path";
import { existsSync } from "fs";
import { homedir } from "os";
import type {
  BackendCallbacks,
  OnDeltaCallback,
  OnToolUseCallback,
  OnToolCompleteCallback,
  SessionBackend,
  SpawnOpts,
} from "./types";
import type { ClaudeStreamEvent, ContentBlock } from "../types";
import { saveSessionMeta } from "../memory";
import type { Logger } from "../utils";

interface RuntimeState {
  proc: ReturnType<typeof Bun.spawn> | null;
  sessionId: string | null;
  lastActivity: number;
  messageCount: number;
  workDir: string;
  // Reader state
  stdoutBuffer: string;
  responseResolve: ((text: string) => void) | null;
  responseText: string;
  readerActive: boolean;
  // Per-turn callbacks
  onDelta: OnDeltaCallback | null;
  onToolUse: OnToolUseCallback | null;
  onToolComplete: OnToolCompleteCallback | null;
  lastToolName: string | null;
  lastToolStartTime: number | null;
}

export class PipeBackend implements SessionBackend {
  readonly kind = "pipe" as const;
  private state: RuntimeState;
  private logger: Logger;
  private model: string;
  private spawnedAt: number = 0;

  constructor(public readonly key: string, opts: SpawnOpts) {
    this.logger = opts.logger;
    this.model = opts.model;
    this.state = {
      proc: null,
      sessionId: opts.previousSessionId ?? null,
      lastActivity: Date.now(),
      messageCount: 0,
      workDir: opts.workdir,
      stdoutBuffer: "",
      responseResolve: null,
      responseText: "",
      readerActive: false,
      onDelta: null,
      onToolUse: null,
      onToolComplete: null,
      lastToolName: null,
      lastToolStartTime: null,
    };
  }

  async spawn(opts: SpawnOpts): Promise<void> {
    if (this.state.proc && this.state.proc.exitCode === null) return;

    // Adopt updated opts (workdir/model could have changed between spawns).
    this.state.workDir = opts.workdir;
    this.model = opts.model;
    if (opts.previousSessionId && !this.state.sessionId) {
      this.state.sessionId = opts.previousSessionId;
    }

    const args: string[] = [
      "claude",
      "--print",
      "--verbose",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--include-partial-messages",
      "--permission-mode", "bypassPermissions",
      "--model", this.model,
    ];
    this.logger.info(`[pipe:${this.key}] Using model: ${this.model}`);

    const mcpConfig = join(process.env.HOME || homedir(), ".claude", "mcp_servers.json");
    if (existsSync(mcpConfig)) {
      args.push("--mcp-config", mcpConfig);
    }

    const previousSessionId = this.state.sessionId;
    if (previousSessionId) {
      args.push("--resume", previousSessionId);
      this.logger.info(`[pipe:${this.key}] Resuming session ${previousSessionId}`);
    }

    this.logger.info(`[pipe:${this.key}] Spawning Claude Code in ${this.state.workDir}`);

    const proc = Bun.spawn(args, {
      cwd: this.state.workDir,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    this.state.proc = proc;
    this.spawnedAt = Date.now();

    // Discard stderr (or pipe to log if you want — we keep it minimal here)
    this.drainStderr(proc);

    // Reset reader state (proc is fresh)
    this.state.stdoutBuffer = "";
    this.state.readerActive = false;

    this.startStdoutReader();
  }

  async sendMessage(content: ContentBlock[], callbacks?: BackendCallbacks): Promise<string> {
    if (!this.state.proc || this.state.proc.exitCode !== null) {
      // Caller (SessionManager) is expected to call spawn() first if needed,
      // but be defensive: re-spawn with current opts.
      await this.spawn({
        workdir: this.state.workDir,
        model: this.model,
        previousSessionId: this.state.sessionId ?? undefined,
        logger: this.logger,
      });
    }

    this.state.lastActivity = Date.now();
    this.state.messageCount++;

    return this.writeAndWait(content, callbacks);
  }

  isAlive(): boolean {
    return this.state.proc !== null && this.state.proc.exitCode === null;
  }

  inflightCount(): number {
    return this.state.responseResolve !== null ? 1 : 0;
  }

  hasInflightResponses(): boolean {
    return this.state.responseResolve !== null;
  }

  getSessionId(): string | null {
    return this.state.sessionId;
  }

  touch(): void {
    this.state.lastActivity = Date.now();
  }

  getLastActivity(): number {
    return this.state.lastActivity;
  }

  getMessageCount(): number {
    return this.state.messageCount;
  }

  async kill(): Promise<void> {
    if (this.state.proc?.exitCode === null) {
      try { this.state.proc.kill(); } catch { /* already dead */ }
    }
    if (this.state.responseResolve) {
      this.state.responseResolve(this.state.responseText || "(session killed)");
      this.state.responseResolve = null;
    }
    this.state.proc = null;
  }

  // ── Internal: stream-json reader ──

  private async startStdoutReader(): Promise<void> {
    const proc = this.state.proc;
    if (!proc?.stdout || typeof proc.stdout === "number") return;
    if (this.state.readerActive) return;
    this.state.readerActive = true;

    const stdout = proc.stdout as ReadableStream<Uint8Array>;
    const reader = stdout.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        this.state.stdoutBuffer += decoder.decode(value, { stream: true });

        const lines = this.state.stdoutBuffer.split("\n");
        this.state.stdoutBuffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const event = JSON.parse(trimmed) as ClaudeStreamEvent;
            this.handleEvent(event);
          } catch {
            this.logger.debug(`[pipe:${this.key}] Non-JSON: ${trimmed.slice(0, 120)}`);
          }
        }
      }
    } catch (err) {
      this.logger.warn(`[pipe:${this.key}] Stdout reader error: ${err}`);
    } finally {
      this.state.readerActive = false;
      reader.releaseLock();
      this.logger.info(`[pipe:${this.key}] Stdout reader ended`);
      if (this.state.responseResolve) {
        this.state.responseResolve(this.state.responseText || "(session ended)");
        this.state.responseResolve = null;
        this.state.responseText = "";
      }
    }
  }

  private handleEvent(event: ClaudeStreamEvent): void {
    if (event.session_id) {
      this.state.sessionId = event.session_id;
      saveSessionMeta(this.key, { sessionId: this.state.sessionId });
    }

    if (event.type === "content_block_delta" && event.delta?.text) {
      this.fireToolComplete();
      this.state.responseText += event.delta.text;
      if (this.state.onDelta) {
        this.state.onDelta(this.state.responseText);
      }
    }

    if (event.type === "assistant" && event.message?.content) {
      this.fireToolComplete();
      let fullText = "";
      for (const block of event.message.content) {
        if (block.type === "text" && block.text) fullText += block.text;
        if (block.type === "tool_use" && block.name && this.state.onToolUse) {
          const desc = describeToolInvocation(block.name, block.input as Record<string, unknown> | undefined);
          this.state.onToolUse(block.name, desc);
          this.state.lastToolName = block.name;
          this.state.lastToolStartTime = Date.now();
        }
      }
      if (fullText) {
        this.state.responseText = fullText;
      }
    }

    if (event.type === "result") {
      this.fireToolComplete();
      if (this.state.responseResolve) {
        const text = this.state.responseText || event.result || "(no response)";
        this.logger.info(`[pipe:${this.key}] Response ready (${text.length} chars)`);
        this.state.responseResolve(text);
        this.state.responseResolve = null;
        this.state.responseText = "";
        this.state.onDelta = null;
        this.state.onToolUse = null;
        this.state.onToolComplete = null;
        this.state.lastToolName = null;
        this.state.lastToolStartTime = null;
      }
    }
  }

  private fireToolComplete(): void {
    if (this.state.lastToolName && this.state.lastToolStartTime && this.state.onToolComplete) {
      const durationMs = Date.now() - this.state.lastToolStartTime;
      this.state.onToolComplete(this.state.lastToolName, durationMs);
    }
    this.state.lastToolName = null;
    this.state.lastToolStartTime = null;
  }

  private writeAndWait(content: ContentBlock[], callbacks?: BackendCallbacks): Promise<string> {
    const proc = this.state.proc;
    if (!proc?.stdin || typeof proc.stdin === "number") {
      return Promise.resolve("(session has no stdin)");
    }

    this.state.responseText = "";
    this.state.lastToolName = null;
    this.state.lastToolStartTime = null;

    const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
    const TOTAL_TIMEOUT_MS = 30 * 60 * 1000;
    let lastActivity = Date.now();
    const startedAt = Date.now();
    const bump = () => { lastActivity = Date.now(); };

    const onDelta = callbacks?.onDelta;
    const onToolUse = callbacks?.onToolUse;
    const onToolComplete = callbacks?.onToolComplete;
    this.state.onDelta = onDelta ? (text: string) => { bump(); onDelta(text); } : (() => bump());
    this.state.onToolUse = onToolUse
      ? (name: string, desc: string) => { bump(); onToolUse(name, desc); }
      : (() => bump());
    this.state.onToolComplete = onToolComplete
      ? (name: string, ms: number) => { bump(); onToolComplete(name, ms); }
      : (() => bump());

    const input = JSON.stringify({
      type: "user",
      message: { role: "user", content },
    }) + "\n";

    const stdin = proc.stdin as import("bun").FileSink;
    stdin.write(input);
    stdin.flush();

    return new Promise<string>((resolve) => {
      this.state.responseResolve = resolve;

      const checkInterval = setInterval(() => {
        if (this.state.responseResolve !== resolve) {
          clearInterval(checkInterval);
          return;
        }
        const idle = Date.now() - lastActivity;
        const total = Date.now() - startedAt;
        if (idle > IDLE_TIMEOUT_MS || total > TOTAL_TIMEOUT_MS) {
          const reason = idle > IDLE_TIMEOUT_MS
            ? `idle ${Math.round(idle / 1000)}s`
            : `total ${Math.round(total / 60_000)}min`;
          this.logger.warn(`[pipe:${this.key}] Response timeout (${reason})`);
          clearInterval(checkInterval);
          this.state.responseResolve = null;
          const partial = this.state.responseText;
          this.state.responseText = "";
          this.state.onDelta = null;
          this.state.onToolUse = null;
          this.state.onToolComplete = null;
          this.state.lastToolName = null;
          this.state.lastToolStartTime = null;
          resolve(partial || "(response timed out — no partial text available)");
        }
      }, 30_000);
    });
  }

  private async drainStderr(proc: ReturnType<typeof Bun.spawn>): Promise<void> {
    if (!proc.stderr || typeof proc.stderr === "number") return;
    const stderr = proc.stderr as ReadableStream<Uint8Array>;
    const reader = stderr.getReader();
    try {
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    } catch {
      // Process died — fine
    } finally {
      reader.releaseLock();
    }
  }
}

/** Render a tool invocation as a short human description for progress UI. */
export function describeToolInvocation(name: string, input?: Record<string, unknown>): string {
  switch (name) {
    case "Bash":
      return (input?.description as string) || (input?.command as string)?.slice(0, 80) || "Running command";
    case "Read":
      return (input?.file_path as string)?.split("/").slice(-2).join("/") || "Reading file";
    case "Edit":
      return (input?.file_path as string)?.split("/").slice(-2).join("/") || "Editing file";
    case "Write":
      return (input?.file_path as string)?.split("/").slice(-2).join("/") || "Writing file";
    case "Grep":
      return `"${(input?.pattern as string)?.slice(0, 40) || "..."}"`;
    case "Glob":
      return (input?.pattern as string) || "Searching files";
    case "WebSearch":
      return (input?.query as string)?.slice(0, 60) || "Searching web";
    case "WebFetch":
      return (input?.url as string)?.slice(0, 60) || "Fetching URL";
    case "Agent":
    case "Task":
      return (input?.description as string) || "Running sub-agent";
    default:
      return name;
  }
}

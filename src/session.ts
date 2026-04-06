// ── Session manager: Claude Code process lifecycle ──

import { join } from "path";
import { mkdirSync, existsSync } from "fs";
import { getConfigDir, loadConfig } from "./config";
import {
  ensureSessionDir,
  loadSessionMeta,
  saveSessionMeta,
} from "./memory";
import { Logger } from "./utils";
import type { ClaudeStreamEvent, ContentBlock, OrchestratorConfig, SessionInfo } from "./types";

const LOGS_DIR = join(getConfigDir(), "logs", "sessions");

// Callback fired on each streaming delta
export type OnDeltaCallback = (accumulatedText: string) => void;

// Extended session info with stdout reader state
interface LiveSession extends SessionInfo {
  stdoutBuffer: string;
  responseResolve: ((text: string) => void) | null;
  responseText: string;
  readerActive: boolean;
  onDelta: OnDeltaCallback | null;
}

export class SessionManager {
  private sessions = new Map<string, LiveSession>();
  private config: OrchestratorConfig;
  private logger: Logger;
  private idleCheckInterval: ReturnType<typeof setInterval> | null = null;

  constructor(config: OrchestratorConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
    mkdirSync(LOGS_DIR, { recursive: true });
  }

  startIdleChecker(): void {
    this.idleCheckInterval = setInterval(() => {
      this.evictIdleSessions();
    }, 60_000);
  }

  stopIdleChecker(): void {
    if (this.idleCheckInterval) {
      clearInterval(this.idleCheckInterval);
      this.idleCheckInterval = null;
    }
  }

  /**
   * Send a message to a Claude session. Creates the session if needed.
   * Returns the assistant's full text response.
   * If onDelta is provided, it's called with the accumulated text on each streaming chunk.
   */
  async sendMessage(sessionKey: string, content: ContentBlock[], onDelta?: OnDeltaCallback): Promise<string> {
    let session = this.sessions.get(sessionKey);

    if (!session || !session.proc || session.proc.exitCode !== null) {
      session = await this.spawnSession(sessionKey);
    }

    session.lastActivity = Date.now();
    session.messageCount++;

    return this.writeAndWait(session, content, onDelta);
  }

  /**
   * Spawn a new Claude Code process for the given session key.
   */
  private async spawnSession(sessionKey: string): Promise<LiveSession> {
    // Evict if at capacity
    if (this.sessions.size >= this.config.maxSessions) {
      this.evictLRU();
    }

    const workDir = ensureSessionDir(sessionKey);
    const meta = loadSessionMeta(sessionKey);
    const previousSessionId = meta?.sessionId as string | undefined;
    const sessionLogPath = join(LOGS_DIR, `${sessionKey.replace(/[^a-zA-Z0-9_-]/g, "_")}.log`);

    const args: string[] = [
      "claude",
      "--print",
      "--verbose",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--include-partial-messages",
      "--permission-mode", "bypassPermissions",
      "--model", this.config.defaultModel,
    ];

    // Pass MCP config so sessions get olog and other MCP tools
    const mcpConfig = join(process.env.HOME || "/Users/oraion", ".claude", "mcp_servers.json");
    if (existsSync(mcpConfig)) {
      args.push("--mcp-config", mcpConfig);
    }

    if (previousSessionId) {
      args.push("--resume", previousSessionId);
      this.logger.info(`[session:${sessionKey}] Resuming session ${previousSessionId}`);
    }

    this.logger.info(`[session:${sessionKey}] Spawning Claude Code in ${workDir}`);

    const proc = Bun.spawn(args, {
      cwd: workDir,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    // Pipe stderr to log file
    this.pipeStderr(proc, sessionKey, sessionLogPath);

    const session: LiveSession = {
      key: sessionKey,
      proc,
      sessionId: previousSessionId ?? null,
      lastActivity: Date.now(),
      messageCount: 0,
      workDir,
      stdoutBuffer: "",
      responseResolve: null,
      responseText: "",
      readerActive: false,
      onDelta: null,
    };

    this.sessions.set(sessionKey, session);

    // Start persistent stdout reader
    this.startStdoutReader(session);

    return session;
  }

  /**
   * Start a background reader that continuously reads stdout and dispatches
   * parsed events. This reader lives for the lifetime of the process.
   */
  private async startStdoutReader(session: LiveSession): Promise<void> {
    const proc = session.proc;
    if (!proc?.stdout || typeof proc.stdout === "number") return;
    if (session.readerActive) return;

    session.readerActive = true;
    const stdout = proc.stdout as ReadableStream<Uint8Array>;
    const reader = stdout.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        session.stdoutBuffer += decoder.decode(value, { stream: true });

        // Process complete lines
        const lines = session.stdoutBuffer.split("\n");
        session.stdoutBuffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          try {
            const event = JSON.parse(trimmed) as ClaudeStreamEvent;
            this.handleEvent(session, event);
          } catch {
            this.logger.debug(`[session:${session.key}] Non-JSON: ${trimmed.slice(0, 120)}`);
          }
        }
      }
    } catch (err) {
      this.logger.warn(`[session:${session.key}] Stdout reader error: ${err}`);
    } finally {
      session.readerActive = false;
      reader.releaseLock();
      this.logger.info(`[session:${session.key}] Stdout reader ended`);

      // If there's a pending response, resolve it with what we have
      if (session.responseResolve) {
        session.responseResolve(session.responseText || "(session ended)");
        session.responseResolve = null;
        session.responseText = "";
      }
    }
  }

  /**
   * Handle a single parsed event from Claude's stream-json output.
   */
  private handleEvent(session: LiveSession, event: ClaudeStreamEvent): void {
    // Capture session_id (it's top-level on result and assistant events)
    if (event.session_id) {
      session.sessionId = event.session_id;
      saveSessionMeta(session.key, { sessionId: session.sessionId });
    }

    // Accumulate assistant text from message events
    if (event.type === "assistant" && event.message?.content) {
      for (const block of event.message.content) {
        if (block.type === "text" && block.text) {
          session.responseText += block.text;
        }
      }
      if (session.responseText && session.onDelta) {
        session.onDelta(session.responseText);
      }
    }

    // Content block deltas (streaming text)
    if (event.type === "content_block_delta" && event.delta?.text) {
      session.responseText += event.delta.text;
      if (session.onDelta) {
        session.onDelta(session.responseText);
      }
    }

    // Result = turn complete. Resolve the pending promise.
    if (event.type === "result") {
      if (session.responseResolve) {
        // Prefer accumulated text from assistant events, fall back to result field
        const text = session.responseText || event.result || "(no response)";
        this.logger.info(`[session:${session.key}] Response ready (${text.length} chars)`);
        session.responseResolve(text);
        session.responseResolve = null;
        session.responseText = "";
        session.onDelta = null;
      }
    }
  }

  /**
   * Write a user message to stdin and wait for the response via the background reader.
   */
  private writeAndWait(session: LiveSession, content: ContentBlock[], onDelta?: OnDeltaCallback): Promise<string> {
    const proc = session.proc;
    if (!proc?.stdin || typeof proc.stdin === "number") {
      return Promise.resolve("(session has no stdin)");
    }

    // Reset response accumulator and set delta callback
    session.responseText = "";
    session.onDelta = onDelta ?? null;

    // Build stream-json input (requires message wrapper with role)
    const input = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content,
      },
    }) + "\n";

    // Write to stdin
    const stdin = proc.stdin as import("bun").FileSink;
    stdin.write(input);
    stdin.flush();

    // Return a promise that resolves when the background reader sees a "result" event
    return new Promise<string>((resolve) => {
      session.responseResolve = resolve;

      // Safety timeout: 5 minutes
      setTimeout(() => {
        if (session.responseResolve === resolve) {
          this.logger.warn(`[session:${session.key}] Response timeout (5min)`);
          session.responseResolve = null;
          resolve(session.responseText || "(response timed out)");
          session.responseText = "";
        }
      }, 300_000);
    });
  }

  /**
   * Pipe stderr to a log file in the background.
   */
  private async pipeStderr(
    proc: ReturnType<typeof Bun.spawn>,
    sessionKey: string,
    logPath: string
  ): Promise<void> {
    if (!proc.stderr || typeof proc.stderr === "number") return;

    const file = Bun.file(logPath);
    const writer = file.writer();
    const stderr = proc.stderr as ReadableStream<Uint8Array>;
    const reader = stderr.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        writer.write(text);
        writer.flush();
      }
    } catch {
      // Process died
    } finally {
      reader.releaseLock();
      writer.end();
    }
  }

  private evictIdleSessions(): void {
    const timeoutMs = this.config.idleTimeoutMinutes * 60 * 1000;
    const now = Date.now();
    for (const [key, session] of this.sessions) {
      if (now - session.lastActivity > timeoutMs) {
        this.logger.info(`[session:${key}] Evicting idle session`);
        this.killSession(key);
      }
    }
  }

  private evictLRU(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    for (const [key, session] of this.sessions) {
      if (session.lastActivity < oldestTime) {
        oldestTime = session.lastActivity;
        oldestKey = key;
      }
    }
    if (oldestKey) {
      this.logger.info(`[session:${oldestKey}] LRU eviction`);
      this.killSession(oldestKey);
    }
  }

  killSession(key: string): void {
    const session = this.sessions.get(key);
    if (!session) return;
    if (session.proc?.exitCode === null) {
      try { session.proc.kill(); } catch {}
    }
    // Resolve any pending response
    if (session.responseResolve) {
      session.responseResolve(session.responseText || "(session killed)");
      session.responseResolve = null;
    }
    this.sessions.delete(key);
    this.logger.info(`[session:${key}] Killed`);
  }

  async killAll(): Promise<void> {
    this.stopIdleChecker();
    const keys = [...this.sessions.keys()];
    for (const key of keys) {
      this.killSession(key);
    }
    this.logger.info(`Killed all ${keys.length} sessions`);
  }

  getStatus(): Array<{
    key: string;
    alive: boolean;
    sessionId: string | null;
    lastActivity: string;
    messageCount: number;
    idleMinutes: number;
  }> {
    const now = Date.now();
    return [...this.sessions.entries()].map(([key, s]) => ({
      key,
      alive: s.proc !== null && s.proc.exitCode === null,
      sessionId: s.sessionId,
      lastActivity: new Date(s.lastActivity).toISOString(),
      messageCount: s.messageCount,
      idleMinutes: Math.round((now - s.lastActivity) / 60000),
    }));
  }

  get size(): number {
    return this.sessions.size;
  }
}

// ── Session manager: per-session backend lifecycle ──
//
// SessionManager is a thin orchestration layer. It owns one SessionBackend per
// session key and delegates all the actual driving (spawn, send, kill) to that
// backend. The backend choice (PipeBackend vs TmuxBackend) is per-session and
// comes from the user-config layer.
//
// History: this file used to contain the entire pipe-backend implementation
// inline (stream-json reader, stdin writer, event dispatch, etc.). All of that
// moved to src/backends/pipe.ts as part of introducing the SessionBackend
// abstraction. The TmuxBackend (src/backends/tmux.ts) is the new alternative
// that drives interactive `claude` (no -p) inside a detached tmux session — a
// hedge against `--print` being deprecated.

import { join } from "path";
import { mkdirSync } from "fs";
import { getConfigDir } from "./config";
import { ensureSessionDir, loadSessionMeta } from "./memory";
import { Logger } from "./utils";
import type { ContentBlock, OrchestratorConfig } from "./types";
import type {
  SessionBackend,
  OnDeltaCallback,
  OnToolUseCallback,
  OnToolCompleteCallback,
  OnUnsolicitedResponseCallback,
} from "./backends/types";
import { PipeBackend } from "./backends/pipe";
import { TmuxBackend } from "./backends/tmux";
import { getSessionBackend } from "./user-config";

const LOGS_DIR = join(getConfigDir(), "logs", "sessions");

export type { OnDeltaCallback, OnToolUseCallback, OnToolCompleteCallback, OnUnsolicitedResponseCallback };

/**
 * Callback the bot registers with SessionManager to receive assistant
 * responses that weren't initiated by a sendMessage call (e.g. the main
 * Claude session replying to a sub-agent's task-notification). The
 * SessionManager wires each backend's unsolicited stream to this handler
 * automatically on spawn.
 */
export type SessionUnsolicitedHandler = (sessionKey: string, text: string) => void | Promise<void>;

export class SessionManager {
  private sessions = new Map<string, SessionBackend>();
  private sessionModelOverrides = new Map<string, string>();
  private config: OrchestratorConfig;
  private logger: Logger;
  private idleCheckInterval: ReturnType<typeof setInterval> | null = null;
  // Set by the bot via setUnsolicitedHandler(). Receives any assistant text
  // that arrives without a corresponding sendMessage() — see TmuxBackend.
  private unsolicitedHandler: SessionUnsolicitedHandler | null = null;

  constructor(config: OrchestratorConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
    mkdirSync(LOGS_DIR, { recursive: true });
  }

  /**
   * Register a handler that receives unsolicited assistant responses from any
   * backend. Replaces any previously-registered handler and is applied to all
   * currently-live backends as well as future spawns.
   */
  setUnsolicitedHandler(handler: SessionUnsolicitedHandler | null): void {
    this.unsolicitedHandler = handler;
    for (const [key, backend] of this.sessions) {
      backend.setUnsolicitedResponseHandler(
        handler ? (text: string) => handler(key, text) : null
      );
    }
  }

  /**
   * Set a model override for a session. Takes effect on next spawn.
   */
  setSessionModel(sessionKey: string, model: string): void {
    this.sessionModelOverrides.set(sessionKey, model);
    this.logger.info(`[session:${sessionKey}] Model override set to ${model}`);
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
   */
  async sendMessage(
    sessionKey: string,
    content: ContentBlock[],
    onDelta?: OnDeltaCallback,
    onToolUse?: OnToolUseCallback,
    onToolComplete?: OnToolCompleteCallback,
  ): Promise<string> {
    let backend = this.sessions.get(sessionKey);

    if (!backend || !backend.isAlive()) {
      backend = await this.spawnBackend(sessionKey);
    }

    backend.touch();
    return backend.sendMessage(content, { onDelta, onToolUse, onToolComplete });
  }

  /**
   * Spawn a backend (pipe or tmux) for the given session key, choosing based
   * on per-user config.
   */
  private async spawnBackend(sessionKey: string): Promise<SessionBackend> {
    if (this.sessions.size >= this.config.maxSessions) {
      this.evictLRU();
    }

    const workDir = ensureSessionDir(sessionKey);
    const meta = loadSessionMeta(sessionKey);
    const previousSessionId = meta?.sessionId as string | undefined;
    const model = this.sessionModelOverrides.get(sessionKey) ?? this.config.defaultModel;
    const backendKind = getSessionBackend(sessionKey);

    this.logger.info(`[session:${sessionKey}] Spawning ${backendKind} backend (model=${model}, workdir=${workDir})`);

    let backend: SessionBackend;
    if (backendKind === "tmux") {
      backend = new TmuxBackend(sessionKey, {
        workdir: workDir,
        model,
        previousSessionId,
        logger: this.logger,
      });
    } else {
      backend = new PipeBackend(sessionKey, {
        workdir: workDir,
        model,
        previousSessionId,
        logger: this.logger,
      });
    }

    await backend.spawn({
      workdir: workDir,
      model,
      previousSessionId,
      logger: this.logger,
    });

    // Wire the unsolicited-response handler BEFORE storing the backend, so a
    // Stop event that fires moments after spawn (e.g. a leftover task-
    // notification reply) is delivered rather than dropped.
    if (this.unsolicitedHandler) {
      const handler = this.unsolicitedHandler;
      backend.setUnsolicitedResponseHandler((text: string) => handler(sessionKey, text));
    }

    this.sessions.set(sessionKey, backend);
    return backend;
  }

  private evictIdleSessions(): void {
    const timeoutMs = this.config.idleTimeoutMinutes * 60 * 1000;
    const now = Date.now();
    for (const [key, backend] of this.sessions) {
      if (now - backend.getLastActivity() > timeoutMs) {
        this.logger.info(`[session:${key}] Evicting idle session`);
        this.killSession(key);
      }
    }
  }

  private evictLRU(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    for (const [key, backend] of this.sessions) {
      const t = backend.getLastActivity();
      if (t < oldestTime) {
        oldestTime = t;
        oldestKey = key;
      }
    }
    if (oldestKey) {
      this.logger.info(`[session:${oldestKey}] LRU eviction`);
      this.killSession(oldestKey);
    }
  }

  killSession(key: string): void {
    const backend = this.sessions.get(key);
    if (!backend) return;
    backend.kill().catch((err) => {
      this.logger.warn(`[session:${key}] kill error: ${err}`);
    });
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

  /**
   * True iff any live session has a Claude response in flight.
   * Used by the SIGTERM shutdown handler to drain pending responses.
   */
  hasInflightResponses(): boolean {
    for (const backend of this.sessions.values()) {
      if (backend.hasInflightResponses()) return true;
    }
    return false;
  }

  inflightCount(): number {
    let n = 0;
    for (const backend of this.sessions.values()) {
      n += backend.inflightCount();
    }
    return n;
  }

  getStatus(): Array<{
    key: string;
    alive: boolean;
    sessionId: string | null;
    lastActivity: string;
    messageCount: number;
    idleMinutes: number;
    backend: "pipe" | "tmux";
  }> {
    const now = Date.now();
    return [...this.sessions.entries()].map(([key, backend]) => ({
      key,
      alive: backend.isAlive(),
      sessionId: backend.getSessionId(),
      lastActivity: new Date(backend.getLastActivity()).toISOString(),
      messageCount: backend.getMessageCount(),
      idleMinutes: Math.round((now - backend.getLastActivity()) / 60000),
      backend: backend.kind,
    }));
  }

  get size(): number {
    return this.sessions.size;
  }
}

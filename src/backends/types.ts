// ── Session backend abstraction ──
//
// A SessionBackend is the thing that drives a Claude Code conversation for a
// single chat (DM or group topic). Two impls:
//   - PipeBackend: spawn `claude --print --input-format stream-json …` and pipe
//     stream-json over stdin/stdout. Battle-tested, currently default.
//   - TmuxBackend: spawn interactive `claude` (no -p) inside a detached tmux
//     session, drive it via `tmux send-keys`, observe via hook events written
//     to a JSONL file and assistant messages tailed from the transcript JSONL.
//     Hedges against -p getting deprecated.
//
// SessionManager picks per-session based on user config.

import type { ContentBlock } from "../types";
import type { Logger } from "../utils";

// ── Callbacks the bot wires up to render streaming UI in Telegram ──

/** Fired on each accumulated text update (full text-so-far, not delta). */
export type OnDeltaCallback = (accumulatedText: string) => void;

/** Fired when Claude starts a tool call. */
export type OnToolUseCallback = (toolName: string, description: string) => void;

/** Fired when a tool finishes (durationMs measured from PreToolUse → PostToolUse). */
export type OnToolCompleteCallback = (toolName: string, durationMs: number) => void;

export interface BackendCallbacks {
  onDelta?: OnDeltaCallback;
  onToolUse?: OnToolUseCallback;
  onToolComplete?: OnToolCompleteCallback;
}

export interface SpawnOpts {
  workdir: string;
  model: string;
  /** If set, resume from this Claude session ID (UUID). */
  previousSessionId?: string;
  logger: Logger;
}

/**
 * SessionBackend: a single live Claude Code conversation. The backend owns the
 * underlying process (or tmux session) and exposes a uniform message/lifecycle
 * API to the SessionManager.
 *
 * Lifecycle:
 *   1. spawn() — start the underlying process; idempotent if already alive.
 *   2. sendMessage() — submit user content, wait for the assistant turn,
 *      return the full response text. Streams progress via callbacks.
 *   3. kill() — tear down.
 *
 * Health checks: isAlive(), inflightCount(), hasInflightResponses().
 */
export interface SessionBackend {
  /** Stable session key (e.g. "dm-717932407"). */
  readonly key: string;

  /** Backend kind for diagnostics / logging. */
  readonly kind: "pipe" | "tmux";

  /** Start (or restart) the underlying process. Idempotent. */
  spawn(opts: SpawnOpts): Promise<void>;

  /**
   * Send a user message and wait for the assistant's full turn.
   * Returns the assistant text (may be empty if the turn ran tools but produced
   * no narration — callers should treat empty as "nothing to deliver").
   */
  sendMessage(content: ContentBlock[], callbacks?: BackendCallbacks): Promise<string>;

  /** True iff the underlying process is still running. */
  isAlive(): boolean;

  /** Count of in-flight sendMessage() calls (i.e. awaiting Claude response). */
  inflightCount(): number;

  /** True iff inflightCount() > 0. Convenience wrapper. */
  hasInflightResponses(): boolean;

  /** The underlying Claude session UUID (set after first response, used for resume). */
  getSessionId(): string | null;

  /** Update last-activity timestamp (used by SessionManager for idle eviction). */
  touch(): void;
  getLastActivity(): number;
  getMessageCount(): number;

  /** Kill the underlying process / tmux session. Resolves any pending response. */
  kill(): Promise<void>;
}

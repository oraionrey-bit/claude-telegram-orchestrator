// ── Per-user / per-session configuration ──
//
// Stored in <config-dir>/user-configs.json. Two scopes share the file:
//   - User scope (keyed by Telegram user ID): completionOnly mode
//   - Session scope (keyed by sessionKey, e.g. "dm-717932407"): backend choice
//
// Backend per session: "pipe" (default, --print stdio) or "tmux" (interactive
// claude inside a detached tmux session, hooks-based event channel). Adopting
// the tmux backend per-session lets us validate it on a single live session
// (Anthony's DM) without disturbing anyone else.

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { getConfigDir } from "./config";

const USER_CONFIGS_PATH = join(getConfigDir(), "user-configs.json");

export type BackendKind = "pipe" | "tmux";

export interface UserConfig {
  /** If true, suppress all streaming/typing/progress — only send final response */
  completionOnly: boolean;
}

export interface SessionConfig {
  /** Which session backend to use. Defaults to "pipe". */
  backend: BackendKind;
}

const DEFAULT_USER_CONFIG: UserConfig = {
  completionOnly: false,
};

const DEFAULT_SESSION_CONFIG: SessionConfig = {
  backend: "pipe",
};

// On-disk schema: a single object that contains BOTH user-keyed and
// session-keyed entries. Older versions had only user-keyed entries directly
// at the top level (e.g. {"5052308275": {"completionOnly": true}}); we keep
// reading those and migrate transparently to the new layout on next write.
//
//   {
//     "users":    { "<telegramUserId>": {"completionOnly": bool} },
//     "sessions": { "<sessionKey>": {"backend": "pipe"|"tmux"} }
//   }
interface OnDiskShape {
  users?: Record<string, UserConfig>;
  sessions?: Record<string, SessionConfig>;
}

let userConfigs: Record<string, UserConfig> = {};
let sessionConfigs: Record<string, SessionConfig> = {};

export function loadUserConfigs(): void {
  try {
    if (!existsSync(USER_CONFIGS_PATH)) return;
    const raw = readFileSync(USER_CONFIGS_PATH, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    // Detect new shape vs legacy. Legacy = top-level keys are user IDs and
    // their values look like UserConfig (have "completionOnly").
    if (
      parsed && typeof parsed === "object" &&
      ("users" in parsed || "sessions" in parsed)
    ) {
      const shaped = parsed as OnDiskShape;
      userConfigs = shaped.users ?? {};
      sessionConfigs = shaped.sessions ?? {};
    } else {
      // Legacy: treat all top-level keys as users.
      userConfigs = parsed as Record<string, UserConfig>;
      sessionConfigs = {};
    }
  } catch {
    userConfigs = {};
    sessionConfigs = {};
  }
}

function save(): void {
  try {
    const shape: OnDiskShape = { users: userConfigs, sessions: sessionConfigs };
    writeFileSync(USER_CONFIGS_PATH, JSON.stringify(shape, null, 2), "utf-8");
  } catch {
    // Don't crash on disk errors
  }
}

export function getUserConfig(userId: string): UserConfig {
  return { ...DEFAULT_USER_CONFIG, ...(userConfigs[userId] ?? {}) };
}

export function setUserConfig(userId: string, update: Partial<UserConfig>): UserConfig {
  userConfigs[userId] = { ...DEFAULT_USER_CONFIG, ...(userConfigs[userId] ?? {}), ...update };
  save();
  return userConfigs[userId];
}

/**
 * Get config for a session key. Extracts user ID from DM keys (dm-{userId}).
 * For group sessions, uses the sender's user ID if provided.
 */
export function getUserConfigForSession(sessionKey: string, senderId?: string): UserConfig {
  if (sessionKey.startsWith("dm-")) {
    const userId = sessionKey.slice(3);
    return getUserConfig(userId);
  }
  if (senderId) {
    return getUserConfig(senderId);
  }
  return { ...DEFAULT_USER_CONFIG };
}

// ── Session-scoped config (backend selection) ──

export function getSessionConfig(sessionKey: string): SessionConfig {
  return { ...DEFAULT_SESSION_CONFIG, ...(sessionConfigs[sessionKey] ?? {}) };
}

export function setSessionConfig(sessionKey: string, update: Partial<SessionConfig>): SessionConfig {
  sessionConfigs[sessionKey] = {
    ...DEFAULT_SESSION_CONFIG,
    ...(sessionConfigs[sessionKey] ?? {}),
    ...update,
  };
  save();
  return sessionConfigs[sessionKey];
}

/** Convenience: just the backend kind for a session (with default fallback). */
export function getSessionBackend(sessionKey: string): BackendKind {
  return getSessionConfig(sessionKey).backend;
}

/**
 * Pre-seed a session's backend if it doesn't already have an explicit setting.
 * Used at startup to opt specific sessions (e.g. Anthony's DM) into tmux
 * without overriding any subsequent /backend command the user issued.
 */
export function ensureSessionBackend(sessionKey: string, backend: BackendKind): void {
  if (!sessionConfigs[sessionKey]) {
    sessionConfigs[sessionKey] = { backend };
    save();
  }
}

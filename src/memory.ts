// ── Memory file management ──

import { existsSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, readdirSync } from "fs";
import { join } from "path";
import { getConfigDir } from "./config";
import { sessionKeyToDir } from "./router";

const MEMORY_DIR = join(getConfigDir(), "memory");
const SHARED_DIR = join(MEMORY_DIR, "shared");
const PRIVATE_DIR = join(MEMORY_DIR, "private");
const SESSIONS_DIR = join(MEMORY_DIR, "sessions");

const DEFAULT_SHARED_FILES: Record<string, string> = {
  "user.md": "# User Notes\n\nShared context about the user.\n",
  "lessons.md": "# Lessons Learned\n\nPersistent lessons across sessions.\n",
  "systems.md": "# Systems & Infrastructure\n\nSetup details, credentials references, infrastructure notes.\n",
};

/**
 * Map of private memory files → which session keys or user IDs can access them.
 * A session key matches if:
 *   - It starts with "dm-{userId}"
 *   - It matches a specific group-topic pattern
 */
interface PrivateMemoryRule {
  file: string;
  allowUsers: string[];     // User IDs whose DM sessions can read this
  allowSessions: string[];  // Exact session key patterns (e.g., "group-{chatId}-topic-{topicId}")
}

/**
 * Privacy rules are loaded from the MEMORY_PRIVATE_RULES env var, which is a
 * JSON-encoded array of PrivateMemoryRule objects. Example:
 *
 *   MEMORY_PRIVATE_RULES='[{"file":"alice-notes.md","allowUsers":["12345678"],"allowSessions":["group--100123-topic-5"]}]'
 *
 * If unset or invalid, no private files are exposed (safe default).
 */
function loadPrivateMemoryRules(): PrivateMemoryRule[] {
  const raw = process.env.MEMORY_PRIVATE_RULES;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((r): r is PrivateMemoryRule =>
        r &&
        typeof r === "object" &&
        typeof r.file === "string" &&
        Array.isArray(r.allowUsers) &&
        Array.isArray(r.allowSessions)
      )
      .map((r) => ({
        file: r.file,
        allowUsers: r.allowUsers.map(String),
        allowSessions: r.allowSessions.map(String),
      }));
  } catch {
    return [];
  }
}

const PRIVATE_MEMORY_RULES: PrivateMemoryRule[] = loadPrivateMemoryRules();

/**
 * Initialize the memory directory structure.
 */
export function initMemory(): void {
  mkdirSync(SHARED_DIR, { recursive: true });
  mkdirSync(PRIVATE_DIR, { recursive: true });
  mkdirSync(SESSIONS_DIR, { recursive: true });

  // Create default shared memory files if they don't exist
  for (const [filename, content] of Object.entries(DEFAULT_SHARED_FILES)) {
    const path = join(SHARED_DIR, filename);
    if (!existsSync(path)) {
      writeFileSync(path, content, "utf-8");
    }
  }
}

/**
 * Ensure a session's working directory exists with proper structure.
 * Returns the workdir path.
 */
export function ensureSessionDir(sessionKey: string): string {
  const dirName = sessionKeyToDir(sessionKey);
  const sessionDir = join(SESSIONS_DIR, dirName);
  const workDir = join(sessionDir, "workdir");

  mkdirSync(workDir, { recursive: true });

  // Symlink shared CLAUDE.md into workdir if it exists
  const sharedClaudeMd = join(getConfigDir(), "CLAUDE.md");
  const localClaudeMd = join(workDir, "CLAUDE.md");
  if (existsSync(sharedClaudeMd) && !existsSync(localClaudeMd)) {
    try {
      symlinkSync(sharedClaudeMd, localClaudeMd);
    } catch {
      // If symlink fails (e.g., already exists as file), skip
    }
  }

  return workDir;
}

/**
 * Read shared memory context to inject into session prompts.
 */
export function getSharedContext(): string {
  const parts: string[] = [];

  for (const filename of Object.keys(DEFAULT_SHARED_FILES)) {
    const path = join(SHARED_DIR, filename);
    if (existsSync(path)) {
      try {
        const content = readFileSync(path, "utf-8").trim();
        if (content) {
          parts.push(`--- ${filename} ---\n${content}`);
        }
      } catch {
        // skip unreadable files
      }
    }
  }

  return parts.join("\n\n");
}

/**
 * Get private memory context for a specific session key.
 * Only returns files that the session is authorized to access.
 */
export function getPrivateContext(sessionKey: string): string {
  const parts: string[] = [];

  for (const rule of PRIVATE_MEMORY_RULES) {
    if (!isAuthorized(sessionKey, rule)) continue;

    const path = join(PRIVATE_DIR, rule.file);
    if (existsSync(path)) {
      try {
        const content = readFileSync(path, "utf-8").trim();
        if (content) {
          parts.push(`--- ${rule.file} (private) ---\n${content}`);
        }
      } catch {
        // skip unreadable
      }
    }
  }

  return parts.join("\n\n");
}

/**
 * Check if a session key is authorized to access a private memory file.
 */
function isAuthorized(sessionKey: string, rule: PrivateMemoryRule): boolean {
  // Check direct session key match
  if (rule.allowSessions.includes(sessionKey)) return true;

  // Check user ID match (DM sessions)
  for (const userId of rule.allowUsers) {
    if (sessionKey === `dm-${userId}`) return true;
  }

  return false;
}

/**
 * Get the full context for a session: shared + authorized private.
 */
export function getFullContext(sessionKey: string): string {
  const shared = getSharedContext();
  const priv = getPrivateContext(sessionKey);

  if (priv) {
    return shared + "\n\n" + priv;
  }
  return shared;
}

/**
 * Get the path for a session-specific metadata file.
 */
export function getSessionMetaPath(sessionKey: string): string {
  const dirName = sessionKeyToDir(sessionKey);
  return join(SESSIONS_DIR, dirName, "meta.json");
}

/**
 * Save session metadata (e.g., Claude session_id for resume).
 */
export function saveSessionMeta(
  sessionKey: string,
  meta: Record<string, unknown>
): void {
  const path = getSessionMetaPath(sessionKey);
  const dir = join(SESSIONS_DIR, sessionKeyToDir(sessionKey));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(meta, null, 2), "utf-8");
}

/**
 * Load session metadata.
 */
export function loadSessionMeta(
  sessionKey: string
): Record<string, unknown> | null {
  const path = getSessionMetaPath(sessionKey);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

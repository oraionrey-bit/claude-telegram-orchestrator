// ── Channel message logger ──
// Appends inbound/outbound messages to per-session text files.
// Stored outside the memory directory so they're never auto-loaded into context.

import { appendFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";

const CHANNEL_LOGS_DIR = join(
  process.env.HOME ?? homedir(),
  ".oraion",
  "channel-logs"
);

/**
 * Ensure the channel logs directory exists.
 */
export function initChannelLogs(): void {
  if (!existsSync(CHANNEL_LOGS_DIR)) {
    mkdirSync(CHANNEL_LOGS_DIR, { recursive: true });
  }
}

/**
 * Get the log file path for a session key.
 */
function getLogPath(sessionKey: string): string {
  const safeName = sessionKey.replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(CHANNEL_LOGS_DIR, `${safeName}.txt`);
}

/**
 * Format a timestamp for log entries.
 */
function timestamp(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

/**
 * Log an inbound user message.
 */
export function logInbound(
  sessionKey: string,
  senderName: string,
  text: string
): void {
  const path = getLogPath(sessionKey);
  const line = `[${timestamp()}] ${senderName}: ${text}\n`;
  try {
    appendFileSync(path, line, "utf-8");
  } catch {
    // Don't crash if logging fails
  }
}

/**
 * Log an outbound assistant response.
 */
export function logOutbound(
  sessionKey: string,
  text: string
): void {
  const path = getLogPath(sessionKey);
  const line = `[${timestamp()}] Oraion: ${text}\n`;
  try {
    appendFileSync(path, line, "utf-8");
  } catch {
    // Don't crash if logging fails
  }
}

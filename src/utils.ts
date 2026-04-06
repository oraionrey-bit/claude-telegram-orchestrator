// ── Utility helpers ──

import { appendFileSync, mkdirSync, existsSync } from "fs";
import { dirname } from "path";
import type { LogLevel } from "./types";

const TELEGRAM_MAX_LENGTH = 4096;

/**
 * Chunk a message into pieces that fit Telegram's 4096 char limit.
 * Tries to split on newlines, then spaces, then hard-cuts.
 */
export function chunkMessage(text: string, maxLen = TELEGRAM_MAX_LENGTH): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    let splitAt = remaining.lastIndexOf("\n", maxLen);
    if (splitAt < maxLen * 0.3) {
      splitAt = remaining.lastIndexOf(" ", maxLen);
    }
    if (splitAt < maxLen * 0.3) {
      splitAt = maxLen;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  return chunks;
}

/**
 * Escape special characters for Telegram MarkdownV2.
 */
export function escapeMarkdownV2(text: string): string {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

/**
 * Format a sender name + message for Claude context.
 */
export function formatUserMessage(senderName: string, text: string): string {
  return `[${senderName}]: ${text}`;
}

/**
 * Logger that writes to both stderr and a log file.
 */
export class Logger {
  private logPath: string | null;

  constructor(logPath?: string) {
    this.logPath = logPath ?? null;
    if (this.logPath) {
      const dir = dirname(this.logPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }
  }

  private write(level: LogLevel, msg: string): void {
    const ts = new Date().toISOString();
    const line = `[${ts}] [${level.toUpperCase()}] ${msg}`;
    console.error(line);
    if (this.logPath) {
      try {
        appendFileSync(this.logPath, line + "\n");
      } catch {
        // If we can't write to log, don't crash
      }
    }
  }

  debug(msg: string): void {
    this.write("debug", msg);
  }
  info(msg: string): void {
    this.write("info", msg);
  }
  warn(msg: string): void {
    this.write("warn", msg);
  }
  error(msg: string): void {
    this.write("error", msg);
  }
}

// ── In-flight message tracker for crash recovery ──

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { getConfigDir } from "./config";

const INFLIGHT_PATH = join(getConfigDir(), "inflight.json");

export interface InFlightMessage {
  id: string;
  sessionKey: string;
  chatId: number;
  threadId?: number;
  fallbackChatId?: number;
  fallbackThreadId?: number;
  senderName: string;
  messageText: string;
  completionOnly: boolean;
  timestamp: number;
}

let inflight: InFlightMessage[] = [];

export function loadInflight(): InFlightMessage[] {
  try {
    if (existsSync(INFLIGHT_PATH)) {
      const raw = readFileSync(INFLIGHT_PATH, "utf-8");
      inflight = JSON.parse(raw);
      // Prune anything older than 1 hour
      const cutoff = Date.now() - 60 * 60 * 1000;
      inflight = inflight.filter(m => m.timestamp > cutoff);
      saveInflight();
    }
  } catch {
    inflight = [];
  }
  return inflight;
}

export function markInflight(msg: InFlightMessage): void {
  // One in-flight per session key
  inflight = inflight.filter(m => m.sessionKey !== msg.sessionKey);
  inflight.push(msg);
  saveInflight();
}

export function clearInflight(sessionKey: string): void {
  inflight = inflight.filter(m => m.sessionKey !== sessionKey);
  saveInflight();
}

function saveInflight(): void {
  try {
    writeFileSync(INFLIGHT_PATH, JSON.stringify(inflight, null, 2), "utf-8");
  } catch {
    // best effort
  }
}

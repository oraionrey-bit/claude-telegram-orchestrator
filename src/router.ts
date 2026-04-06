// ── Message routing: chat_id + topic_id → session key ──

import type { Context } from "grammy";

/**
 * Derive a session key from a Telegram message context.
 * 
 * - DM: `dm-{user_id}`
 * - Group without topics: `group-{chat_id}`
 * - Group with topic: `group-{chat_id}-topic-{topic_id}`
 */
export function getSessionKey(ctx: Context): string | null {
  const msg = ctx.message;
  if (!msg) return null;

  const chatId = msg.chat.id;
  const chatType = msg.chat.type;

  if (chatType === "private") {
    return `dm-${msg.from?.id ?? chatId}`;
  }

  // Group or supergroup
  // For forum groups, always use topic routing
  const isForum = "is_forum" in msg.chat ? (msg.chat as unknown as Record<string, unknown>).is_forum : false;
  const threadId = msg.message_thread_id;
  
  if (threadId !== undefined) {
    return `group-${chatId}-topic-${threadId}`;
  }
  
  // Forum group but no thread_id = General topic (thread_id 1 in Telegram's API)
  if (isForum) {
    return `group-${chatId}-topic-1`;
  }

  return `group-${chatId}`;
}

/**
 * Parse a session key back into its components.
 */
export function parseSessionKey(key: string): {
  type: "dm" | "group";
  chatId?: string;
  userId?: string;
  topicId?: string;
} {
  if (key.startsWith("dm-")) {
    return { type: "dm", userId: key.slice(3) };
  }

  const topicMatch = key.match(/^group-(-?\d+)-topic-(\d+)$/);
  if (topicMatch) {
    return { type: "group", chatId: topicMatch[1], topicId: topicMatch[2] };
  }

  const groupMatch = key.match(/^group-(-?\d+)$/);
  if (groupMatch) {
    return { type: "group", chatId: groupMatch[1] };
  }

  return { type: "group" };
}

/**
 * Filesystem-safe version of a session key (replace colons, etc.).
 */
export function sessionKeyToDir(key: string): string {
  return key.replace(/[^a-zA-Z0-9_-]/g, "_");
}

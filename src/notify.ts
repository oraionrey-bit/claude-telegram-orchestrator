// ── Persistent notification queue with retry & fallback ──

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import type { Api } from "grammy";
import { chunkMessage, Logger } from "./utils";
import { getConfigDir } from "./config";

const QUEUE_PATH = join(getConfigDir(), "notify-queue.json");

export interface Notification {
  id: string;
  /** Primary target */
  chatId: number;
  threadId?: number;
  /** Fallback target (e.g., group topic if DM fails) */
  fallbackChatId?: number;
  fallbackThreadId?: number;
  /** The text to send */
  text: string;
  /** Number of attempts so far */
  attempts: number;
  /** Max attempts before giving up */
  maxAttempts: number;
  /** Timestamp of next retry (ms since epoch) */
  nextRetryAt: number;
  /** When this notification was created */
  createdAt: number;
  /** Optional: reply to this message ID */
  replyToMessageId?: number;
  /** Tag for logging/filtering */
  tag?: string;
}

export class NotificationQueue {
  private queue: Notification[] = [];
  private api: Api | null = null;
  private logger: Logger;
  private tickInterval: ReturnType<typeof setInterval> | null = null;
  private processing = false;
  /** Per-chat 429 ban tracking: chatId → ban expiry timestamp */
  private chatBans = new Map<number, number>();

  constructor(logger: Logger) {
    this.logger = logger;
    this.loadQueue();
  }

  /** Set the Grammy API instance (call after bot is created) */
  setApi(api: Api): void {
    this.api = api;
  }

  /** Start the retry tick loop (every 10 seconds) */
  start(): void {
    if (this.tickInterval) return;
    this.tickInterval = setInterval(() => this.processQueue(), 10_000);
    this.logger.info(`[notify] Queue started with ${this.queue.length} pending notifications`);
  }

  /** Stop the retry tick loop */
  stop(): void {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
  }

  /**
   * Enqueue a notification for delivery.
   * Attempts immediate send first; if that fails, queues for retry.
   */
  async send(opts: {
    chatId: number;
    threadId?: number;
    text: string;
    fallbackChatId?: number;
    fallbackThreadId?: number;
    replyToMessageId?: number;
    tag?: string;
    maxAttempts?: number;
  }): Promise<boolean> {
    const tag = opts.tag ?? "none";
    const chars = opts.text.length;
    const chunkCount = chunkMessage(opts.text).length;

    // Check if primary chat is banned
    if (this.isChatBanned(opts.chatId)) {
      // Try fallback immediately if available
      if (opts.fallbackChatId && !this.isChatBanned(opts.fallbackChatId)) {
        const sent = await this.trySend(opts.fallbackChatId, opts.fallbackThreadId, opts.text);
        if (sent) {
          this.logger.info(`[notify] OK via fallback (tag=${tag}, chat=${opts.fallbackChatId}, chars=${chars}, chunks=${chunkCount}) — primary ${opts.chatId} banned`);
          return true;
        }
      }
      // Queue for retry when ban expires
      this.enqueue(opts);
      return false;
    }

    // Try immediate send. First with reply_to; if Telegram rejects (e.g. "message to be replied not found"),
    // retry without reply_to so the user still gets the response.
    const sent = await this.trySend(opts.chatId, opts.threadId, opts.text, opts.replyToMessageId);
    if (sent) {
      this.logger.info(`[notify] OK (tag=${tag}, chat=${opts.chatId}, chars=${chars}, chunks=${chunkCount}, reply=${opts.replyToMessageId ?? "none"})`);
      return true;
    }

    // Retry without reply_to_message_id — Telegram often rejects replies to old/deleted messages,
    // but accepts the same content without the reply hint.
    if (opts.replyToMessageId) {
      const retrySent = await this.trySend(opts.chatId, opts.threadId, opts.text);
      if (retrySent) {
        this.logger.info(`[notify] OK retry-no-reply (tag=${tag}, chat=${opts.chatId}, chars=${chars}, chunks=${chunkCount}) — original reply-to ${opts.replyToMessageId} rejected`);
        return true;
      }
    }

    // Try fallback
    if (opts.fallbackChatId && !this.isChatBanned(opts.fallbackChatId)) {
      const fallbackSent = await this.trySend(opts.fallbackChatId, opts.fallbackThreadId, opts.text);
      if (fallbackSent) {
        this.logger.info(`[notify] OK via fallback (tag=${tag}, chat=${opts.fallbackChatId}, chars=${chars}, chunks=${chunkCount}) — primary failed`);
        return true;
      }
    }

    // Queue for retry
    this.logger.error(`[notify] All immediate attempts FAILED (tag=${tag}, chat=${opts.chatId}, chars=${chars}, chunks=${chunkCount}) — queueing for retry`);
    this.enqueue(opts);
    return false;
  }

  /** How many notifications are pending */
  get pendingCount(): number {
    return this.queue.length;
  }

  // ── Internal ──

  private isChatBanned(chatId: number): boolean {
    const expiry = this.chatBans.get(chatId);
    if (!expiry) return false;
    if (Date.now() > expiry) {
      this.chatBans.delete(chatId);
      return false;
    }
    return true;
  }

  private enqueue(opts: {
    chatId: number;
    threadId?: number;
    text: string;
    fallbackChatId?: number;
    fallbackThreadId?: number;
    replyToMessageId?: number;
    tag?: string;
    maxAttempts?: number;
  }): void {
    // Determine next retry time based on ban expiry
    const banExpiry = this.chatBans.get(opts.chatId);
    const nextRetryAt = banExpiry ? banExpiry + 1000 : Date.now() + 10_000;

    const notification: Notification = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      chatId: opts.chatId,
      threadId: opts.threadId,
      fallbackChatId: opts.fallbackChatId,
      fallbackThreadId: opts.fallbackThreadId,
      text: opts.text,
      attempts: 1,
      maxAttempts: opts.maxAttempts ?? 10,
      nextRetryAt,
      createdAt: Date.now(),
      replyToMessageId: opts.replyToMessageId,
      tag: opts.tag,
    };

    this.queue.push(notification);
    this.saveQueue();
    this.logger.warn(`[notify] Queued ${notification.id} (tag=${opts.tag ?? "none"}), next retry at ${new Date(nextRetryAt).toISOString()}`);
  }

  private async trySend(
    chatId: number,
    threadId: number | undefined,
    text: string,
    replyToMessageId?: number
  ): Promise<boolean> {
    if (!this.api) {
      this.logger.warn("[notify] No API instance set — cannot send");
      return false;
    }

    const chunks = chunkMessage(text);
    for (let i = 0; i < chunks.length; i++) {
      const opts: Record<string, unknown> = {};
      if (threadId !== undefined) opts.message_thread_id = threadId;
      if (i === 0 && replyToMessageId) opts.reply_to_message_id = replyToMessageId;
      try {
        const sent = await this.api.sendMessage(chatId, chunks[i], opts);
        this.logger.debug(`[notify] chunk ${i + 1}/${chunks.length} sent to chat ${chatId} (msg_id=${sent.message_id}, chars=${chunks[i].length})`);
      } catch (err: unknown) {
        // Parse 429 retry_after and track ban
        const errStr = String(err);
        const retryMatch = errStr.match(/retry after (\d+)/i);
        if (retryMatch) {
          const retryAfterSec = parseInt(retryMatch[1]);
          const banExpiry = Date.now() + retryAfterSec * 1000;
          this.chatBans.set(chatId, banExpiry);
          this.logger.warn(`[notify] Chat ${chatId} banned until ${new Date(banExpiry).toISOString()} (${retryAfterSec}s)`);
        }
        this.logger.warn(`[notify] Send failed to chat ${chatId} chunk ${i + 1}/${chunks.length} (chars=${chunks[i].length}, reply=${opts.reply_to_message_id ?? "none"}): ${err}`);
        return false;
      }
      // Pace multi-chunk sends to avoid per-chat rate limits (1 msg/sec/chat).
      if (i < chunks.length - 1) {
        await new Promise((r) => setTimeout(r, 1100));
      }
    }
    return true;
  }

  private async processQueue(): Promise<void> {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;

    const now = Date.now();
    const toRemove: string[] = [];

    for (const notif of this.queue) {
      if (notif.nextRetryAt > now) continue;

      // Skip if chat is still banned
      if (this.isChatBanned(notif.chatId)) {
        // Update retry time to ban expiry
        const banExpiry = this.chatBans.get(notif.chatId);
        if (banExpiry) {
          notif.nextRetryAt = banExpiry + 1000;
        }
        continue;
      }

      notif.attempts++;
      this.logger.info(`[notify] Retrying ${notif.id} (attempt ${notif.attempts}/${notif.maxAttempts}, tag=${notif.tag ?? "none"})`);

      // Try primary target
      let sent = await this.trySend(notif.chatId, notif.threadId, notif.text, notif.replyToMessageId);

      // Try fallback if primary failed
      if (!sent && notif.fallbackChatId && !this.isChatBanned(notif.fallbackChatId)) {
        this.logger.info(`[notify] Primary failed, trying fallback for ${notif.id}`);
        sent = await this.trySend(notif.fallbackChatId, notif.fallbackThreadId, notif.text);
        if (sent) {
          this.logger.info(`[notify] Fallback succeeded for ${notif.id}`);
        }
      }

      if (sent) {
        toRemove.push(notif.id);
        this.logger.info(`[notify] Delivered ${notif.id} on attempt ${notif.attempts}`);
      } else if (notif.attempts >= notif.maxAttempts) {
        toRemove.push(notif.id);
        this.logger.error(`[notify] Gave up on ${notif.id} after ${notif.attempts} attempts. Text: ${notif.text.slice(0, 200)}`);
      } else {
        // If banned, align to ban expiry; otherwise exponential backoff
        const banExpiry = this.chatBans.get(notif.chatId);
        if (banExpiry) {
          notif.nextRetryAt = banExpiry + 1000;
        } else {
          const backoff = 10_000 * Math.pow(2, notif.attempts - 1);
          notif.nextRetryAt = now + Math.min(backoff, 300_000); // cap at 5 min
        }
      }
    }

    if (toRemove.length > 0) {
      this.queue = this.queue.filter(n => !toRemove.includes(n.id));
    }

    this.saveQueue();
    this.processing = false;
  }

  private loadQueue(): void {
    try {
      if (existsSync(QUEUE_PATH)) {
        const raw = readFileSync(QUEUE_PATH, "utf-8");
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          this.queue = parsed;
          // Prune stale notifications (older than 24h)
          const cutoff = Date.now() - 24 * 60 * 60 * 1000;
          const before = this.queue.length;
          this.queue = this.queue.filter(n => n.createdAt > cutoff);
          if (this.queue.length < before) {
            this.logger.info(`[notify] Pruned ${before - this.queue.length} stale notifications`);
            this.saveQueue();
          }
        }
      }
    } catch (err) {
      this.logger.warn(`[notify] Failed to load queue (starting fresh): ${err}`);
      this.queue = [];
    }
  }

  private saveQueue(): void {
    try {
      writeFileSync(QUEUE_PATH, JSON.stringify(this.queue, null, 2), "utf-8");
    } catch (err) {
      this.logger.warn(`[notify] Failed to save queue: ${err}`);
    }
  }
}

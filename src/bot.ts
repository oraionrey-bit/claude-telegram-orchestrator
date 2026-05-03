// ── Grammy bot setup & message handlers ──

import { Bot, GrammyError, type Context } from "grammy";
import type { ContentBlock, OrchestratorConfig, ScheduleJob } from "./types";
import { SessionManager } from "./session";
import { getSessionKey, parseSessionKey } from "./router";
import { chunkMessage, formatUserMessage, Logger } from "./utils";
import { logInbound, logOutbound } from "./channel-log";
import type { Scheduler } from "./scheduler";
import type { NotificationQueue } from "./notify";
import { getUserConfigForSession, setUserConfig } from "./user-config";
import { markInflight, clearInflight } from "./inflight";

// Admin users who can manage schedules
const ADMIN_USERS = [717932407, 5052308275]; // Anthony, Tina

// Module-level scheduler reference, set after bot creation
let _scheduler: Scheduler | null = null;
export function setScheduler(scheduler: Scheduler): void {
  _scheduler = scheduler;
}

// ── Message batching: buffer rapid messages per session ──
interface PendingMessage {
  ctx: Context;
  text: string;
  contentBlocks: ContentBlock[];
  senderName: string;
  threadId?: number;
  msgId: number;
  replyContext?: string;
}

interface SessionBuffer {
  messages: PendingMessage[];
  timer: ReturnType<typeof setTimeout>;
}

const MESSAGE_BATCH_DELAY_MS = 2500;

export function createBot(
  token: string,
  config: OrchestratorConfig,
  sessionManager: SessionManager,
  logger: Logger,
  notifyQueue: NotificationQueue
): Bot {
  const bot = new Bot(token);
  const sessionBuffers = new Map<string, SessionBuffer>();

  // ── Access control middleware ──
  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id?.toString();
    if (!userId) return;

    // Check if user is in allowlist
    if (config.allowedUsers.length > 0 && !config.allowedUsers.includes(userId)) {
      logger.warn(`[bot] Unauthorized user ${userId} (${ctx.from?.username ?? "unknown"})`);
      return;
    }

    await next();
  });

  // ── Group mention filter middleware ──
  bot.use(async (ctx, next) => {
    const msg = ctx.message;
    if (!msg) return await next();

    const chatId = msg.chat.id.toString();
    const chatType = msg.chat.type;

    // DMs always pass through
    if (chatType === "private") {
      return await next();
    }

    // Check group config
    const groupConfig = config.groups[chatId];
    if (!groupConfig?.enabled) {
      // Group not configured — ignore
      return;
    }

    if (groupConfig.requireMention) {
      const text = msg.text ?? msg.caption ?? "";
      const lowerText = text.toLowerCase();
      const mentioned = groupConfig.mentionPatterns.some((pattern) =>
        lowerText.includes(pattern.toLowerCase())
      );

      // Also check for bot mentions via entities
      const entities = msg.entities ?? msg.caption_entities ?? [];
      const botMentioned = entities.some(
        (e) => e.type === "mention" && text.slice(e.offset, e.offset + e.length).toLowerCase().includes("bot")
      );

      if (!mentioned && !botMentioned) {
        return; // Not mentioned, skip
      }
    }

    await next();
  });

  // ── Helper: download image from Telegram and return content block ──
  async function downloadImage(
    ctx: Context,
    msg: Context["message"] & object,
    hasPhoto: boolean
  ): Promise<ContentBlock> {
    const fileId = hasPhoto
      ? msg.photo![msg.photo!.length - 1].file_id
      : msg.document!.file_id;
    const file = await ctx.api.getFile(fileId);
    const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
    const response = await fetch(url);
    const buffer = await response.arrayBuffer();
    const base64 = Buffer.from(buffer).toString("base64");

    const ext = file.file_path?.split(".").pop()?.toLowerCase() ?? "jpg";
    const mediaTypes: Record<string, string> = {
      jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
      gif: "image/gif", webp: "image/webp", bmp: "image/bmp",
    };
    const mediaType = !hasPhoto && msg.document
      ? (msg.document.mime_type ?? "image/jpeg")
      : (mediaTypes[ext] ?? "image/jpeg");

    logger.info(`[bot] Downloaded image (${Math.round(buffer.byteLength / 1024)}KB)`);
    return {
      type: "image",
      source: { type: "base64", media_type: mediaType, data: base64 },
    };
  }

  // ── Completion-only mode: no streaming, no progress — just the final response ──
  async function processBatchCompletionOnly(
    sessionKey: string,
    batch: PendingMessage[],
    chatId: number,
    threadId: number | undefined,
    fallbackChatId: number | undefined,
    fallbackThreadId: number | undefined
  ): Promise<void> {
    // Merge content blocks (same logic as processBatch)
    const allContentBlocks: ContentBlock[] = [];
    for (const pending of batch) {
      for (const block of pending.contentBlocks) {
        if (block.type === "image") {
          allContentBlocks.push(block);
        }
      }
    }

    if (batch.length === 1) {
      const pending = batch[0];
      const msgText = pending.replyContext
        ? `${pending.replyContext}\n${pending.text || "(sent an image)"}`
        : (pending.text || "(sent an image)");
      const formattedMessage = formatUserMessage(pending.senderName, msgText);
      allContentBlocks.push({ type: "text", text: formattedMessage });
      logInbound(sessionKey, pending.senderName, pending.text);
    } else {
      const combinedText = batch
        .map((p) => {
          const txt = p.text || "(sent an image)";
          return p.replyContext ? `${p.replyContext}\n${txt}` : txt;
        })
        .filter(Boolean)
        .join("\n\n");
      const formattedMessage = formatUserMessage(batch[0].senderName, combinedText);
      allContentBlocks.push({ type: "text", text: formattedMessage });
      for (const pending of batch) {
        logInbound(sessionKey, pending.senderName, pending.text);
      }
    }

    try {
      // Send acknowledgment so user knows we're actively working
      await notifyQueue.send({
        chatId,
        threadId,
        text: "Got it, working on this now.",
        replyToMessageId: batch[0].msgId,
        tag: `ack:${sessionKey}`,
      });

      // Track in-flight for crash recovery
      markInflight({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        sessionKey,
        chatId,
        threadId,
        fallbackChatId,
        fallbackThreadId,
        senderName: batch[0].senderName,
        messageText: batch.map(b => b.text).join("\n"),
        completionOnly: true,
        timestamp: Date.now(),
      });

      // No streaming callbacks — just wait for the full response
      const response = await sessionManager.sendMessage(sessionKey, allContentBlocks);
      logOutbound(sessionKey, response);

      if (response?.trim()) {
        await notifyQueue.send({
          chatId,
          threadId,
          text: response,
          fallbackChatId,
          fallbackThreadId,
          replyToMessageId: batch[0].msgId,
          tag: `response:${sessionKey}`,
        });
      }
      clearInflight(sessionKey);
    } catch (err) {
      clearInflight(sessionKey);
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error(`[bot] Error in completion-only processing: ${errorMsg}`);
      await notifyQueue.send({
        chatId,
        threadId,
        text: "Error processing your message. Please try again.",
        fallbackChatId,
        fallbackThreadId,
        replyToMessageId: batch[batch.length - 1].msgId,
        tag: `error:${sessionKey}`,
      });
    }
  }

  // ── Process a batch of buffered messages ──
  async function processBatch(sessionKey: string, batch: PendingMessage[]): Promise<void> {
    // Use the last message's context for replying
    const lastPending = batch[batch.length - 1];
    const ctx = lastPending.ctx;
    const threadId = lastPending.threadId;

    // Determine chat targets for notification queue fallback
    const primaryChatId = ctx.chat!.id;
    const parsed = parseSessionKey(sessionKey);
    // For DM sessions, fallback to group; for group sessions, no fallback
    // Group chat ID is configured in config.groups — use first enabled group
    let fallbackChatId: number | undefined;
    let fallbackThreadId: number | undefined;
    if (parsed.type === "dm") {
      const groupEntries = Object.entries(config.groups);
      for (const [gid, gc] of groupEntries) {
        if (gc.enabled) {
          fallbackChatId = parseInt(gid);
          break;
        }
      }
    }

    // Check completion-only mode
    const senderId = ctx.from?.id?.toString();
    const userConfig = getUserConfigForSession(sessionKey, senderId);
    if (userConfig.completionOnly) {
      await processBatchCompletionOnly(sessionKey, batch, primaryChatId, threadId, fallbackChatId, fallbackThreadId);
      return;
    }

    // Keep typing indicator alive during processing
    const typingInterval = setInterval(async () => {
      try {
        await ctx.replyWithChatAction("typing");
      } catch {
        // ignore
      }
    }, 4000);

    try {
      // Merge all content blocks from all messages in the batch
      const allContentBlocks: ContentBlock[] = [];

      for (const pending of batch) {
        // Add image blocks first
        for (const block of pending.contentBlocks) {
          if (block.type === "image") {
            allContentBlocks.push(block);
          }
        }
      }

      // Combine text from all messages into one formatted block
      if (batch.length === 1) {
        const pending = batch[0];
        const msgText = pending.replyContext
          ? `${pending.replyContext}\n${pending.text || "(sent an image)"}`
          : (pending.text || "(sent an image)");
        const formattedMessage = formatUserMessage(pending.senderName, msgText);
        allContentBlocks.push({ type: "text", text: formattedMessage });
        logInbound(sessionKey, pending.senderName, pending.text);
      } else {
        // Multiple messages — combine with separator
        const combinedText = batch
          .map((p) => {
            const txt = p.text || "(sent an image)";
            return p.replyContext ? `${p.replyContext}\n${txt}` : txt;
          })
          .filter(Boolean)
          .join("\n\n");
        const formattedMessage = formatUserMessage(batch[0].senderName, combinedText);
        allContentBlocks.push({ type: "text", text: formattedMessage });
        for (const pending of batch) {
          logInbound(sessionKey, pending.senderName, pending.text);
        }
        logger.info(`[bot] Batched ${batch.length} messages for session ${sessionKey}`);
      }

      // Streaming: edit current message as text streams in
      const baseOpts: Record<string, unknown> = {};
      if (threadId !== undefined) {
        baseOpts.message_thread_id = threadId;
      }

      let currentMsg: { chat: { id: number }; message_id: number } | null = null;
      let currentMsgText = "";
      let lastEditText = "";
      let lastEditTime = 0;
      const EDIT_INTERVAL_MS = 800;
      let pendingEditTimer: ReturnType<typeof setTimeout> | null = null;
      let previousAccumulated = "";

      const editCurrentMsg = async (text: string) => {
        if (!currentMsg || text === lastEditText) return;
        const display = text.length > 4000 ? text.slice(0, 4000) + "\n\n…" : text;
        try {
          await ctx.api.editMessageText(currentMsg.chat.id, currentMsg.message_id, display);
          lastEditText = text;
          lastEditTime = Date.now();
        } catch (err) {
          logger.warn(`[bot] editMessageText failed for ${sessionKey}: ${err}`);
        }
      };

      const startNewMessage = async (initialText: string) => {
        currentMsgText = initialText;
        lastEditText = "";
        try {
          currentMsg = await ctx.reply(initialText || "…", baseOpts);
          lastEditTime = Date.now();
          lastEditText = initialText;
        } catch (err) {
          logger.warn(`[bot] startNewMessage failed for ${sessionKey}: ${err}`);
          currentMsg = null;
        }
      };

      // Send initial placeholder (reply to first message in batch)
      const firstMsgOpts = { ...baseOpts, reply_to_message_id: batch[0].msgId };
      try {
        currentMsg = await ctx.reply("…", firstMsgOpts);
        lastEditTime = Date.now();
      } catch {
        currentMsg = null;
      }

      let startingNewMsg = false;
      let realTextDelivered = false;
      let queuedDelta = "";

      const processDelta = () => {
        if (!currentMsg || startingNewMsg) return;

        if (queuedDelta) {
          currentMsgText += queuedDelta;
          queuedDelta = "";
        }

        const breakIdx = currentMsgText.indexOf("\n\n");
        if (breakIdx !== -1 && currentMsgText.length > breakIdx + 2) {
          const finalized = currentMsgText.slice(0, breakIdx).trim();
          const remainder = currentMsgText.slice(breakIdx + 2).trim();

          if (finalized) {
            editCurrentMsg(finalized);
          }
          if (remainder) {
            startingNewMsg = true;
            startNewMessage(remainder).finally(() => {
              startingNewMsg = false;
              if (queuedDelta) processDelta();
            });
          } else {
            currentMsgText = "";
          }
          return;
        }

        const now = Date.now();
        if (now - lastEditTime >= EDIT_INTERVAL_MS) {
          editCurrentMsg(currentMsgText);
        } else if (!pendingEditTimer) {
          const delay = EDIT_INTERVAL_MS - (now - lastEditTime);
          pendingEditTimer = setTimeout(() => {
            pendingEditTimer = null;
            editCurrentMsg(currentMsgText);
          }, delay);
        }
      };

      const onDelta = (accumulatedText: string) => {
        const newText = accumulatedText.slice(previousAccumulated.length);
        if (!newText) return;
        previousAccumulated = accumulatedText;
        realTextDelivered = true;
        resetSilenceTimer();

        if (startingNewMsg || !currentMsg) {
          queuedDelta += newText;
          return;
        }

        currentMsgText += newText;
        processDelta();
      };

      // Silence heartbeat: if nothing happens for 15s, show "Still working..."
      // Claude's natural narration ("Let me check X...") streams via onDelta into
      // the main reply, so we don't need per-tool progress messages — they only
      // burn Telegram edit rate limits. The heartbeat covers tool-only stretches
      // where Claude isn't narrating.
      const SILENCE_TIMEOUT_MS = 15000;
      let silenceTimer: ReturnType<typeof setTimeout> | null = null;

      const resetSilenceTimer = () => {
        if (silenceTimer) clearTimeout(silenceTimer);
        silenceTimer = setTimeout(async () => {
          if (!currentMsg) return;
          const heartbeatText = currentMsgText.trim()
            ? `${currentMsgText}\n\n⏳ Still working...`
            : "⏳ Still working...";
          try {
            await ctx.api.editMessageText(currentMsg.chat.id, currentMsg.message_id, heartbeatText.slice(0, 4000));
          } catch { /* ignore */ }
          resetSilenceTimer();
        }, SILENCE_TIMEOUT_MS);
      };

      resetSilenceTimer();

      // Track in-flight for crash recovery
      markInflight({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        sessionKey,
        chatId: primaryChatId,
        threadId,
        fallbackChatId,
        fallbackThreadId,
        senderName: batch[0].senderName,
        messageText: batch.map(b => b.text).join("\n"),
        completionOnly: false,
        timestamp: Date.now(),
      });

      // Pass a no-op onToolUse so the session's idle-timeout watchdog still gets
      // bumped during silent tool bursts — but we deliberately don't render
      // anything, since Claude's text deltas already narrate what's happening.
      const response = await sessionManager.sendMessage(
        sessionKey,
        allContentBlocks,
        onDelta,
        () => {},
        () => {},
      );

      // Clean up silence heartbeat
      if (silenceTimer) clearTimeout(silenceTimer);

      if (pendingEditTimer) {
        clearTimeout(pendingEditTimer);
        pendingEditTimer = null;
      }

      // Log outbound response
      logOutbound(sessionKey, response);

      // Final edit to ensure complete text is shown
      if (currentMsg && currentMsgText.trim()) {
        await editCurrentMsg(currentMsgText.trim());
      }

      // Safety fallback: if streaming didn't deliver real text, send full response via queue
      if (response && response.trim() && !realTextDelivered) {
        logger.warn(`[bot] Streaming delivery failed for ${sessionKey}, sending full response via queue`);
        if (currentMsg) {
          await ctx.api.deleteMessage(currentMsg.chat.id, currentMsg.message_id).catch(() => {});
        }
        await notifyQueue.send({
          chatId: primaryChatId,
          threadId,
          text: response,
          fallbackChatId,
          fallbackThreadId,
          replyToMessageId: batch[0].msgId,
          tag: `fallback:${sessionKey}`,
        });
      }
      clearInflight(sessionKey);
    } catch (err) {
      clearInflight(sessionKey);
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error(`[bot] Error processing message: ${errorMsg}`);
      await notifyQueue.send({
        chatId: primaryChatId,
        threadId,
        text: "Error processing your message. Please try again.",
        fallbackChatId,
        fallbackThreadId,
        replyToMessageId: lastPending.msgId,
        tag: `error:${sessionKey}`,
      });
    } finally {
      clearInterval(typingInterval);
    }
  }

  // ── Main message handler ──
  bot.on("message", async (ctx) => {
    const msg = ctx.message;
    const text = msg.text ?? msg.caption ?? "";
    const hasPhoto = !!(msg.photo && msg.photo.length > 0);
    const hasDocument = !!(msg.document && msg.document.mime_type?.startsWith("image/"));

    // Debug: log what we received
    logger.info(`[bot] Message keys: ${Object.keys(msg).filter(k => !["from","chat","date","message_id"].includes(k)).join(", ")} | hasPhoto=${hasPhoto} hasDocument=${hasDocument}`);

    // Skip empty messages (stickers, etc. without text or photos)
    if (!text.trim() && !hasPhoto && !hasDocument) return;

    const sessionKey = getSessionKey(ctx);
    if (!sessionKey) {
      logger.warn("[bot] Could not determine session key");
      return;
    }

    // ── Orchestrator-level slash commands (never batched) ──
    const trimmedText = text.trim();
    if (trimmedText.startsWith("/")) {
      const handled = await handleOrchestratorCommand(
        ctx, trimmedText, sessionKey, sessionManager, config, logger
      );
      if (handled) return;

      // Claude Code commands — send raw without sender wrapping
      const claudeCommands = ["/compact", "/cost", "/context", "/login", "/logout", "/doctor", "/memory"];
      const cmd = trimmedText.split(/\s+/)[0].toLowerCase();
      if (claudeCommands.includes(cmd)) {
        logger.info(`[bot] Forwarding Claude command: ${trimmedText}`);
        await ctx.replyWithChatAction("typing");
        const response = await sessionManager.sendMessage(
          sessionKey,
          [{ type: "text", text: trimmedText }]
        );
        if (response?.trim()) {
          const threadId = ctx.message?.message_thread_id;
          const opts: Record<string, unknown> = {};
          if (threadId !== undefined) opts.message_thread_id = threadId;
          const chunks = chunkMessage(response);
          for (const chunk of chunks) {
            await ctx.reply(chunk, opts);
          }
        }
        return;
      }
    }

    const senderName = getSenderName(ctx);
    const threadId = msg.message_thread_id;
    const chatType = msg.chat.type;
    const isForum = "is_forum" in msg.chat ? (msg.chat as unknown as Record<string, unknown>).is_forum : false;
    logger.info(`[bot] Message from ${senderName} → session ${sessionKey} (chat_type=${chatType}, is_forum=${isForum}, thread_id=${threadId}, msg_id=${msg.message_id}): ${text.slice(0, 80)}...`);

    // Ack reaction
    await sendAckReaction(ctx, config.ackReaction);

    // Send typing indicator
    await ctx.replyWithChatAction("typing");

    // Build content blocks (download image immediately so we don't lose the ctx)
    const contentBlocks: ContentBlock[] = [];
    if (hasPhoto || hasDocument) {
      try {
        const imageBlock = await downloadImage(ctx, msg, hasPhoto);
        contentBlocks.push(imageBlock);
      } catch (err) {
        logger.warn(`[bot] Failed to download image: ${err}`);
        contentBlocks.push({ type: "text", text: "[Image could not be loaded]" });
      }
    }

    // Extract reply-to context if this message is a reply
    let replyContext: string | undefined;
    if (msg.reply_to_message) {
      const replyMsg = msg.reply_to_message;
      const replyText = replyMsg.text ?? replyMsg.caption ?? "";
      const replyFrom = replyMsg.from;
      const replySender = replyFrom?.first_name
        ? `${replyFrom.first_name}${replyFrom.last_name ? " " + replyFrom.last_name : ""}`
        : "Unknown";
      if (replyText) {
        // Truncate long quoted text to keep context manageable
        const truncated = replyText.length > 300 ? replyText.slice(0, 300) + "…" : replyText;
        replyContext = `[Replying to ${replySender}: "${truncated}"]`;
      }
    }

    // Buffer this message for batching
    const pending: PendingMessage = {
      ctx,
      text: text || "(sent an image)",
      contentBlocks,
      senderName,
      threadId,
      msgId: msg.message_id,
      replyContext,
    };

    const existing = sessionBuffers.get(sessionKey);
    if (existing) {
      // Add to existing buffer and reset timer
      clearTimeout(existing.timer);
      existing.messages.push(pending);
      logger.info(`[bot] Buffered message ${existing.messages.length} for session ${sessionKey}`);
      existing.timer = setTimeout(() => {
        const buf = sessionBuffers.get(sessionKey);
        if (buf) {
          sessionBuffers.delete(sessionKey);
          processBatch(sessionKey, buf.messages);
        }
      }, MESSAGE_BATCH_DELAY_MS);
    } else {
      // Start new buffer
      const timer = setTimeout(() => {
        const buf = sessionBuffers.get(sessionKey);
        if (buf) {
          sessionBuffers.delete(sessionKey);
          processBatch(sessionKey, buf.messages);
        }
      }, MESSAGE_BATCH_DELAY_MS);
      sessionBuffers.set(sessionKey, { messages: [pending], timer });
    }
  });

  // Prevent polling from dying on handler errors
  bot.catch((err) => {
    const error = err.error;
    // 409 Conflict is a polling-level issue — stop the bot so startWithRetry can handle it
    if (error instanceof GrammyError && error.error_code === 409) {
      logger.warn(`[bot] 409 Conflict in handler — stopping bot for retry`);
      try { bot.stop(); } catch { /* already stopped */ }
      return;
    }
    logger.error(`[bot] Handler error (polling continues): ${error ?? err}`);
  });

  return bot;
}

/**
 * Extract a human-readable sender name from context.
 */
function getSenderName(ctx: Context): string {
  const from = ctx.from;
  if (!from) return "Unknown";

  if (from.first_name) {
    return from.last_name
      ? `${from.first_name} ${from.last_name}`
      : from.first_name;
  }

  return from.username ?? `User ${from.id}`;
}

/**
 * Send an ack reaction emoji on the incoming message.
 */
async function sendAckReaction(ctx: Context, emoji: string): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (ctx.api as any).setMessageReaction(
      ctx.chat!.id,
      ctx.message!.message_id,
      [{ type: "emoji", emoji }],
      true
    );
  } catch {
    // Reactions might not be available in all contexts
  }
}

/**
 * Handle orchestrator-level commands. Returns true if the command was handled.
 * Commands not handled here fall through to Claude Code (which handles /compact, /cost, etc.)
 */
async function handleOrchestratorCommand(
  ctx: Context,
  text: string,
  sessionKey: string,
  sessionManager: SessionManager,
  config: OrchestratorConfig,
  logger: Logger
): Promise<boolean> {
  const replyOpts: Record<string, unknown> = {};
  const threadId = ctx.message?.message_thread_id;
  if (threadId !== undefined) replyOpts.message_thread_id = threadId;

  const [cmd, ...args] = text.split(/\s+/);
  const command = cmd.toLowerCase();

  switch (command) {
    case "/kill": {
      sessionManager.killSession(sessionKey);
      await ctx.reply("Session killed. Next message will start a fresh session.", replyOpts);
      return true;
    }

    case "/sessions": {
      const status = sessionManager.getStatus();
      if (status.length === 0) {
        await ctx.reply("No active sessions.", replyOpts);
      } else {
        const lines = status.map(
          (s) => `• ${s.key} — ${s.alive ? "alive" : "dead"}, idle ${s.idleMinutes}m, ${s.messageCount} msgs`
        );
        await ctx.reply(lines.join("\n"), replyOpts);
      }
      return true;
    }

    case "/restart": {
      sessionManager.killSession(sessionKey);
      await ctx.reply("Session restarted. Resuming conversation...", replyOpts);
      return true;
    }

    case "/model": {
      const modelArg = args[0]?.toLowerCase();
      const available = config.availableModels ?? ["opus", "sonnet", "haiku"];
      if (!modelArg) {
        const current = config.defaultModel;
        await ctx.reply(`Current default: ${current}\nAvailable: ${available.join(", ")}\nUsage: /model <name>`, replyOpts);
        return true;
      }
      if (!available.includes(modelArg)) {
        await ctx.reply(`Unknown model "${modelArg}". Available: ${available.join(", ")}`, replyOpts);
        return true;
      }
      // Kill current session and respawn with new model on next message
      sessionManager.killSession(sessionKey);
      sessionManager.setSessionModel(sessionKey, modelArg);
      await ctx.reply(`Switched to ${modelArg}. Session will resume with new model.`, replyOpts);
      return true;
    }

    case "/schedules": {
      const userId = ctx.from?.id;
      if (!userId || !ADMIN_USERS.includes(userId)) {
        await ctx.reply("Only admins can manage schedules.", replyOpts);
        return true;
      }
      if (!_scheduler) {
        await ctx.reply("Scheduler not initialized.", replyOpts);
        return true;
      }
      const jobs = _scheduler.listJobs();
      if (jobs.length === 0) {
        await ctx.reply("No scheduled jobs.", replyOpts);
      } else {
        const lines = jobs.map(j =>
          `${j.enabled ? "✅" : "⏸️"} ${j.name} (${j.id})\n   Cron: ${j.cron}\n   Chat: ${j.chatId}${j.topicId ? ` topic ${j.topicId}` : ""}\n   Next: ${j.nextRun ?? "—"}`
        );
        await ctx.reply(lines.join("\n\n"), replyOpts);
      }
      return true;
    }

    case "/schedule": {
      const userId = ctx.from?.id;
      if (!userId || !ADMIN_USERS.includes(userId)) {
        await ctx.reply("Only admins can manage schedules.", replyOpts);
        return true;
      }
      if (!_scheduler) {
        await ctx.reply("Scheduler not initialized.", replyOpts);
        return true;
      }

      const subCmd = args[0]?.toLowerCase();

      if (subCmd === "add") {
        // /schedule add <name> <cron-5-fields> <message...>
        // Example: /schedule add test-job 0 9 * * * Hello world
        if (args.length < 8) {
          await ctx.reply("Usage: /schedule add <name> <min> <hour> <dom> <month> <dow> <message...>", replyOpts);
          return true;
        }
        const name = args[1];
        const cron = args.slice(2, 7).join(" ");
        const message = args.slice(7).join(" ");
        const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
        const chatId = ctx.chat!.id;

        const job: ScheduleJob = { id, name, cron, chatId, message, enabled: true };
        _scheduler.addJob(job);
        await ctx.reply(`Added job "${name}" (${id})\nCron: ${cron}\nMessage: ${message.slice(0, 100)}${message.length > 100 ? "..." : ""}`, replyOpts);
        return true;
      }

      if (subCmd === "add-brief") {
        // /schedule add-brief <name> <min> <hour> <dom> <month> <dow> <prompt...>
        // Like `add` but routes through Claude with web/tool access.
        if (args.length < 8) {
          await ctx.reply("Usage: /schedule add-brief <name> <min> <hour> <dom> <month> <dow> <prompt...>", replyOpts);
          return true;
        }
        const name = args[1];
        const cron = args.slice(2, 7).join(" ");
        const prompt = args.slice(7).join(" ");
        const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
        const chatId = ctx.chat!.id;
        const topicId = ctx.message?.message_thread_id;

        const job: ScheduleJob = {
          id,
          name,
          cron,
          chatId,
          ...(topicId !== undefined && { topicId }),
          message: "",  // unused for briefing jobs
          prompt,
          enabled: true,
        };
        _scheduler.addJob(job);
        await ctx.reply(
          `Added briefing job "${name}" (${id})\nCron: ${cron}\nPrompt: ${prompt.slice(0, 200)}${prompt.length > 200 ? "..." : ""}`,
          replyOpts
        );
        return true;
      }

      if (subCmd === "remove") {
        const id = args[1];
        if (!id) {
          await ctx.reply("Usage: /schedule remove <id>", replyOpts);
          return true;
        }
        const removed = _scheduler.removeJob(id);
        await ctx.reply(removed ? `Removed job "${id}".` : `Job "${id}" not found.`, replyOpts);
        return true;
      }

      if (subCmd === "toggle") {
        const id = args[1];
        if (!id) {
          await ctx.reply("Usage: /schedule toggle <id>", replyOpts);
          return true;
        }
        const job = _scheduler.toggleJob(id);
        if (job) {
          await ctx.reply(`Job "${id}" is now ${job.enabled ? "enabled ✅" : "disabled ⏸️"}.`, replyOpts);
        } else {
          await ctx.reply(`Job "${id}" not found.`, replyOpts);
        }
        return true;
      }

      if (subCmd === "reload") {
        _scheduler.reload();
        const jobs = _scheduler.listJobs();
        await ctx.reply(`Reloaded ${jobs.length} jobs from disk.`, replyOpts);
        return true;
      }

      await ctx.reply("Usage:\n  /schedules — list jobs\n  /schedule add <name> <min> <hour> <dom> <month> <dow> <message>\n  /schedule add-brief <name> <min> <hour> <dom> <month> <dow> <prompt>\n     ↳ runs prompt through Claude (web search, tools), posts response\n  /schedule remove <id>\n  /schedule toggle <id>\n  /schedule reload", replyOpts);
      return true;
    }

    case "/mode": {
      const userId = ctx.from?.id?.toString();
      if (!userId) {
        await ctx.reply("Cannot determine your user ID.", replyOpts);
        return true;
      }
      const modeArg = args[0]?.toLowerCase();
      if (!modeArg) {
        const cfg = getUserConfigForSession(sessionKey, userId);
        await ctx.reply(
          `Current mode: ${cfg.completionOnly ? "completion-only" : "streaming"}\n` +
          `Usage: /mode streaming | /mode completion`,
          replyOpts
        );
        return true;
      }
      if (modeArg === "completion" || modeArg === "completion-only") {
        setUserConfig(userId, { completionOnly: true });
        await ctx.reply("Switched to completion-only mode. You'll only see final responses.", replyOpts);
        return true;
      }
      if (modeArg === "streaming" || modeArg === "stream") {
        setUserConfig(userId, { completionOnly: false });
        await ctx.reply("Switched to streaming mode. You'll see responses as they're generated.", replyOpts);
        return true;
      }
      await ctx.reply("Usage: /mode streaming | /mode completion", replyOpts);
      return true;
    }

    case "/help": {
      const help = [
        "Orchestrator commands:",
        "  /kill — Kill current session (next msg starts fresh with resume)",
        "  /restart — Restart session (same as /kill)",
        "  /model <name> — Switch model (opus/sonnet/haiku)",
        "  /mode <streaming|completion> — Switch response mode",
        "  /sessions — Show all active sessions",
        "  /schedules — List scheduled messages",
        "  /schedule add|add-brief|remove|toggle|reload — Manage schedules",
        "  /help — This message",
        "",
        "Claude commands (forwarded to Claude Code):",
        "  /compact — Compress conversation context",
        "  /cost — Show session cost",
        "  /context — Show context usage",
      ];
      await ctx.reply(help.join("\n"), replyOpts);
      return true;
    }

    default:
      // Not an orchestrator command — let it fall through to Claude
      return false;
  }
}

/**
 * Send a response back to Telegram, chunking if needed.
 */
async function sendResponse(
  ctx: Context,
  text: string,
  threadId?: number
): Promise<void> {
  const chunks = chunkMessage(text);

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const opts: Record<string, unknown> = {};

    // Reply to original message for first chunk
    if (i === 0) {
      opts.reply_to_message_id = ctx.message!.message_id;
    }

    // Thread support
    if (threadId !== undefined) {
      opts.message_thread_id = threadId;
    }

    try {
      // Send as plain text — Markdown causes formatting issues with special characters
      await ctx.reply(chunk, opts);
    } catch (err) {
      console.error(`Failed to send chunk ${i}:`, err);
    }
  }
}

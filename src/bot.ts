// ── Grammy bot setup & message handlers ──

import { Bot, GrammyError, type Context } from "grammy";
import type { ContentBlock, OrchestratorConfig, ScheduleJob } from "./types";
import { SessionManager } from "./session";
import { getSessionKey } from "./router";
import { chunkMessage, formatUserMessage, Logger } from "./utils";
import { logInbound, logOutbound } from "./channel-log";
import type { Scheduler } from "./scheduler";

// Admin users who can manage schedules
const ADMIN_USERS = [717932407, 5052308275]; // Anthony, Tina

// Module-level scheduler reference, set after bot creation
let _scheduler: Scheduler | null = null;
export function setScheduler(scheduler: Scheduler): void {
  _scheduler = scheduler;
}

export function createBot(
  token: string,
  config: OrchestratorConfig,
  sessionManager: SessionManager,
  logger: Logger
): Bot {
  const bot = new Bot(token);

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

    // ── Orchestrator-level slash commands ──
    const trimmedText = text.trim();
    if (trimmedText.startsWith("/")) {
      const handled = await handleOrchestratorCommand(
        ctx, trimmedText, sessionKey, sessionManager, config, logger
      );
      if (handled) return;
      // Not an orchestrator command — fall through to Claude
      // (Claude handles /compact, /cost, /status, etc. natively)
    }

    const senderName = getSenderName(ctx);
    const threadId = msg.message_thread_id;
    const chatType = msg.chat.type;
    const isForum = "is_forum" in msg.chat ? (msg.chat as unknown as Record<string, unknown>).is_forum : false;
    logger.info(`[bot] Message from ${senderName} → session ${sessionKey} (chat_type=${chatType}, is_forum=${isForum}, thread_id=${threadId}): ${text.slice(0, 80)}...`);

    // Ack reaction
    await sendAckReaction(ctx, config.ackReaction);

    // Send typing indicator
    await ctx.replyWithChatAction("typing");

    // Keep typing indicator alive during processing
    const typingInterval = setInterval(async () => {
      try {
        await ctx.replyWithChatAction("typing");
      } catch {
        // ignore
      }
    }, 4000);

    try {
      // Log inbound message
      logInbound(sessionKey, senderName, text);

      // Build content blocks for Claude
      const contentBlocks: ContentBlock[] = [];

      // Download photo if present
      if (hasPhoto || hasDocument) {
        try {
          const fileId = hasPhoto
            ? msg.photo![msg.photo!.length - 1].file_id  // Largest photo size
            : msg.document!.file_id;
          const file = await ctx.api.getFile(fileId);
          const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
          const response = await fetch(url);
          const buffer = await response.arrayBuffer();
          const base64 = Buffer.from(buffer).toString("base64");

          // Determine media type
          const ext = file.file_path?.split(".").pop()?.toLowerCase() ?? "jpg";
          const mediaTypes: Record<string, string> = {
            jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
            gif: "image/gif", webp: "image/webp", bmp: "image/bmp",
          };
          const mediaType = hasDocument
            ? (msg.document!.mime_type ?? "image/jpeg")
            : (mediaTypes[ext] ?? "image/jpeg");

          contentBlocks.push({
            type: "image",
            source: { type: "base64", media_type: mediaType, data: base64 },
          });
          logger.info(`[bot] Downloaded image for session ${sessionKey} (${Math.round(buffer.byteLength / 1024)}KB)`);
        } catch (err) {
          logger.warn(`[bot] Failed to download image: ${err}`);
          contentBlocks.push({ type: "text", text: "[Image could not be loaded]" });
        }
      }

      // Add text content
      const formattedMessage = formatUserMessage(senderName, text || "(sent an image)");
      contentBlocks.push({ type: "text", text: formattedMessage });

      // Streaming: edit current message as text streams in. When a paragraph
      // break (\n\n) appears, finalize that message and start a new one.
      // At the end, just do a final edit on the last message — don't re-send.
      const baseOpts: Record<string, unknown> = {};
      if (threadId !== undefined) {
        baseOpts.message_thread_id = threadId;
      }

      let currentMsg: { chat: { id: number }; message_id: number } | null = null;
      let currentMsgText = "";
      let lastEditText = "";
      let lastEditTime = 0;
      const EDIT_INTERVAL_MS = 1500;
      let pendingEditTimer: ReturnType<typeof setTimeout> | null = null;
      let previousAccumulated = "";

      const editCurrentMsg = async (text: string) => {
        if (!currentMsg || text === lastEditText) return;
        const display = text.length > 4000 ? text.slice(0, 4000) + "\n\n…" : text;
        try {
          await ctx.api.editMessageText(currentMsg.chat.id, currentMsg.message_id, display);
          lastEditText = text;
          lastEditTime = Date.now();
        } catch {}
      };

      const startNewMessage = async (initialText: string) => {
        currentMsgText = initialText;
        lastEditText = "";
        try {
          currentMsg = await ctx.reply(initialText || "…", baseOpts);
          lastEditTime = Date.now();
          lastEditText = initialText;
        } catch {
          currentMsg = null;
        }
      };

      // Send initial placeholder (reply to original message)
      const firstMsgOpts = { ...baseOpts, reply_to_message_id: msg.message_id };
      try {
        currentMsg = await ctx.reply("…", firstMsgOpts);
        lastEditTime = Date.now();
      } catch {
        currentMsg = null;
      }

      let startingNewMsg = false; // guard against race during async startNewMessage

      const onDelta = (accumulatedText: string) => {
        if (!currentMsg || startingNewMsg) return;

        const newText = accumulatedText.slice(previousAccumulated.length);
        if (!newText) return; // no new content (e.g., assistant event re-emitting same text)
        previousAccumulated = accumulatedText;
        currentMsgText += newText;

        // Check for paragraph break — finalize current msg, start new one
        const breakIdx = currentMsgText.indexOf("\n\n");
        if (breakIdx !== -1 && currentMsgText.length > breakIdx + 2) {
          const finalized = currentMsgText.slice(0, breakIdx).trim();
          const remainder = currentMsgText.slice(breakIdx + 2).trim();

          if (finalized) {
            editCurrentMsg(finalized);
          }
          if (remainder) {
            startingNewMsg = true;
            startNewMessage(remainder).finally(() => { startingNewMsg = false; });
          } else {
            // Paragraph break at end — reset for next paragraph
            currentMsgText = "";
          }
          return;
        }

        // No break — throttled edit of current message
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

      const response = await sessionManager.sendMessage(sessionKey, contentBlocks, onDelta);

      if (pendingEditTimer) {
        clearTimeout(pendingEditTimer);
        pendingEditTimer = null;
      }

      // Log outbound response
      logOutbound(sessionKey, response);

      // Final step: just make sure the last message has its complete text.
      // Everything else was already sent as individual paragraph messages.
      if (currentMsg && currentMsgText.trim()) {
        await editCurrentMsg(currentMsgText.trim());
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error(`[bot] Error processing message: ${errorMsg}`);
      try {
        await ctx.reply("⚠️ Error processing your message. Please try again.", {
          reply_to_message_id: msg.message_id,
          ...(msg.message_thread_id !== undefined && {
            message_thread_id: msg.message_thread_id,
          }),
        });
      } catch {
        // Can't even send error reply
      }
    } finally {
      clearInterval(typingInterval);
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

      await ctx.reply("Usage:\n  /schedules — list jobs\n  /schedule add <name> <min> <hour> <dom> <month> <dow> <message>\n  /schedule remove <id>\n  /schedule toggle <id>\n  /schedule reload", replyOpts);
      return true;
    }

    case "/help": {
      const help = [
        "Orchestrator commands:",
        "  /kill — Kill current session (next msg starts fresh with resume)",
        "  /restart — Restart session (same as /kill)",
        "  /model <name> — Switch model (opus/sonnet/haiku)",
        "  /sessions — Show all active sessions",
        "  /schedules — List scheduled messages",
        "  /schedule add|remove|toggle|reload — Manage schedules",
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

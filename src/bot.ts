// ── Grammy bot setup & message handlers ──

import { Bot, GrammyError, type Context } from "grammy";
import { spawn } from "node:child_process";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { ContentBlock, OrchestratorConfig, ScheduleJob } from "./types";
import { SessionManager } from "./session";
import { getSessionKey, parseSessionKey } from "./router";
import { chunkMessage, formatUserMessage, Logger } from "./utils";
import { logInbound, logOutbound } from "./channel-log";
import type { Scheduler } from "./scheduler";
import type { NotificationQueue } from "./notify";
import { getUserConfigForSession, setUserConfig } from "./user-config";
import { markInflight, clearInflight } from "./inflight";

// Path to the pdf-read skill (text + OCR fallback). Used when pdfjs returns
// empty/sparse text (image-based scanned PDFs).
const PDF_READ_SKILL = join(homedir(), ".openclaw/workspace/skills/pdf-read/extract.sh");
const PDF_OCR_TIMEOUT_MS = 5 * 60 * 1000; // 5 min hard cap for OCR work
const PDF_OCR_MAX_PAGES = 60;             // OCR is slow; cap aggressively for chat use

/**
 * Run the pdf-read skill on a buffer. Writes the buffer to a tmp file,
 * shells out to extract.sh, returns the extracted text (or null on failure).
 * Always cleans up the tmp file.
 */
async function runPdfOcrFallback(
  buffer: ArrayBuffer,
  filename: string,
  logger: Logger
): Promise<string | null> {
  const tmpDir = join(tmpdir(), "orchestrator-pdfs");
  try {
    await mkdir(tmpDir, { recursive: true });
  } catch {
    /* mkdir -p semantics — ignore */
  }
  const tmpPath = join(
    tmpDir,
    `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${filename.replace(/[^a-zA-Z0-9._-]/g, "_")}`
  );

  try {
    await writeFile(tmpPath, Buffer.from(buffer));
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.warn(`[bot] OCR fallback: failed to write tmp PDF: ${errMsg}`);
    return null;
  }

  return new Promise<string | null>((resolve) => {
    const child = spawn(
      "bash",
      [PDF_READ_SKILL, tmpPath, "--quiet", "--max-pages", String(PDF_OCR_MAX_PAGES)],
      { stdio: ["ignore", "pipe", "pipe"] }
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf-8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf-8"); });

    const killTimer = setTimeout(() => {
      logger.warn(`[bot] OCR fallback: timeout after ${PDF_OCR_TIMEOUT_MS}ms — killing`);
      child.kill("SIGKILL");
    }, PDF_OCR_TIMEOUT_MS);

    const cleanup = async () => {
      try { await unlink(tmpPath); } catch { /* best effort */ }
    };

    child.on("error", async (err) => {
      clearTimeout(killTimer);
      logger.warn(`[bot] OCR fallback: spawn error: ${err.message}`);
      await cleanup();
      resolve(null);
    });

    child.on("close", async (code) => {
      clearTimeout(killTimer);
      await cleanup();
      if (code !== 0) {
        logger.warn(`[bot] OCR fallback: exit ${code}; stderr: ${stderr.trim().slice(0, 500)}`);
        resolve(null);
        return;
      }
      const trimmed = stdout.trim();
      if (!trimmed) {
        logger.warn(`[bot] OCR fallback: empty stdout (stderr: ${stderr.trim().slice(0, 200)})`);
        resolve(null);
        return;
      }
      logger.info(`[bot] OCR fallback: extracted ${trimmed.length} chars from ${filename}`);
      resolve(trimmed);
    });
  });
}

// Admin users who can manage schedules. Loaded from ADMIN_USERS env var
// (comma-separated Telegram user IDs). Empty = no admins.
const ADMIN_USERS = (process.env.ADMIN_USERS ?? "")
  .split(",")
  .map((s) => parseInt(s.trim(), 10))
  .filter((n) => !isNaN(n));

// Module-level scheduler reference, set after bot creation
let _scheduler: Scheduler | null = null;
export function setScheduler(scheduler: Scheduler): void {
  _scheduler = scheduler;
}

/**
 * Render a 5-field cron expression as a short human-readable string for
 * /schedules output. Falls back to the raw cron if the pattern is exotic.
 * Examples:
 *   "0 8 * * *"       → "daily at 8:00am"
 *   "33 13 * * 1,3"   → "Mon, Wed at 1:33pm"
 *   "0 15 * * 1-5"    → "weekdays at 3:00pm"
 */
function humanizeCron(cron: string): string {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return cron;
  const [minF, hourF, domF, monthF, dowF] = fields;

  // Only humanize the common case: specific minute + specific hour
  if (
    !/^\d+$/.test(minF) ||
    !/^\d+$/.test(hourF) ||
    domF !== "*" ||
    monthF !== "*"
  ) {
    return cron;
  }

  const minute = parseInt(minF, 10);
  const hour24 = parseInt(hourF, 10);
  const ampm = hour24 >= 12 ? "pm" : "am";
  const hour12 = ((hour24 + 11) % 12) + 1;
  const time = `${hour12}:${minute.toString().padStart(2, "0")}${ampm}`;

  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  let when: string;
  if (dowF === "*") {
    when = "daily";
  } else if (dowF === "1-5") {
    when = "weekdays";
  } else if (dowF === "0,6" || dowF === "6,0") {
    when = "weekends";
  } else if (/^[0-6](,[0-6])*$/.test(dowF)) {
    const list = dowF.split(",").map((d) => days[parseInt(d, 10)]);
    when = list.join(", ");
  } else {
    return cron;
  }

  return `${when} at ${time}`;
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

  // ── Helper: download a PDF (or other text-extractable document) and return a text content block ──
  // Caps extracted text to MAX_PDF_TEXT_CHARS to avoid blowing the model context.
  // On any failure, returns a friendly stub so Claude knows an attachment was sent.
  const MAX_PDF_TEXT_CHARS = 100_000;
  const MAX_PDF_BYTES = 25 * 1024 * 1024; // 25MB — Telegram bot getFile cap is 20MB anyway

  async function downloadDocumentAsText(
    ctx: Context,
    msg: Context["message"] & object
  ): Promise<ContentBlock> {
    const doc = msg.document!;
    const filename = doc.file_name ?? "document";
    const mimeType = doc.mime_type ?? "";

    try {
      if (doc.file_size && doc.file_size > MAX_PDF_BYTES) {
        logger.warn(`[bot] Document too large: ${filename} (${doc.file_size} bytes)`);
        return {
          type: "text",
          text: `[Document received: ${filename} — too large to process (${Math.round(doc.file_size / 1024 / 1024)}MB)]`,
        };
      }

      const file = await ctx.api.getFile(doc.file_id);
      const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
      const response = await fetch(url);
      const buffer = await response.arrayBuffer();

      const ext = (file.file_path ?? filename).split(".").pop()?.toLowerCase() ?? "";
      const isPdf = mimeType === "application/pdf" || ext === "pdf";
      const isPlainText =
        mimeType.startsWith("text/") ||
        ext === "txt" || ext === "md" || ext === "markdown" ||
        ext === "csv" || ext === "log" || ext === "json" || ext === "xml" ||
        ext === "yaml" || ext === "yml";

      let extracted = "";

      if (isPdf) {
        // Tier 1 — pdfjs text-layer extraction (fast, works for digital PDFs).
        // pdfjs DETACHES the underlying ArrayBuffer when it ingests data, so we
        // pass a COPY (.slice(0) on the ArrayBuffer) — keeps the original buffer
        // alive for the OCR fallback below. Without this copy, OCR fails with
        // "Buffer is detached".
        const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
        const loadingTask = pdfjsLib.getDocument({
          data: new Uint8Array(buffer.slice(0)),
          // Server-side text extraction: skip font / system-font work
          disableFontFace: true,
          useSystemFonts: false,
        });
        const pdfDoc = await loadingTask.promise;
        const numPages = pdfDoc.numPages;
        const parts: string[] = [];
        let textBodyLen = 0;
        for (let i = 1; i <= numPages; i++) {
          const page = await pdfDoc.getPage(i);
          const content = await page.getTextContent();
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const pageText = content.items.map((it: any) => it.str ?? "").join(" ");
          parts.push(`--- Page ${i} ---\n${pageText}`);
          textBodyLen += pageText.trim().length;
          if (parts.join("\n\n").length > MAX_PDF_TEXT_CHARS) break;
        }
        extracted = parts.join("\n\n");
        logger.info(`[bot] Extracted PDF text: ${filename} (${numPages} pages, ${extracted.length} chars, body ${textBodyLen} chars)`);

        // Tier 2 — OCR fallback when the text layer is empty or sparse.
        // Trigger if avg body text < 50 chars/page (matches scanned PDFs where
        // pdfjs returns mostly whitespace and page headers).
        const sparseThreshold = 50 * numPages;
        if (textBodyLen < sparseThreshold) {
          logger.info(`[bot] PDF text layer sparse (${textBodyLen} < ${sparseThreshold} chars across ${numPages} pages) — running OCR fallback`);
          const ocrText = await runPdfOcrFallback(buffer, filename, logger);
          if (ocrText && ocrText.length > textBodyLen) {
            extracted = ocrText;
            logger.info(`[bot] OCR fallback succeeded for ${filename} (${ocrText.length} chars)`);
          } else if (!ocrText) {
            logger.warn(`[bot] OCR fallback failed for ${filename}; passing stub message`);
            return {
              type: "text",
              text: `[PDF received: ${filename} (${numPages} pages) — text extraction + OCR both failed. The file may be encrypted, corrupted, or contain only handwriting.]`,
            };
          }
        }
      } else if (isPlainText) {
        extracted = Buffer.from(buffer).toString("utf-8");
        logger.info(`[bot] Loaded text document: ${filename} (${extracted.length} chars)`);
      } else {
        logger.warn(`[bot] Unsupported document type: ${filename} (mime=${mimeType})`);
        return {
          type: "text",
          text: `[Document received: ${filename} (${mimeType || "unknown type"}) — text extraction not supported]`,
        };
      }

      const trimmed = extracted.trim();
      if (!trimmed) {
        return {
          type: "text",
          text: `[Document received: ${filename}, but no text could be extracted (image-only PDF or empty document)]`,
        };
      }

      const truncated = trimmed.length > MAX_PDF_TEXT_CHARS;
      const finalText = truncated ? trimmed.slice(0, MAX_PDF_TEXT_CHARS) : trimmed;
      const header = `[Document attached: ${filename} (${isPdf ? "PDF" : mimeType || ext})${truncated ? `, truncated to ${MAX_PDF_TEXT_CHARS} chars of ${trimmed.length}` : ""}]`;
      return { type: "text", text: `${header}\n\n${finalText}` };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.warn(`[bot] Document extraction failed for ${filename}: ${errMsg}`);
      return {
        type: "text",
        text: `[Document received: ${filename}, but text extraction failed: ${errMsg}]`,
      };
    }
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
    // Merge content blocks (same logic as processBatch).
    // Images go first, then any extracted-document text blocks, then the user's
    // own text — matches the expected order Claude sees in multimodal turns.
    const allContentBlocks: ContentBlock[] = [];
    for (const pending of batch) {
      for (const block of pending.contentBlocks) {
        if (block.type === "image") allContentBlocks.push(block);
      }
    }
    for (const pending of batch) {
      for (const block of pending.contentBlocks) {
        if (block.type === "text") allContentBlocks.push(block);
      }
    }

    if (batch.length === 1) {
      const pending = batch[0];
      const msgText = pending.replyContext
        ? `${pending.replyContext}\n${pending.text || "(sent an attachment)"}`
        : (pending.text || "(sent an attachment)");
      const formattedMessage = formatUserMessage(pending.senderName, msgText);
      allContentBlocks.push({ type: "text", text: formattedMessage });
      logInbound(sessionKey, pending.senderName, pending.text);
    } else {
      const combinedText = batch
        .map((p) => {
          const txt = p.text || "(sent an attachment)";
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
      logger.info(`[bot] completion-only START for ${sessionKey} (batch=${batch.length}, chat=${chatId})`);

      // Send acknowledgment so user knows we're actively working
      const ackOk = await notifyQueue.send({
        chatId,
        threadId,
        text: "Got it, working on this now.",
        replyToMessageId: batch[0].msgId,
        tag: `ack:${sessionKey}`,
      });
      if (!ackOk) {
        logger.warn(`[bot] completion-only ack send returned false for ${sessionKey} (queued for retry)`);
      }

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
        const responseText = response.trim();
        logger.info(`[bot] completion-only DELIVERING ${sessionKey} (chars=${responseText.length})`);
        const sent = await notifyQueue.send({
          chatId,
          threadId,
          text: responseText,
          fallbackChatId,
          fallbackThreadId,
          replyToMessageId: batch[0].msgId,
          tag: `response:${sessionKey}`,
        });
        if (sent) {
          logger.info(`[bot] completion-only DELIVERED ${sessionKey} (chars=${responseText.length}) immediately`);
        } else {
          // notifyQueue has queued it for retry — log loudly so it's visible.
          logger.error(`[bot] completion-only DELIVERY DEFERRED for ${sessionKey} (chars=${responseText.length}) — notifyQueue will retry. If this persists, the user will not see the response.`);
        }
      } else {
        logger.warn(`[bot] completion-only EMPTY RESPONSE for ${sessionKey} — nothing to deliver`);
      }
      clearInflight(sessionKey);
    } catch (err) {
      clearInflight(sessionKey);
      const errorMsg = err instanceof Error ? err.message : String(err);
      const errStack = err instanceof Error ? err.stack : "";
      logger.error(`[bot] Error in completion-only processing for ${sessionKey}: ${errorMsg}${errStack ? `\n${errStack}` : ""}`);
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
      // Merge all content blocks from all messages in the batch.
      // Order: images → extracted-document text → the user's own text.
      const allContentBlocks: ContentBlock[] = [];

      for (const pending of batch) {
        for (const block of pending.contentBlocks) {
          if (block.type === "image") allContentBlocks.push(block);
        }
      }
      for (const pending of batch) {
        for (const block of pending.contentBlocks) {
          if (block.type === "text") allContentBlocks.push(block);
        }
      }

      // Combine text from all messages into one formatted block
      if (batch.length === 1) {
        const pending = batch[0];
        const msgText = pending.replyContext
          ? `${pending.replyContext}\n${pending.text || "(sent an attachment)"}`
          : (pending.text || "(sent an attachment)");
        const formattedMessage = formatUserMessage(pending.senderName, msgText);
        allContentBlocks.push({ type: "text", text: formattedMessage });
        logInbound(sessionKey, pending.senderName, pending.text);
      } else {
        // Multiple messages — combine with separator
        const combinedText = batch
          .map((p) => {
            const txt = p.text || "(sent an attachment)";
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

      // ── Delivery tracking (BUG FIX: long messages were silently dropped) ──
      // deliveredFinalized: text from messages that have been "finalized" (paragraph
      //   committed, then we moved on to a new Telegram message). These represent
      //   confirmed-delivered content from the user's perspective.
      // deliveryFailures: count of editMessageText/reply errors during streaming.
      // streamingBroken: set true if currentMsg becomes null mid-stream (fatal —
      //   we've lost our edit handle and any further deltas would be invisible).
      const deliveredFinalized: string[] = [];
      let deliveryFailures = 0;
      let streamingBroken = false;

      // Classifier for Telegram edit errors. Some 400s are benign no-ops, not
      // real delivery failures — counting them as failures triggers spurious
      // reconciliation fallbacks and DUPLICATE messages to the user.
      //   - "message is not modified" → identical content already on screen, fine
      //   - "message to edit not found" → message was deleted/expired, FATAL for
      //       streaming (we've lost our edit handle, any further deltas to this
      //       message vanish). Treat as streamingBroken so reconciliation fires.
      const classifyEditError = (err: unknown): "ignore" | "broken" | "fail" => {
        const s = String(err).toLowerCase();
        if (s.includes("message is not modified")) return "ignore";
        if (s.includes("message to edit not found") || s.includes("message to edit not")) return "broken";
        if (s.includes("not found")) return "broken";  // covers "Bad Request: not Found"
        return "fail";
      };

      const editCurrentMsg = async (text: string) => {
        if (!currentMsg || text === lastEditText) return;
        const display = text.length > 4000 ? text.slice(0, 4000) + "\n\n…" : text;
        try {
          await ctx.api.editMessageText(currentMsg.chat.id, currentMsg.message_id, display);
          lastEditText = text;
          lastEditTime = Date.now();
        } catch (err) {
          const kind = classifyEditError(err);
          if (kind === "ignore") {
            // Content already on screen (likely from silence heartbeat).
            // Sync lastEditText so we stop retrying the same edit.
            lastEditText = text;
            lastEditTime = Date.now();
            return;
          }
          if (kind === "broken") {
            // Lost our edit handle — any further deltas to this msg are invisible.
            // Drop currentMsg so processDelta opens a new one for subsequent text.
            streamingBroken = true;
            logger.error(`[bot] editMessageText: message gone for ${sessionKey} (chars=${text.length}) — marking streamingBroken: ${err}`);
            currentMsg = null;
            return;
          }
          deliveryFailures++;
          // Log at ERROR (not WARN) so silent drops are visible. Include text size
          // so we can correlate with response length when reconciling.
          logger.error(`[bot] editMessageText failed for ${sessionKey} (chars=${text.length}, failures=${deliveryFailures}): ${err}`);
        }
      };

      const startNewMessage = async (initialText: string) => {
        // Before we move on, the previously-edited text in lastEditText is now
        // "finalized" — it's the content of an older Telegram message we won't
        // touch again. Record it as delivered.
        if (lastEditText) {
          deliveredFinalized.push(lastEditText);
        }
        currentMsgText = initialText;
        lastEditText = "";
        try {
          currentMsg = await ctx.reply(initialText || "…", baseOpts);
          lastEditTime = Date.now();
          lastEditText = initialText;
        } catch (err) {
          deliveryFailures++;
          streamingBroken = true;
          logger.error(`[bot] startNewMessage failed for ${sessionKey} (chars=${initialText.length}, failures=${deliveryFailures}) — streaming broken, will reconcile at end: ${err}`);
          currentMsg = null;
        }
      };

      // Send initial placeholder (reply to first message in batch)
      const firstMsgOpts = { ...baseOpts, reply_to_message_id: batch[0].msgId };
      try {
        currentMsg = await ctx.reply("…", firstMsgOpts);
        lastEditTime = Date.now();
      } catch (err) {
        deliveryFailures++;
        streamingBroken = true;
        logger.error(`[bot] initial placeholder ctx.reply failed for ${sessionKey} — streaming broken from the start: ${err}`);
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
          const display = heartbeatText.slice(0, 4000);
          try {
            await ctx.api.editMessageText(currentMsg.chat.id, currentMsg.message_id, display);
            // Sync lastEditText to whatever's on screen. Without this, the NEXT
            // streaming edit can collide with the heartbeat content and produce
            // a "message is not modified" 400 that used to count as a delivery
            // failure → spurious reconciliation fallback → duplicate messages.
            lastEditText = display;
            lastEditTime = Date.now();
          } catch (err) {
            // Heartbeat is best-effort. If the message is gone, mark streaming
            // broken so reconciliation kicks in instead of silently dropping.
            const s = String(err).toLowerCase();
            if (s.includes("not found") || s.includes("message to edit")) {
              streamingBroken = true;
              currentMsg = null;
              logger.warn(`[bot] heartbeat: message gone for ${sessionKey} — marking streamingBroken`);
            }
          }
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

      // Final flush — deliver complete text. If it exceeds Telegram's
      // ~4096-char per-message limit, properly chunk it across multiple
      // messages instead of truncating to 4000 chars + "…" (which silently
      // dropped content past 4000 — the original bug on long messages).
      let finalChunkSucceeded = false;
      if (currentMsg && currentMsgText.trim()) {
        const finalText = currentMsgText.trim();
        const chunks = chunkMessage(finalText, 4000);
        if (chunks.length === 1) {
          // editCurrentMsg updates lastEditText on success → captured below
          await editCurrentMsg(chunks[0]);
          finalChunkSucceeded = lastEditText === chunks[0];
        } else {
          // Multi-chunk: edit current msg with chunk 0, send rest as replies.
          // Pace at ~1.1s between sends to stay under Telegram's 1msg/sec/chat
          // rate limit (with a touch of slack to avoid jitter rejects).
          let chunk0Ok = false;
          try {
            await ctx.api.editMessageText(currentMsg.chat.id, currentMsg.message_id, chunks[0]);
            lastEditText = chunks[0];
            lastEditTime = Date.now();
            chunk0Ok = true;
          } catch (err) {
            deliveryFailures++;
            logger.error(`[bot] final flush editMessageText failed for ${sessionKey} (chars=${chunks[0].length}): ${err}`);
          }
          // Push chunks[0..n-1] into deliveredFinalized; reserve the LAST
          // successfully-delivered chunk for lastEditText so the reconciliation
          // math (`[...deliveredFinalized, lastEditText].join("\n\n")`) doesn't
          // double-count the final chunk.
          let allChunksOk = chunk0Ok;
          let lastDeliveredChunk = chunk0Ok ? chunks[0] : "";
          for (let i = 1; i < chunks.length; i++) {
            await new Promise((r) => setTimeout(r, 1100));
            try {
              // Push the PREVIOUS lastDeliveredChunk now that we're moving past it.
              if (lastDeliveredChunk) deliveredFinalized.push(lastDeliveredChunk);
              currentMsg = await ctx.reply(chunks[i], baseOpts);
              lastDeliveredChunk = chunks[i];
            } catch (err) {
              deliveryFailures++;
              allChunksOk = false;
              logger.error(`[bot] final flush reply chunk ${i + 1}/${chunks.length} failed for ${sessionKey} (chars=${chunks[i].length}): ${err}`);
            }
          }
          // The final delivered chunk lives in lastEditText (not deliveredFinalized),
          // so reconciliation can join them once without duplicating.
          lastEditText = lastDeliveredChunk;
          finalChunkSucceeded = allChunksOk;
          logger.info(`[bot] Long response final-flush attempted for ${sessionKey}: ${chunks.length} chunks (${finalText.length} chars total), allOk=${allChunksOk}`);
        }
      }

      // ── Reconciliation: did the user actually receive the full response? ──
      //
      // The streaming code splits Claude's response on `\n\n` boundaries and sends
      // each paragraph as its own Telegram message via editMessageText / ctx.reply.
      // ANY of those calls can fail (Telegram 429, server-side flood, transient
      // network error, malformed-text rejection) — and the old code only logged a
      // warning, leaving the user with a partial or empty conversation.
      //
      // We compute a "delivered" set: the texts we successfully pushed to Telegram
      // (from finalized previous messages + the final chunk). We then check whether
      // they account for ~all of Claude's response. If not, we re-deliver the FULL
      // response through notifyQueue, which has retries, fallback chats, persistent
      // disk queue, and 429 backoff — the reliable path.
      //
      // Why measure "covered ratio" instead of exact match: streaming edits only
      // store the LAST edit per Telegram message (lastEditText), so rapid mid-stream
      // edits to the same message overwrite each other. We can't reconstruct a
      // perfect transcript, but we can detect the failure mode where text is missing.
      const responseTrimmed = (response ?? "").trim();
      const allDelivered = (lastEditText ? [...deliveredFinalized, lastEditText] : deliveredFinalized).join("\n\n");
      const deliveredChars = allDelivered.length;
      const responseChars = responseTrimmed.length;
      const coveredRatio = responseChars === 0 ? 1 : deliveredChars / responseChars;

      // Heuristic: trigger fallback if (a) streaming was outright broken,
      // (b) any individual delivery failed AND we have a real response,
      // (c) we delivered less than 80% of the response chars,
      // (d) the original "no text delivered" condition.
      const shouldFallback =
        responseTrimmed.length > 0 &&
        (
          streamingBroken ||
          (!realTextDelivered) ||
          (deliveryFailures > 0) ||
          (!finalChunkSucceeded && currentMsgText.trim().length > 0) ||
          coveredRatio < 0.8
        );

      if (shouldFallback) {
        logger.error(
          `[bot] Reconciliation FAILED for ${sessionKey}: ` +
          `responseChars=${responseChars}, deliveredChars=${deliveredChars}, ` +
          `coveredRatio=${coveredRatio.toFixed(2)}, deliveryFailures=${deliveryFailures}, ` +
          `streamingBroken=${streamingBroken}, realTextDelivered=${realTextDelivered}, ` +
          `finalChunkSucceeded=${finalChunkSucceeded} — re-delivering via notifyQueue`
        );

        // Tear down any orphaned placeholder if streaming never delivered real text.
        if (currentMsg && !realTextDelivered) {
          await ctx.api.deleteMessage(currentMsg.chat.id, currentMsg.message_id).catch(() => {});
        }

        // Send the FULL response via the persistent queue. notifyQueue handles
        // chunking (4096 limit), 429 backoff, retries, and fallback-chat routing.
        // We tag with "reconcile:" so logs make the cause clear.
        const tag = streamingBroken
          ? `reconcile-broken:${sessionKey}`
          : (!realTextDelivered ? `reconcile-empty:${sessionKey}` : `reconcile-partial:${sessionKey}`);
        await notifyQueue.send({
          chatId: primaryChatId,
          threadId,
          text: responseTrimmed,
          fallbackChatId,
          fallbackThreadId,
          replyToMessageId: batch[0].msgId,
          tag,
        });
      } else if (responseTrimmed.length > 0) {
        // Happy path — log a confirmation so we have an audit trail.
        logger.info(
          `[bot] Delivered ${sessionKey} OK: responseChars=${responseChars}, ` +
          `deliveredChars=${deliveredChars}, coveredRatio=${coveredRatio.toFixed(2)}, ` +
          `failures=${deliveryFailures}`
        );
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
    // Documents we accept:
    //   - images sent as documents (uncompressed photos)  → image content block
    //   - PDFs                                             → text content block (extracted)
    //   - plain text / markdown / csv / json / yaml       → text content block (raw)
    const docMime = msg.document?.mime_type ?? "";
    const docName = msg.document?.file_name ?? "";
    const docExt = docName.split(".").pop()?.toLowerCase() ?? "";
    const hasImageDocument = !!msg.document && docMime.startsWith("image/");
    const hasPdfDocument =
      !!msg.document && (docMime === "application/pdf" || docExt === "pdf");
    const hasTextDocument =
      !!msg.document && (
        docMime.startsWith("text/") ||
        ["txt", "md", "markdown", "csv", "log", "json", "xml", "yaml", "yml"].includes(docExt)
      );
    const hasDocument = hasImageDocument || hasPdfDocument || hasTextDocument;

    // Debug: log what we received
    logger.info(`[bot] Message keys: ${Object.keys(msg).filter(k => !["from","chat","date","message_id"].includes(k)).join(", ")} | hasPhoto=${hasPhoto} hasImageDoc=${hasImageDocument} hasPdfDoc=${hasPdfDocument} hasTextDoc=${hasTextDocument} mime=${docMime}`);

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

    // Build content blocks (download attachment immediately so we don't lose the ctx)
    const contentBlocks: ContentBlock[] = [];
    if (hasPhoto || hasImageDocument) {
      try {
        const imageBlock = await downloadImage(ctx, msg, hasPhoto);
        contentBlocks.push(imageBlock);
      } catch (err) {
        logger.warn(`[bot] Failed to download image: ${err}`);
        contentBlocks.push({ type: "text", text: "[Image could not be loaded]" });
      }
    } else if (hasPdfDocument || hasTextDocument) {
      try {
        const docBlock = await downloadDocumentAsText(ctx, msg);
        contentBlocks.push(docBlock);
      } catch (err) {
        logger.warn(`[bot] Failed to download document: ${err}`);
        const fname = msg.document?.file_name ?? "document";
        contentBlocks.push({
          type: "text",
          text: `[Document received: ${fname}, but could not be loaded]`,
        });
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
    const defaultEmptyText = hasPhoto || hasImageDocument
      ? "(sent an image)"
      : (hasPdfDocument || hasTextDocument)
        ? `(sent a document: ${msg.document?.file_name ?? "document"})`
        : "";
    const pending: PendingMessage = {
      ctx,
      text: text || defaultEmptyText,
      contentBlocks,
      senderName,
      threadId,
      msgId: msg.message_id,
      replyContext,
    };

    // Wrap processBatch so an unhandled throw inside it can't take down the bot.
    // Any uncaught error here would surface as an unhandledRejection that may
    // crash the process; we'd rather log it and keep serving other sessions.
    const safeProcessBatch = (key: string, messages: PendingMessage[]) => {
      processBatch(key, messages).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error ? err.stack : "";
        logger.error(`[bot] UNHANDLED error in processBatch for ${key}: ${msg}${stack ? `\n${stack}` : ""}`);
      });
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
          safeProcessBatch(sessionKey, buf.messages);
        }
      }, MESSAGE_BATCH_DELAY_MS);
    } else {
      // Start new buffer
      const timer = setTimeout(() => {
        const buf = sessionBuffers.get(sessionKey);
        if (buf) {
          sessionBuffers.delete(sessionKey);
          safeProcessBatch(sessionKey, buf.messages);
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
      if (!userId) {
        await ctx.reply("Cannot determine your user ID.", replyOpts);
        return true;
      }
      if (!_scheduler) {
        await ctx.reply("Scheduler not initialized.", replyOpts);
        return true;
      }
      const isAdmin = ADMIN_USERS.includes(userId);
      const allJobs = _scheduler.listJobs();

      // Non-admins only see jobs targeting the chat they're currently in.
      // Admins see everything.
      const jobs = isAdmin
        ? allJobs
        : allJobs.filter((j) => j.chatId === ctx.chat?.id);

      if (jobs.length === 0) {
        await ctx.reply(
          isAdmin ? "No scheduled jobs." : "No scheduled jobs for this chat.",
          replyOpts
        );
      } else {
        const lines = jobs.map((j) => {
          const human = humanizeCron(j.cron);
          const preview = j.prompt
            ? `📝 briefing: ${j.prompt.slice(0, 80)}${j.prompt.length > 80 ? "…" : ""}`
            : `💬 ${j.message.slice(0, 80).replace(/\n/g, " ")}${j.message.length > 80 ? "…" : ""}`;
          const adminExtras = isAdmin ? `\n   Chat: ${j.chatId}${j.topicId ? ` topic ${j.topicId}` : ""}` : "";
          return `${j.enabled ? "✅" : "⏸️"} ${j.name} (${j.id})\n   When: ${human}${adminExtras}\n   ${preview}\n   Next: ${j.nextRun ?? "—"}`;
        });
        const header = isAdmin
          ? `All scheduled jobs (${jobs.length}):`
          : `Your scheduled jobs (${jobs.length}):`;
        await ctx.reply(`${header}\n\n${lines.join("\n\n")}`, replyOpts);
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
        "  /schedules — List your scheduled messages (admins see all)",
        "  /schedule add|add-brief|remove|toggle|reload — Manage schedules (admin)",
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

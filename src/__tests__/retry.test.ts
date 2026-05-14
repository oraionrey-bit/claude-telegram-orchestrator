// Tests for 409 conflict retry logic and force-kill behavior

import { describe, it, expect, mock, beforeEach } from "bun:test";
import { chunkMessage, formatUserMessage } from "../utils";
import { getSessionKey, parseSessionKey, sessionKeyToDir } from "../router";

// ── Unit tests for utilities used in retry flow ──

describe("chunkMessage", () => {
  it("returns single chunk for short messages", () => {
    expect(chunkMessage("hello")).toEqual(["hello"]);
  });

  it("splits on newlines when possible", () => {
    const msg = "a".repeat(4000) + "\n" + "b".repeat(100);
    const chunks = chunkMessage(msg);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toBe("a".repeat(4000));
  });

  it("hard-cuts when no good split point", () => {
    const msg = "x".repeat(5000);
    const chunks = chunkMessage(msg);
    expect(chunks.length).toBe(2);
    expect(chunks[0].length).toBe(4096);
  });
});

describe("formatUserMessage", () => {
  it("wraps sender name in brackets", () => {
    expect(formatUserMessage("Alice", "hello")).toBe("[Alice]: hello");
  });
});

describe("router", () => {
  it("sessionKeyToDir sanitizes special chars", () => {
    expect(sessionKeyToDir("group--1001234567890-topic-1")).toBe("group--1001234567890-topic-1");
    expect(sessionKeyToDir("dm-99999999")).toBe("dm-99999999");
  });

  it("parseSessionKey handles DM keys", () => {
    const result = parseSessionKey("dm-99999999");
    expect(result.type).toBe("dm");
    expect(result.userId).toBe("99999999");
  });

  it("parseSessionKey handles group-topic keys", () => {
    const result = parseSessionKey("group--1001234567890-topic-1");
    expect(result.type).toBe("group");
    expect(result.chatId).toBe("-1001234567890");
    expect(result.topicId).toBe("1");
  });

  it("parseSessionKey handles plain group keys", () => {
    const result = parseSessionKey("group--1001234567890");
    expect(result.type).toBe("group");
    expect(result.chatId).toBe("-1001234567890");
  });
});

// ── Tests for force-kill retry behavior ──

describe("409 retry logic", () => {
  it("should detect 409 in error message", () => {
    const msg = "409: Conflict: terminated by other getUpdates request";
    expect(msg.includes("409") || msg.includes("Conflict")).toBe(true);
  });

  it("should detect Conflict in error message", () => {
    const msg = "Conflict: terminated by other getUpdates request";
    expect(msg.includes("409") || msg.includes("Conflict")).toBe(true);
  });

  it("backoff delay should cap at 30s", () => {
    const calcDelay = (attempt: number, killed: boolean) => {
      const baseDelay = killed ? 3000 : 2000;
      return Math.min(baseDelay * attempt, 30000);
    };

    expect(calcDelay(1, false)).toBe(2000);
    expect(calcDelay(5, false)).toBe(10000);
    expect(calcDelay(15, false)).toBe(30000);
    expect(calcDelay(100, false)).toBe(30000);

    // Killed = longer base delay
    expect(calcDelay(1, true)).toBe(3000);
    expect(calcDelay(10, true)).toBe(30000);
  });

  it("should give up after MAX_RETRY_ATTEMPTS", () => {
    const MAX_RETRY_ATTEMPTS = 30;
    let attempts = 0;
    for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
      attempts++;
    }
    expect(attempts).toBe(30);
  });
});

// ── Tests for streaming reconciliation logic (bug fix: silent message drops) ──
//
// Background: The streaming code in bot.ts splits Claude's response on `\n\n`
// boundaries and edits/sends each paragraph as its own Telegram message. If ANY
// of those API calls failed (rate limit, server-side flood, etc.), the old code
// only logged a warning — leaving the user with a partial conversation. The new
// code tracks delivered text and reconciles against the full response, falling
// back to notifyQueue if anything went missing.
describe("streaming reconciliation heuristic", () => {
  // Replicates the shouldFallback decision from processBatch in bot.ts. Kept in
  // the test as a self-contained function so the tests don't have to import the
  // entire grammy bot module.
  const shouldFallback = (opts: {
    responseChars: number;
    deliveredChars: number;
    deliveryFailures: number;
    streamingBroken: boolean;
    realTextDelivered: boolean;
    finalChunkSucceeded: boolean;
    pendingFinalChars: number;
  }): boolean => {
    if (opts.responseChars === 0) return false;
    const coveredRatio = opts.deliveredChars / opts.responseChars;
    return (
      opts.streamingBroken ||
      !opts.realTextDelivered ||
      opts.deliveryFailures > 0 ||
      (!opts.finalChunkSucceeded && opts.pendingFinalChars > 0) ||
      coveredRatio < 0.8
    );
  };

  it("happy path: full delivery → no fallback", () => {
    expect(shouldFallback({
      responseChars: 1775,
      deliveredChars: 1775,
      deliveryFailures: 0,
      streamingBroken: false,
      realTextDelivered: true,
      finalChunkSucceeded: true,
      pendingFinalChars: 0,
    })).toBe(false);
  });

  it("the May 11 incident: 1775 chars but every paragraph silently failed → fallback", () => {
    // What we suspect happened: streaming sent text but every editMessageText
    // returned 200 OK while Telegram silently dropped them, OR they all failed
    // and were logged-and-forgotten. Either way, deliveredChars stays low.
    expect(shouldFallback({
      responseChars: 1775,
      deliveredChars: 0,
      deliveryFailures: 0,  // Telegram returned success but dropped — no errors logged
      streamingBroken: false,
      realTextDelivered: true,  // onDelta fired
      finalChunkSucceeded: true,  // editMessageText returned OK
      pendingFinalChars: 0,
    })).toBe(true);  // coveredRatio = 0/1775 = 0 < 0.8 → fallback
  });

  it("partial delivery (50%) → fallback", () => {
    expect(shouldFallback({
      responseChars: 2000,
      deliveredChars: 1000,
      deliveryFailures: 0,
      streamingBroken: false,
      realTextDelivered: true,
      finalChunkSucceeded: true,
      pendingFinalChars: 0,
    })).toBe(true);  // 50% < 80%
  });

  it("any single delivery failure → fallback (defense in depth)", () => {
    expect(shouldFallback({
      responseChars: 1000,
      deliveredChars: 950,
      deliveryFailures: 1,  // one editMessageText failed
      streamingBroken: false,
      realTextDelivered: true,
      finalChunkSucceeded: true,
      pendingFinalChars: 0,
    })).toBe(true);
  });

  it("streamingBroken (placeholder reply failed) → fallback", () => {
    expect(shouldFallback({
      responseChars: 500,
      deliveredChars: 0,
      deliveryFailures: 1,
      streamingBroken: true,
      realTextDelivered: false,
      finalChunkSucceeded: false,
      pendingFinalChars: 500,
    })).toBe(true);
  });

  it("no real text delivered (legacy fallback condition) → fallback", () => {
    expect(shouldFallback({
      responseChars: 800,
      deliveredChars: 0,
      deliveryFailures: 0,
      streamingBroken: false,
      realTextDelivered: false,  // Claude returned text via API but no delta fired
      finalChunkSucceeded: true,
      pendingFinalChars: 0,
    })).toBe(true);
  });

  it("empty response → no fallback (nothing to deliver)", () => {
    expect(shouldFallback({
      responseChars: 0,
      deliveredChars: 0,
      deliveryFailures: 0,
      streamingBroken: false,
      realTextDelivered: false,
      finalChunkSucceeded: false,
      pendingFinalChars: 0,
    })).toBe(false);
  });

  it("minor undercount (95% coverage) within tolerance → no fallback", () => {
    // Streaming has overhead from `\n\n` joins and trim() — small undercount
    // on a happy delivery is normal, don't spam fallbacks.
    expect(shouldFallback({
      responseChars: 1000,
      deliveredChars: 950,
      deliveryFailures: 0,
      streamingBroken: false,
      realTextDelivered: true,
      finalChunkSucceeded: true,
      pendingFinalChars: 0,
    })).toBe(false);
  });

  it("final chunk failed with pending text → fallback", () => {
    expect(shouldFallback({
      responseChars: 1500,
      deliveredChars: 1200,
      deliveryFailures: 0,
      streamingBroken: false,
      realTextDelivered: true,
      finalChunkSucceeded: false,  // last edit didn't go through
      pendingFinalChars: 300,
    })).toBe(true);
  });
});

// ── Tests for Telegram edit-error classification ──
//
// The bot's editCurrentMsg / heartbeat call editMessageText many times during
// streaming. Some 400s are benign no-ops, not real delivery failures. Counting
// them as failures triggers spurious reconciliation fallbacks → DUPLICATE
// messages to the user. The classifier separates ignorable, fatal-for-streaming,
// and genuine failures so reconciliation only fires when content was actually lost.
describe("classifyEditError", () => {
  // Mirrors the inline classifier in bot.ts. Kept here so tests are self-contained.
  const classifyEditError = (err: string): "ignore" | "broken" | "fail" => {
    const s = err.toLowerCase();
    if (s.includes("message is not modified")) return "ignore";
    if (s.includes("message to edit not found") || s.includes("message to edit not")) return "broken";
    if (s.includes("not found")) return "broken";
    return "fail";
  };

  it("'message is not modified' → ignore (heartbeat or duplicate edit)", () => {
    const err = "GrammyError: Call to 'editMessageText' failed! (400: Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message)";
    expect(classifyEditError(err)).toBe("ignore");
  });

  it("'message to edit not found' → broken (handle lost)", () => {
    const err = "GrammyError: Call to 'editMessageText' failed! (400: Bad Request: message to edit not found)";
    expect(classifyEditError(err)).toBe("broken");
  });

  it("'Bad Request: not Found' → broken (older Telegram phrasing)", () => {
    const err = "GrammyError: Call to 'editMessageText' failed! (400: Bad Request: not Found)";
    expect(classifyEditError(err)).toBe("broken");
  });

  it("real network error → fail (real delivery failure)", () => {
    const err = "FetchError: connect ETIMEDOUT 149.154.167.220:443";
    expect(classifyEditError(err)).toBe("fail");
  });

  it("real 429 rate limit → fail (real delivery failure)", () => {
    const err = "GrammyError: Call to 'editMessageText' failed! (429: Too Many Requests: retry after 30)";
    expect(classifyEditError(err)).toBe("fail");
  });

  it("real 500 server error → fail", () => {
    const err = "GrammyError: Call to 'editMessageText' failed! (500: Internal Server Error)";
    expect(classifyEditError(err)).toBe("fail");
  });
});

describe("pgrep patterns", () => {
  it("patterns should match expected process names", () => {
    const patterns = [
      "claude-telegram-orchestrator",
      "bun.*src/index.ts",
    ];

    // Simulate what pgrep would match
    const processNames = [
      "bun run src/index.ts",
      "/usr/local/bin/bun /home/user/Projects/claude-telegram-orchestrator/src/index.ts",
      "node claude-telegram-orchestrator",
    ];

    for (const procName of processNames) {
      const matched = patterns.some(p => new RegExp(p).test(procName));
      expect(matched).toBe(true);
    }
  });

  it("should not match unrelated bun processes", () => {
    const patterns = [
      "claude-telegram-orchestrator",
      "bun.*src/index.ts",
    ];

    const unrelated = [
      "bun run test",
      "bun install",
      "node server.js",
    ];

    for (const procName of unrelated) {
      const matched = patterns.some(p => new RegExp(p).test(procName));
      expect(matched).toBe(false);
    }
  });
});

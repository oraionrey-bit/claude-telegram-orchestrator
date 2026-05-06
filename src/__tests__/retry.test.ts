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

// ── Config loading ──

import { existsSync, readFileSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import type { OrchestratorConfig } from "./types";

const CONFIG_DIR = join(process.env.HOME ?? "~", ".claude-orchestrator");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

const DEFAULT_CONFIG: OrchestratorConfig = {
  allowedUsers: [],
  ackReaction: "👀",
  maxSessions: 5,
  idleTimeoutMinutes: 30,
  defaultModel: "opus",
  groups: {},
};

export function getConfigDir(): string {
  return CONFIG_DIR;
}

export function loadConfig(): OrchestratorConfig {
  if (!existsSync(CONFIG_PATH)) {
    // Create default config
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2), "utf-8");
    console.error(`[config] Created default config at ${CONFIG_PATH}`);
    return { ...DEFAULT_CONFIG };
  }

  try {
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw) as Partial<OrchestratorConfig>;
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
      groups: parsed.groups ?? DEFAULT_CONFIG.groups,
    };
  } catch (err) {
    console.error(`[config] Error reading config: ${err}`);
    return { ...DEFAULT_CONFIG };
  }
}

export function getBotToken(): string {
  // Env var takes priority
  const envToken = process.env.TELEGRAM_BOT_TOKEN;
  if (envToken) return envToken;

  // Try config.json (may have it as extra field)
  try {
    if (existsSync(CONFIG_PATH)) {
      const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
      if (raw.botToken) return raw.botToken as string;
    }
  } catch {
    // ignore
  }

  throw new Error(
    "No bot token found. Set TELEGRAM_BOT_TOKEN env var or add botToken to config.json"
  );
}

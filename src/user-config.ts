// ── Per-user notification mode configuration ──

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { getConfigDir } from "./config";

const USER_CONFIGS_PATH = join(getConfigDir(), "user-configs.json");

export interface UserConfig {
  /** If true, suppress all streaming/typing/progress — only send final response */
  completionOnly: boolean;
}

const DEFAULT_USER_CONFIG: UserConfig = {
  completionOnly: false,
};

let configs: Record<string, UserConfig> = {};

export function loadUserConfigs(): void {
  try {
    if (existsSync(USER_CONFIGS_PATH)) {
      const raw = readFileSync(USER_CONFIGS_PATH, "utf-8");
      configs = JSON.parse(raw) as Record<string, UserConfig>;
    }
  } catch {
    configs = {};
  }
}

function saveUserConfigs(): void {
  try {
    writeFileSync(USER_CONFIGS_PATH, JSON.stringify(configs, null, 2), "utf-8");
  } catch {
    // Don't crash
  }
}

export function getUserConfig(userId: string): UserConfig {
  return { ...DEFAULT_USER_CONFIG, ...(configs[userId] ?? {}) };
}

export function setUserConfig(userId: string, update: Partial<UserConfig>): UserConfig {
  configs[userId] = { ...DEFAULT_USER_CONFIG, ...(configs[userId] ?? {}), ...update };
  saveUserConfigs();
  return configs[userId];
}

/**
 * Get config for a session key. Extracts user ID from DM keys (dm-{userId}).
 * For group sessions, uses the sender's user ID if provided.
 */
export function getUserConfigForSession(sessionKey: string, senderId?: string): UserConfig {
  if (sessionKey.startsWith("dm-")) {
    const userId = sessionKey.slice(3);
    return getUserConfig(userId);
  }
  if (senderId) {
    return getUserConfig(senderId);
  }
  return { ...DEFAULT_USER_CONFIG };
}

// ── Types ──

export interface OrchestratorConfig {
  allowedUsers: string[];
  ackReaction: string;
  maxSessions: number;
  idleTimeoutMinutes: number;
  defaultModel: string;
  availableModels?: string[];
  groups: Record<string, GroupConfig>;
}

export interface GroupConfig {
  enabled: boolean;
  requireMention: boolean;
  mentionPatterns: string[];
}

export interface SessionInfo {
  key: string;
  proc: ReturnType<typeof Bun.spawn> | null;
  sessionId: string | null;
  lastActivity: number;
  messageCount: number;
  workDir: string;
}

export interface ClaudeStreamEvent {
  type: string;
  subtype?: string;
  session_id?: string;
  message?: {
    id?: string;
    role?: string;
    content?: Array<{
      type: string;
      text?: string;
      name?: string;
      input?: unknown;
    }>;
  };
  content_block?: {
    type: string;
    text?: string;
  };
  delta?: {
    type?: string;
    text?: string;
    partial_json?: string;
  };
  index?: number;
  is_error?: boolean;
  duration_ms?: number;
  result?: string;  // The full assistant response text (on result events)
  total_cost_usd?: number;
  error?: {
    message?: string;
    type?: string;
  };
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } };

export interface ClaudeStreamInput {
  type: "user";
  message: {
    role: "user";
    content: ContentBlock[];
  };
}

export interface PendingMessage {
  chatId: number;
  messageId: number;
  threadId: number | undefined;
  text: string;
  senderName: string;
}

export interface ScheduleJob {
  id: string;
  name: string;
  cron: string;
  chatId: number;
  topicId?: number;
  message: string;
  enabled: boolean;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

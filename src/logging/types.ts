export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogCategory =
  | "lifecycle"
  | "message"
  | "persistence"
  | "context"
  | "agent_turn"
  | "llm_provider"
  | "tool"
  | "gateway"
  | "command"
  | "system";

export interface SerializedLogError {
  name?: string;
  message: string;
  code?: string;
  stack?: string;
}

export interface LogEvent {
  id: string;
  ts: number;
  level: LogLevel;
  category: LogCategory;
  event: string;
  sessionId?: string;
  turnId?: string;
  messageId?: string;
  component: string;
  summary: string;
  data?: Record<string, unknown>;
  error?: SerializedLogError;
}

export type LogInput = Omit<LogEvent, "id" | "ts" | "level" | "error"> & {
  error?: unknown;
};

export interface LoggingConfig {
  level: LogLevel;
  persist: boolean;
  path: string;
  maxEntries: number;
  maxAgeMs?: number;
  compactEveryWrites: number;
  compactIntervalMs: number;
  debugEvents: boolean;
  redactMessageText: boolean;
  messagePreviewChars: number;
  includeStack: boolean;
}

export interface Logger extends Pick<Console, "debug" | "info" | "warn" | "error"> {
  debug(input?: string | LogInput, ...args: unknown[]): void;
  info(input?: string | LogInput, ...args: unknown[]): void;
  warn(input?: string | LogInput, ...args: unknown[]): void;
  error(input?: string | LogInput, ...args: unknown[]): void;
  flush(): Promise<void>;
}

export interface LogStore {
  append(event: LogEvent): void;
  flush(): Promise<void>;
}

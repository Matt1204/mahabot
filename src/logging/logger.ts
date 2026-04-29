import { isAbsolute, resolve } from "node:path";

import type { LogEvent, LogInput, Logger, LoggingConfig, LogLevel, LogStore } from "./types.js";
import { ConsoleLogSink } from "./consoleLogSink.js";
import { NdjsonLogStore } from "./ndjsonLogStore.js";
import { sanitizeLogData, serializeLogError } from "./logRedaction.js";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface CreateLoggerOptions {
  config: LoggingConfig;
  persistenceRoot: string;
  sessionId?: string;
  now?: () => number;
  consoleLike?: Pick<Console, "debug" | "info" | "warn" | "error">;
}

export function createLogger(options: CreateLoggerOptions): Logger {
  const now = options.now ?? (() => Date.now());
  const consoleSink = new ConsoleLogSink(options.consoleLike);
  const stores: LogStore[] = [];

  if (options.config.persist) {
    stores.push(
      new NdjsonLogStore({
        path: resolveLogPath(options.persistenceRoot, options.config.path),
        maxEntries: options.config.maxEntries,
        maxAgeMs: options.config.maxAgeMs,
        compactEveryWrites: options.config.compactEveryWrites,
        compactIntervalMs: options.config.compactIntervalMs,
        now,
        onInternalError: (error) => {
          options.consoleLike?.error?.("[mahabot] logging store error", error);
        },
      })
    );
  }

  return new StructuredLogger({
    config: options.config,
    sessionId: options.sessionId,
    now,
    consoleSink,
    stores,
  });
}

class StructuredLogger implements Logger {
  constructor(
    private readonly options: {
      config: LoggingConfig;
      sessionId?: string;
      now: () => number;
      consoleSink: ConsoleLogSink;
      stores: LogStore[];
    }
  ) {}

  debug(input?: string | LogInput, ...args: unknown[]): void {
    this.write("debug", input, args);
  }

  info(input?: string | LogInput, ...args: unknown[]): void {
    this.write("info", input, args);
  }

  warn(input?: string | LogInput, ...args: unknown[]): void {
    this.write("warn", input, args);
  }

  error(input?: string | LogInput, ...args: unknown[]): void {
    this.write("error", input, args);
  }

  async flush(): Promise<void> {
    await Promise.all(this.options.stores.map((store) => store.flush()));
  }

  private write(level: LogLevel, input: string | LogInput | undefined, args: unknown[]): void {
    if (!this.shouldLog(level)) {
      return;
    }

    const event = this.toEvent(level, input, args);
    this.options.consoleSink.write(event);

    if (level === "debug" && !this.options.config.debugEvents) {
      return;
    }

    for (const store of this.options.stores) {
      store.append(event);
    }
  }

  private shouldLog(level: LogLevel): boolean {
    return LEVEL_ORDER[level] >= LEVEL_ORDER[this.options.config.level];
  }

  private toEvent(level: LogLevel, input: string | LogInput | undefined, args: unknown[]): LogEvent {
    if (input && typeof input === "object") {
      return {
        id: createLogId(this.options.now),
        ts: this.options.now(),
        level,
        category: input.category,
        event: input.event,
        sessionId: input.sessionId ?? this.options.sessionId,
        turnId: input.turnId,
        messageId: input.messageId,
        component: input.component,
        summary: input.summary,
        data: sanitizeLogData(input.data),
        error:
          input.error === undefined
            ? undefined
            : serializeLogError(input.error, this.options.config.includeStack),
      };
    }

    return {
      id: createLogId(this.options.now),
      ts: this.options.now(),
      level,
      category: "system",
      event: `legacy.${level}`,
      sessionId: this.options.sessionId,
      component: "legacy_console",
      summary: formatLegacyMessage(input, args),
    };
  }
}

export function createNoopLogger(): Logger {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    flush: async () => undefined,
  };
}

function createLogId(now: () => number): string {
  return `log_${now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function formatLegacyMessage(input: string | undefined, args: unknown[]): string {
  const parts = [input, ...args].filter((part) => part !== undefined).map((part) => String(part));
  return parts.join(" ");
}

function resolveLogPath(persistenceRoot: string, configuredPath: string): string {
  const trimmed = configuredPath.trim();
  if (isAbsolute(trimmed)) {
    return trimmed;
  }
  const withoutPersistencePrefix = trimmed.replace(/^persistence[\\/]/, "");
  return resolve(persistenceRoot, withoutPersistencePrefix);
}

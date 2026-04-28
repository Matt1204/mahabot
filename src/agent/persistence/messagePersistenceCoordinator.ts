import type { AgentMessage } from "@mariozechner/pi-agent-core";

import type { MessagePersistenceConfig } from "../types.js";
import { SqliteMessageStore } from "./sqliteMessageStore.js";
import { buildAlignedTailWindow, buildStartupRestoreWindow } from "./windowAlignment.js";

interface MessagePersistenceCoordinatorDeps {
  logger?: Pick<Console, "debug" | "info" | "warn" | "error">;
}

interface CompactResult {
  didCompact: boolean;
  messages: AgentMessage[];
  persistedCursor: number;
}

interface PersistResult {
  persistedCount: number;
  persistedCursor: number;
}

export interface ContextBudgetSnapshot {
  curContextSize: number;
  lowWaterMark: number;
  highWaterMark: number;
}

export class MessagePersistenceCoordinator {
  private readonly logger: Pick<Console, "debug" | "info" | "warn" | "error">;
  private readonly store: SqliteMessageStore;

  // Runtime-only cursor over current in-memory runtime messages.
  private persistedCursor = 0;
  private curContextSize: number = 0;

  constructor(
    private readonly config: MessagePersistenceConfig,
    deps: MessagePersistenceCoordinatorDeps = {}
  ) {
    this.logger = deps.logger ?? console;
    this.store = new SqliteMessageStore({
      sessionId: config.sessionId,
      sessionDbPath: config.sessionDbPath,
    }, {
      logger: this.logger,
    });
  }

  async loadPersistedContextWindow(
    currentMessages: AgentMessage[]
  ): Promise<{ messages: AgentMessage[]; persistedCursor: number }> {
    if (!this.config.enabled) {
      this.persistedCursor = 0;
      return { messages: currentMessages, persistedCursor: this.persistedCursor };
    }

    if (currentMessages.length > 0) {
      this.persistedCursor = 0;
      return { messages: currentMessages, persistedCursor: this.persistedCursor };
    }

    try {
      const start = Date.now();
      const records = await this.store.readAll();
      const restored = buildStartupRestoreWindow(
        records.map((record) => record.message),
        this.config.startupRestoreMessageCount
      );
      this.persistedCursor = restored.length;
      this.logger.info?.({
        category: "persistence",
        event: "persistence.msg_restore_complete",
        component: "MessagePersistenceCoordinator",
        sessionId: this.config.sessionId,
        summary: "message persistence window restored",
        data: {
          storePath: this.config.sessionDbPath,
          readRows: records.length,
          restoredMessages: restored.length,
          persistedCursor: this.persistedCursor,
          durationMs: Date.now() - start,
        },
      } as any);
      return { messages: restored, persistedCursor: this.persistedCursor };
    } catch (error) {
      this.logger.warn({
        category: "persistence",
        event: "persistence.msg_restore_failed",
        component: "MessagePersistenceCoordinator",
        sessionId: this.config.sessionId,
        summary: "message persistence restore failed, starting without history",
        data: {
          storePath: this.config.sessionDbPath,
        },
        error,
      } as any);
      this.persistedCursor = 0;
      return { messages: currentMessages, persistedCursor: this.persistedCursor };
    }
  }

  noteTurnUsage(totalTokens: number | { totalTokens?: number }): ContextBudgetSnapshot {
    // Accept both legacy usage object and direct numeric token count.
    // This keeps coordinator callers simple across refactor boundaries.
    const normalizedTotal =
      typeof totalTokens === "number" ? totalTokens : totalTokens.totalTokens ?? 0;
    this.curContextSize = normalizedTotal;
    return this.getContextBudgetSnapshot();
  }

  getContextBudgetSnapshot(): ContextBudgetSnapshot {
    return {
      curContextSize: this.curContextSize,
      lowWaterMark: this.config.compactLowWatermarkTokens,
      highWaterMark: this.config.compactHighWatermarkTokens,
    };
  }

  // On "turn_end" event, check if context size is above high watermark => compact the context.
  async compactContextIfNeeded(messages: AgentMessage[]): Promise<CompactResult> {
    if (!this.config.enabled) {
      return { didCompact: false, messages, persistedCursor: this.persistedCursor };
    }

    // const this.curContextSize = this.curContextSize;
    if (this.curContextSize < this.config.compactHighWatermarkTokens) {
      this.logger.debug?.({
        category: "context",
        event: "context.compact_skipped",
        component: "MessagePersistenceCoordinator",
        sessionId: this.config.sessionId,
        summary: "context compaction skipped below high watermark",
        data: {
          reason: "below_high_watermark",
          curContextSize: this.curContextSize,
          highWatermark: this.config.compactHighWatermarkTokens,
          messageCount: messages.length,
        },
      } as any);
      return { didCompact: false, messages, persistedCursor: this.persistedCursor };
    }
    if (messages.length === 0) {
      return { didCompact: false, messages, persistedCursor: this.persistedCursor };
    }

    const ratio = this.config.compactLowWatermarkTokens / Math.max(this.curContextSize, 1);
    const targetKeepApprox: number = Math.ceil(messages.length * ratio);
    const targetKeep: number = clamp(targetKeepApprox, 1, messages.length);
    const compactedMessages = buildAlignedTailWindow(messages, targetKeep);
    this.logger.info?.({
      category: "context",
      event: "context.compact_triggered",
      component: "MessagePersistenceCoordinator",
      sessionId: this.config.sessionId,
      summary: "context compaction triggered",
      data: {
        curContextSize: this.curContextSize,
        lowWatermark: this.config.compactLowWatermarkTokens,
        highWatermark: this.config.compactHighWatermarkTokens,
        beforeCount: messages.length,
        targetKeep,
      },
    } as any);

    if (compactedMessages.length === 0 || compactedMessages.length >= messages.length) {
      return { didCompact: false, messages, persistedCursor: this.persistedCursor };
    }

    // Persist first so compaction never drops unpersisted messages.
    const persistResult = await this.persistPendingMessages(messages);
    if (persistResult.persistedCursor !== messages.length) {
      this.logger.warn?.({
        category: "context",
        event: "context.compact_blocked",
        component: "MessagePersistenceCoordinator",
        sessionId: this.config.sessionId,
        summary: "context compaction blocked because pending messages were not fully persisted",
        data: {
          persistedCursor: persistResult.persistedCursor,
          messageCount: messages.length,
        },
      } as any);
      return { didCompact: false, messages, persistedCursor: this.persistedCursor };
    }

    const droppedCount = messages.length - compactedMessages.length;
    this.persistedCursor = Math.max(0, this.persistedCursor - droppedCount);

    return {
      didCompact: true,
      messages: compactedMessages,
      persistedCursor: this.persistedCursor,
    };
  }

  // When compacting context or agent is stopped, persist the messages.
  async persistPendingMessages(messages: AgentMessage[]): Promise<PersistResult> {
    if (!this.config.enabled) {
      this.persistedCursor = 0;
      return { persistedCount: 0, persistedCursor: this.persistedCursor };
    }

    const boundedCursor = clamp(this.persistedCursor, 0, messages.length);
    const pendingMessages = messages.slice(boundedCursor);
    if (pendingMessages.length === 0) {
      this.persistedCursor = boundedCursor;
      return { persistedCount: 0, persistedCursor: this.persistedCursor };
    }

    try {
      const start = Date.now();
      this.logger.debug?.({
        category: "persistence",
        event: "persistence.msg_append_start",
        component: "MessagePersistenceCoordinator",
        sessionId: this.config.sessionId,
        summary: "message append started",
        data: {
          pendingCount: pendingMessages.length,
          boundedCursor,
          runtimeMessageCount: messages.length,
          storePath: this.config.sessionDbPath,
        },
      } as any);
      const persistedCount = await this.store.appendMessages(pendingMessages);
      this.persistedCursor = boundedCursor + persistedCount;
      this.logger.info?.({
        category: "persistence",
        event: "persistence.msg_append_complete",
        component: "MessagePersistenceCoordinator",
        sessionId: this.config.sessionId,
        summary: "message append completed",
        data: {
          persistedCount,
          persistedCursor: this.persistedCursor,
          durationMs: Date.now() - start,
          storePath: this.config.sessionDbPath,
        },
      } as any);
      return { persistedCount, persistedCursor: this.persistedCursor };
    } catch (error) {
      this.logger.error({
        category: "persistence",
        event: "persistence.msg_append_failed",
        component: "MessagePersistenceCoordinator",
        sessionId: this.config.sessionId,
        summary: "message append failed",
        data: {
          pendingCount: pendingMessages.length,
          boundedCursor,
          storePath: this.config.sessionDbPath,
        },
        error,
      } as any);
      this.persistedCursor = boundedCursor;
      return { persistedCount: 0, persistedCursor: this.persistedCursor };
    }
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

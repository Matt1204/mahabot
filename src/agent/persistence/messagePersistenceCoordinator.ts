import type { AgentMessage } from "@mariozechner/pi-agent-core";

import type { MessagePersistenceConfig } from "../types.js";
import { JsonlMessageStore } from "./jsonlMessageStore.js";
import { buildAlignedTailWindow, buildStartupRestoreWindow } from "./windowAlignment.js";

interface MessagePersistenceCoordinatorDeps {
  logger?: Pick<Console, "warn" | "error">;
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
  private readonly logger: Pick<Console, "warn" | "error">;
  private readonly store: JsonlMessageStore;

  // Runtime-only cursor over current in-memory runtime messages.
  private persistedCursor = 0;
  private curContextSize: number = 0;

  constructor(
    private readonly config: MessagePersistenceConfig,
    deps: MessagePersistenceCoordinatorDeps = {}
  ) {
    this.logger = deps.logger ?? console;
    this.store = new JsonlMessageStore({
      sessionId: config.sessionId,
      sessionJsonlPath: config.sessionJsonlPath,
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
      const records = await this.store.readAll();
      const restored = buildStartupRestoreWindow(
        records.map((record) => record.message),
        this.config.startupRestoreMessageCount
      );
      this.persistedCursor = restored.length;
      return { messages: restored, persistedCursor: this.persistedCursor };
    } catch (error) {
      this.logger.warn(`[message persistence] restore failed, starting without history: ${String(error)}`);
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
      return { didCompact: false, messages, persistedCursor: this.persistedCursor };
    }
    if (messages.length === 0) {
      return { didCompact: false, messages, persistedCursor: this.persistedCursor };
    }

    const ratio = this.config.compactLowWatermarkTokens / Math.max(this.curContextSize, 1);
    const targetKeepApprox: number = Math.ceil(messages.length * ratio);
    const targetKeep: number = clamp(targetKeepApprox, 1, messages.length);
    const compactedMessages = buildAlignedTailWindow(messages, targetKeep);

    if (compactedMessages.length === 0 || compactedMessages.length >= messages.length) {
      return { didCompact: false, messages, persistedCursor: this.persistedCursor };
    }

    // Persist first so compaction never drops unpersisted messages.
    const persistResult = await this.persistPendingMessages(messages);
    if (persistResult.persistedCursor !== messages.length) {
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
      const persistedCount = await this.store.appendMessages(pendingMessages);
      this.persistedCursor = boundedCursor + persistedCount;
      return { persistedCount, persistedCursor: this.persistedCursor };
    } catch (error) {
      this.logger.error(`[message persistence] append failed: ${String(error)}`);
      this.persistedCursor = boundedCursor;
      return { persistedCount: 0, persistedCursor: this.persistedCursor };
    }
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

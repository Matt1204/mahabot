import type { Agent as PiAgentRuntime, AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";
import { createModelFromConfig } from "../config/modelFactory.js";
import { assembleTools, ToolRegistry } from "./tools/index.js";

import {
  parseAgentResponseToOutboundTemp,
  parseToMsgForCliTemp,
  toAgentMessages,
  wrapPartsToInboundMessageTemp,
  wrapToInboundMessageTemp,
} from "./mappers/message.mapper.js";
import { createAgentRuntime as createPiAgentRuntime } from "./runtime/agentRuntimeFactory.js";
import type {
  AgentDependencies,
  AgentFromAppConfigInput,
  AgentRuntimeConfig,
  AgentRuntimeLifecycleSnapshot,
  AppliedAgentConfigSnapshot,
  CliTurnResult,
  InboundMessageTemp,
  MemoryBundle,
  OutboundMessageTemp,
  RuntimeContextSnapshot,
  UserTurnInput,
} from "./types.js";
import {
  MessagePersistenceCoordinator,
  type ContextBudgetSnapshot,
} from "./persistence/messagePersistenceCoordinator.js";

export class Agent {
  private readonly agentRuntime: PiAgentRuntime;
  private readonly logger: Pick<Console, "debug" | "info" | "warn" | "error">;
  private readonly now: () => number;
  private readonly inboundSource?: (signal?: AbortSignal) => Promise<InboundMessageTemp | null>;
  private readonly outboundSink?: (message: OutboundMessageTemp) => Promise<void> | void;
  private readonly memoryAssembler?: (input: InboundMessageTemp) => Promise<MemoryBundle>;
  private readonly onAgentEvent?: (event: AgentEvent) => void;
  private readonly messagePersistenceCoordinator?: MessagePersistenceCoordinator;
  private readonly appliedConfig: AppliedAgentConfigSnapshot;
  private readonly persistenceEnabled: boolean;
  private readonly startupRestoreMessageCount: number;

  private running = false;
  private loopAbortController: AbortController | null = null;
  private serialQueue: Promise<void> = Promise.resolve();
  private readonly persistedContextLoadPromise: Promise<void>;
  private readonly contextWatermarks?: {
    compactLowWatermarkTokens: number;
    compactHighWatermarkTokens: number;
  };
  private activeTurnCount = 0;

  /**
   * Static builder for composing runtime dependencies from app-level config.
   * Responsibility split:
   * - this method resolves model/credentials/tools from AppConfig.
   * - constructor only receives fully resolved AgentRuntimeConfig and wires runtime lifecycle.
   */
  static createFromAppConfig(input: AgentFromAppConfigInput, deps: AgentDependencies = {}): Agent {
    // 1. create model
    const model = createModelFromConfig(input.appConfig, input.providerName, input.modelName);
    input.ensureProviderCredentials?.(model.provider);

    // 2. assemble tools through the central tool-assembly seam
    const toolRegistry = input.toolRegistry ?? new ToolRegistry();
    if (!input.toolRegistry) {
      assembleTools(toolRegistry, input.appConfig);
    }

    const agentRuntimeConfig: AgentRuntimeConfig = {
      model,
      systemPrompt: input.systemPrompt,
      thinkingLevel: input.thinkingLevel,
      toolRegistry,
      getApiKey: input.getApiKey,
      appliedConfig: createAppliedAgentConfigSnapshot(
        model,
        input.providerName,
        input.modelName,
        input.thinkingLevel
      ),
    };

    // 3. instantiate the agent
    return new Agent(agentRuntimeConfig, deps);
  }

  constructor(agentRuntimeConfig: AgentRuntimeConfig, deps: AgentDependencies = {}) {
    this.agentRuntime = createPiAgentRuntime(agentRuntimeConfig);
    this.logger = deps.logger ?? console;
    this.now = deps.now ?? (() => Date.now());
    this.inboundSource = deps.inboundSource;
    this.outboundSink = deps.outboundSink;
    this.memoryAssembler = deps.memoryAssembler;
    this.onAgentEvent = deps.onAgentEvent;
    this.appliedConfig =
      agentRuntimeConfig.appliedConfig ??
      createAppliedAgentConfigSnapshot(
        agentRuntimeConfig.model,
        "unknown",
        "unknown",
        agentRuntimeConfig.thinkingLevel
      );
    this.persistenceEnabled = deps.messagePersistence?.enabled ?? false;
    this.startupRestoreMessageCount = deps.messagePersistence?.startupRestoreMessageCount ?? 0;
    this.messagePersistenceCoordinator = deps.messagePersistence
      ? new MessagePersistenceCoordinator(deps.messagePersistence, {
          logger: this.logger,
        })
      : undefined;
    this.contextWatermarks = deps.messagePersistence
      ? {
          compactLowWatermarkTokens: deps.messagePersistence.compactLowWatermarkTokens,
          compactHighWatermarkTokens: deps.messagePersistence.compactHighWatermarkTokens,
        }
      : undefined;

    // Load persisted context exactly once as part of startup, right after runtime/deps are ready.
    this.persistedContextLoadPromise = this.restorePersistedContextOnStartup();
    // Ensure first queued turn waits for startup restore before prompt().
    this.serialQueue = this.persistedContextLoadPromise.then(
      () => undefined,
      () => undefined
    );

    // Keep this subscription always on so observers can project runtime events to MessageBus.
    // The callback must never throw into the agent loop.
    this.agentRuntime.subscribe((event) => {
      this.logger.debug(`[pi-mono event] ${String((event as any).type)}`);
      let eventForInspection: AgentEvent = event;

      // Count token usage for context compaction and include a user-facing context budget snapshot.
      if (event.type === "turn_end") {
        const totalTokens = extractTotalTokens(event.message);
        if (totalTokens !== undefined) {
          const contextBudget = this.messagePersistenceCoordinator?.noteTurnUsage(totalTokens);
          if (contextBudget) {
            eventForInspection = attachContextBudget(event, contextBudget);
          }
        }
      }

      // event inspection
      try {
        this.onAgentEvent?.(eventForInspection);
      } catch (error) {
        // Never let inspection/event observers break agent loop execution.
        this.logger.warn(`[agent event observer error] ${String(error)}`);
      }
    });
  }

  get state() {
    return this.agentRuntime.state;
  }

  /**
   * One-message-at-a-time guard: every turn is funneled through this queue.
   * Even if callers invoke runCliTurn concurrently, turns execute serially.
   */
  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.serialQueue.then(fn, fn);
    this.serialQueue = task.then(
      () => undefined,
      () => undefined
    );
    return task;
  }

  async start(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;
    this.loopAbortController = new AbortController();

    while (this.running) {
      const inbound = await this.checkAndWaitInboundMessage(this.loopAbortController.signal);
      if (!inbound) {
        continue;
      }

      await this.runExclusive(async () => {
        await this.executeInboundTurn(inbound);
      });
    }
  }

  async stop(): Promise<void> {
    await this.persistedContextLoadPromise;
    await this.persistPendingMessages();
    this.running = false;
    this.loopAbortController?.abort();
    this.loopAbortController = null;
    this.agentRuntime.abort();
    await this.agentRuntime.waitForIdle();
    await this.persistPendingMessages();
  }

  async checkAndWaitInboundMessage(signal?: AbortSignal): Promise<InboundMessageTemp | null> {
    if (signal?.aborted) {
      return null;
    }

    if (!this.inboundSource) {
      await sleep(250);
      return null;
    }

    try {
      return await this.inboundSource(signal);
    } catch (error) {
      this.logger.warn(`inbound polling failed: ${String(error)}`);
      await sleep(250);
      return null;
    }
  }

  async processInboundMessage(input: InboundMessageTemp): Promise<AgentMessage[]> {
    const memory = await this.assembleMemory(input);
    return toAgentMessages(input, memory, {
      supportsImageInput: this.supportsImageInput(),
    });
  }

  async assembleMemory(input: InboundMessageTemp): Promise<MemoryBundle> {
    if (this.memoryAssembler) {
      return this.memoryAssembler(input);
    }

    return {
      shortTermMessages: [],
      longTermSummary: undefined,
      systemPromptAddendum: undefined,
    };
  }

  async invokeAgentLoop(messages: AgentMessage[]): Promise<AgentMessage> {
    await this.agentRuntime.prompt(messages);
    await this.ensureContextSize();

    const assistantMessage = [...this.agentRuntime.state.messages]
      .reverse()
      .find((message) => (message as any).role === "assistant");

    if (!assistantMessage) {
      throw new Error("No assistant message returned from pi-mono runtime.");
    }

    return assistantMessage;
  }

  async parseAgentResponse(
    assistantMessage: AgentMessage,
    sourceInbound: InboundMessageTemp
  ): Promise<OutboundMessageTemp> {
    return parseAgentResponseToOutboundTemp(assistantMessage, sourceInbound, this.now);
  }

  async sendOutboundMessage(outbound: OutboundMessageTemp): Promise<void> {
    if (this.outboundSink) {
      await this.outboundSink(outbound);
      return;
    }

    this.logger.info(`[cli_temp outbound] ${outbound.text}`);
  }

  // -----------------------------------------------------------
  // Required temp CLI flow:
  // cli_msg -> wrapped_to_inbound_message_temp -> processInboundMessage
  //         -> invokeAgentLoop -> parseAgentResponse -> parse_to_msg_for_cli_temp
  // -----------------------------------------------------------
  async runCliTurn(
    cliMsg: string,
    channel: InboundMessageTemp["channel"] = "cli",
    chatId = "local",
    userId = "cli-user"
  ): Promise<CliTurnResult> {
    return this.runExclusive(async () => {
      const inbound = this.wrapToInboundMessageTemp(cliMsg, channel, chatId, userId);
      return this.executeInboundTurn(inbound);
    });
  }

  async runUserTurn(input: UserTurnInput): Promise<CliTurnResult> {
    return this.runExclusive(async () => {
      const inbound = wrapPartsToInboundMessageTemp(
        input.parts,
        this.now,
        input.channel ?? "unknown",
        input.chatId ?? "local",
        input.userId ?? "unknown-user",
        input.metadata
      );
      return this.executeInboundTurn(inbound);
    });
  }

  getRuntimeContextSnapshot(): RuntimeContextSnapshot {
    const contextBudget = this.messagePersistenceCoordinator?.getContextBudgetSnapshot();
    return {
      curContextSize: contextBudget?.curContextSize ?? 0,
      compactLowWatermarkTokens:
        contextBudget?.lowWaterMark ?? this.contextWatermarks?.compactLowWatermarkTokens ?? 0,
      compactHighWatermarkTokens:
        contextBudget?.highWaterMark ?? this.contextWatermarks?.compactHighWatermarkTokens ?? 0,
      runtimeMessageCount: this.agentRuntime.state.messages.length,
      agentBusy: this.activeTurnCount > 0,
    };
  }

  getAppliedConfigSnapshot(): AppliedAgentConfigSnapshot {
    return { ...this.appliedConfig };
  }

  getRuntimeLifecycleSnapshot(): AgentRuntimeLifecycleSnapshot {
    return {
      running: this.running,
      agentBusy: this.activeTurnCount > 0,
      runtimeMessageCount: this.agentRuntime.state.messages.length,
      persistenceEnabled: this.persistenceEnabled,
      startupRestoreMessageCount: this.startupRestoreMessageCount,
    };
  }

  wrapToInboundMessageTemp(
    cliMsg: string,
    channel: InboundMessageTemp["channel"] = "cli",
    chatId = "local",
    userId = "cli-user"
  ): InboundMessageTemp {
    return wrapToInboundMessageTemp(cliMsg, this.now, channel, chatId, userId);
  }

  parseToMsgForCliTemp(outbound: OutboundMessageTemp | null): string {
    return parseToMsgForCliTemp(outbound);
  }

  private async executeInboundTurn(inbound: InboundMessageTemp): Promise<CliTurnResult> {
    this.activeTurnCount += 1;
    try {
      const llmMessages = await this.processInboundMessage(inbound);
      const assistantMessage = await this.invokeAgentLoop(llmMessages);
      const outbound = await this.parseAgentResponse(assistantMessage, inbound);
      await this.sendOutboundMessage(outbound);

      return {
        inbound,
        outbound,
        cliMessage: this.parseToMsgForCliTemp(outbound),
      };
    } finally {
      this.activeTurnCount = Math.max(0, this.activeTurnCount - 1);
    }
  }

  private supportsImageInput(): boolean {
    return modelSupportsImageInput(this.agentRuntime.state.model);
  }

  injectSteering(cliMsg: string): void {
    this.agentRuntime.steer({
      role: "user",
      content: [{ type: "text", text: cliMsg }],
      timestamp: this.now(),
    } as AgentMessage);
  }

  injectFollowUp(cliMsg: string): void {
    this.agentRuntime.followUp({
      role: "user",
      content: [{ type: "text", text: cliMsg }],
      timestamp: this.now(),
    } as AgentMessage);
  }

  async continue(): Promise<void> {
    await this.runExclusive(async () => {
      await this.agentRuntime.continue();
    });
  }

  abort(): void {
    this.agentRuntime.abort();
  }

  async waitForIdle(): Promise<void> {
    await this.agentRuntime.waitForIdle();
  }

  reset(): void {
    this.agentRuntime.reset();
  }

  private async restorePersistedContextOnStartup(): Promise<void> {
    if (!this.messagePersistenceCoordinator) {
      return;
    }

    try {
      const loaded = await this.messagePersistenceCoordinator.loadPersistedContextWindow(
        this.agentRuntime.state.messages
      );
      this.agentRuntime.replaceMessages(loaded.messages);
    } catch (error) {
      // Defensive catch: coordinator already handles IO failures internally.
      this.logger.warn(`[message persistence] startup restore failed: ${String(error)}`);
    }
  }

  // after an agent turn, check if compact context.
  private async ensureContextSize(): Promise<void> {
    if (!this.messagePersistenceCoordinator) {
      return;
    }

    const compactedMessages = await this.messagePersistenceCoordinator.compactContextIfNeeded(
      this.agentRuntime.state.messages
    );
    if (!compactedMessages.didCompact) {
      return;
    }

    this.agentRuntime.replaceMessages(compactedMessages.messages);
  }

  private async persistPendingMessages(): Promise<void> {
    if (!this.messagePersistenceCoordinator) {
      return;
    }

    await this.messagePersistenceCoordinator.persistPendingMessages(this.agentRuntime.state.messages);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractTotalTokens(message: AgentMessage): number | undefined {
  if (
    message &&
    typeof message === "object" &&
    "usage" in message &&
    typeof message.usage === "object" &&
    message.usage !== null &&
    "totalTokens" in message.usage &&
    typeof message.usage.totalTokens === "number"
  ) {
    return message.usage.totalTokens;
  }
  return undefined;
}

function attachContextBudget(
  event: Extract<AgentEvent, { type: "turn_end" }>,
  contextBudget: ContextBudgetSnapshot
): AgentEvent {
  return {
    ...event,
    contextBudget,
  } as AgentEvent;
}

function createAppliedAgentConfigSnapshot(
  model: unknown,
  fallbackProviderName: string,
  fallbackModelName: string,
  thinkingLevel: AppliedAgentConfigSnapshot["thinkingLevel"]
): AppliedAgentConfigSnapshot {
  const modelRecord = isRecord(model) ? model : {};
  const modelProvider = toNonEmptyString(modelRecord.provider) ?? fallbackProviderName;
  const modelId = toNonEmptyString(modelRecord.id) ?? fallbackModelName;
  const modelDisplayName = toNonEmptyString(modelRecord.name) ?? modelId;

  return {
    providerName: modelProvider,
    modelName: modelId,
    modelProvider,
    modelId,
    modelDisplayName,
    thinkingLevel,
    supportsImageInput: modelSupportsImageInput(model),
  };
}

function modelSupportsImageInput(model: unknown): boolean {
  const modelInput = isRecord(model) ? model.input : undefined;
  return Array.isArray(modelInput) && modelInput.includes("image");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

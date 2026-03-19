import type { Agent as PiAgentRuntime, AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";
import { createModelFromConfig } from "../config/modelFactory.js";
import { assembleTools, ToolRegistry } from "./tools/index.js";

import {
  parseAgentResponseToOutboundTemp,
  parseToMsgForCliTemp,
  toAgentMessages,
  wrapToInboundMessageTemp,
} from "./mappers/message.mapper.js";
import { createAgentRuntime as createPiAgentRuntime } from "./runtime/agentRuntimeFactory.js";
import type {
  AgentDependencies,
  AgentFromAppConfigInput,
  AgentRuntimeConfig,
  CliTurnResult,
  InboundMessageTemp,
  MemoryBundle,
  OutboundMessageTemp,
} from "./types.js";

export class Agent {
  private readonly agentRuntime: PiAgentRuntime;
  private readonly logger: Pick<Console, "debug" | "info" | "warn" | "error">;
  private readonly now: () => number;
  private readonly inboundSource?: (signal?: AbortSignal) => Promise<InboundMessageTemp | null>;
  private readonly outboundSink?: (message: OutboundMessageTemp) => Promise<void> | void;
  private readonly memoryAssembler?: (input: InboundMessageTemp) => Promise<MemoryBundle>;
  private readonly onAgentEvent?: (event: AgentEvent) => void;

  private running = false;
  private loopAbortController: AbortController | null = null;
  private serialQueue: Promise<void> = Promise.resolve();

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

    // Keep this subscription always on so the playground can observe full event flow.
    this.agentRuntime.subscribe((event) => {
      this.logger.debug(`[pi-mono event] ${String((event as any).type)}`);
      try {
        this.onAgentEvent?.(event);
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
        const llmMessages = await this.processInboundMessage(inbound);
        const assistantMessage = await this.invokeAgentLoop(llmMessages);
        const outbound = await this.parseAgentResponse(assistantMessage, inbound);
        await this.sendOutboundMessage(outbound);
      });
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    this.loopAbortController?.abort();
    this.loopAbortController = null;
    this.agentRuntime.abort();
    await this.agentRuntime.waitForIdle();
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
    return toAgentMessages(input, memory);
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
      const llmMessages = await this.processInboundMessage(inbound);

      const assistantMessage = await this.invokeAgentLoop(llmMessages);
      const outbound = await this.parseAgentResponse(assistantMessage, inbound);
      await this.sendOutboundMessage(outbound);

      return {
        inbound,
        outbound,
        cliMessage: this.parseToMsgForCliTemp(outbound),
      };
    });
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
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

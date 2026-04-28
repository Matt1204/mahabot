import type { Agent } from "../agent.js";
import type { BusEnvelope, MessageBus, UserToAgentPayload } from "../../messageBus/types.js";
import { createBusMessageId } from "../../messageBus/id.js";
import type { Logger } from "../../logging/index.js";

export interface AgentWorkerOptions {
  sessionId: string;
  channel?: "cli" | "telegram";
  chatId?: string;
  userId?: string;
  now?: () => number;
  logger?: Pick<Console, "info" | "warn" | "error">;
}

/**
 * AgentWorker is the bridge between MessageBus ingress and Agent runtime turns.
 * It owns the continuous consume-execute-publish loop for one session.
 */
export class AgentWorker {
  private readonly channelType: "cli" | "telegram";
  private readonly chatId: string;
  private readonly userId: string;
  private readonly now: () => number;
  private readonly logger: Pick<Console, "info" | "warn" | "error"> & Partial<Logger>;

  private running = false;
  private abortController: AbortController | null = null;
  private loopPromise: Promise<void> | null = null;

  constructor(
    private readonly bus: MessageBus,
    private readonly agent: Agent,
    private readonly options: AgentWorkerOptions
  ) {
    this.channelType = options.channel ?? "cli";
    this.chatId = options.chatId ?? "local";
    this.userId = options.userId ?? "cli-user";
    this.now = options.now ?? (() => Date.now());
    this.logger = options.logger ?? console;
  }

  // entry point, trigger listening to MessageBus 
  start(): void {
    if (this.running) {
      return;
    }

    this.running = true;
    this.abortController = new AbortController();
    this.loopPromise = this.runLoop(this.abortController.signal);
    this.logger.info?.({
      category: "lifecycle",
      event: "lifecycle.worker_started",
      component: "AgentWorker",
      sessionId: this.options.sessionId,
      summary: "agent worker started",
      data: {
        channel: this.channelType,
      },
    } as any);
  }

  async stop(): Promise<void> {
    this.running = false;
    this.abortController?.abort();
    this.abortController = null;

    if (this.loopPromise) {
      await this.loopPromise;
      this.loopPromise = null;
    }
  }

  // Listen to MessageBus on any User Evnelope(message)
  private async runLoop(signal: AbortSignal): Promise<void> {
    while (this.running && !signal.aborted) {
      try {
        // return actual UserEnvelope OR the Promise of the "UserEnvelope",
        // Blocked until promise is resolved, or rejected(system abort)
        const userEnvelope = await this.bus.getUserMsgFromBus(this.options.sessionId, signal);
        if (!this.running || signal.aborted) {
          break;
        }

        await this.handleUserEnvelope(userEnvelope);
      } catch (error) {
        if (isAbortError(error)) {
          break;
        }

        this.logger.error?.(`[agent-worker] failed to consume user message: ${String(error)}`);
      }
    }
  }

  private async handleUserEnvelope(
    envelope: BusEnvelope<UserToAgentPayload>
  ): Promise<void> {
    const turnId = createTurnId(this.now);
    const start = this.now();
    this.logger.info?.({
      category: "agent_turn",
      event: "agent_turn.start",
      component: "AgentWorker",
      sessionId: this.options.sessionId,
      turnId,
      messageId: envelope.id,
      summary: "agent turn started",
      data: {
        channel: this.channelType,
        partTypes: envelope.payload.parts.map((part) => part.type),
        textLength: envelope.payload.parts
          .filter((part) => part.type === "text")
          .reduce((sum, part) => sum + part.text.length, 0),
        imageCount: envelope.payload.parts.filter((part) => part.type === "image").length,
      },
    } as any);

    try {
      // Invoke Agent loop !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
      const result = await this.agent.runUserTurn({
        parts: envelope.payload.parts,
        channel: this.channelType,
        chatId: this.chatId,
        userId: this.userId,
        metadata: {
          ...envelope.meta,
          turnId,
          busMessageId: envelope.id,
        },
      });

      // publish assistant message to MessageBus
      this.bus.publish({
        id: createBusMessageId(this.now),
        sessionId: this.options.sessionId,
        ts: this.now(),
        direction: "agent_to_user",
        source: "agent_core",
        kind: "agent.assistant_message",
        priority: "high",
        payload: {
          text: result.cliMessage,
          format: "plain",
        },
        renderHints: {
          style: "primary",
          prefix: "bot",
        },
      });
      this.logger.info?.({
        category: "agent_turn",
        event: "agent_turn.complete",
        component: "AgentWorker",
        sessionId: this.options.sessionId,
        turnId,
        messageId: envelope.id,
        summary: "agent turn completed",
        data: {
          durationMs: this.now() - start,
          assistantTextLength: result.cliMessage.length,
        },
      } as any);
    } catch (error) {
      this.logger.error?.({
        category: "agent_turn",
        event: "agent_turn.failed_user_visible",
        component: "AgentWorker",
        sessionId: this.options.sessionId,
        turnId,
        messageId: envelope.id,
        summary: "agent turn failed and user-visible error was published",
        data: {
          durationMs: this.now() - start,
        },
        error,
      } as any);
      this.bus.publish({
        id: createBusMessageId(this.now),
        sessionId: this.options.sessionId,
        ts: this.now(),
        direction: "agent_to_user",
        source: "agent_worker",
        kind: "agent.assistant_message",
        priority: "high",
        payload: {
          text: `[error] ${String(error)}`,
          format: "plain",
        },
        renderHints: {
          style: "primary",
          prefix: "bot",
        },
      });
    }
  }
}

function createTurnId(now: () => number): string {
  return `turn_${now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

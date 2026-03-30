import type { Agent } from "../agent.js";
import type { MessageBus, UserToAgentPart } from "../../messageBus/types.js";
import { createBusMessageId } from "../../messageBus/id.js";

export interface AgentWorkerOptions {
  sessionId: string;
  channel?: "cli" | "telegram";
  chatId?: string;
  userId?: string;
  now?: () => number;
  logger?: Pick<Console, "warn" | "error">;
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
  private readonly logger: Pick<Console, "warn" | "error">;

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

        await this.handleUserEnvelope(userEnvelope.payload.parts);
      } catch (error) {
        if (isAbortError(error)) {
          break;
        }

        this.logger.error?.(`[agent-worker] failed to consume user message: ${String(error)}`);
      }
    }
  }

  private async handleUserEnvelope(parts: UserToAgentPart[]): Promise<void> {
    const cliText = toCliText(parts);
    try {
      // Invoke Agent loop !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
      const result = await this.agent.runCliTurn(cliText, this.channelType, this.chatId, this.userId);

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
    } catch (error) {
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

function toCliText(parts: UserToAgentPart[]): string {
  const lines: string[] = [];

  for (const part of parts) {
    if (part.type === "text") {
      lines.push(part.text);
      continue;
    }

    // We keep image payload in-band for now as a textual placeholder.
    // This allows current text-based agent path to preserve image context until
    // full multimodal inbound mapping is introduced.
    lines.push(`[image] ${part.url}`);
  }

  return lines.join("\n").trim();
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

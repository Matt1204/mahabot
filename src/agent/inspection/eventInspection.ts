import type { AgentEvent } from "@mariozechner/pi-agent-core";

import type { EventInspectionConfig } from "../../config/types.js";
import type {
  InspectionChannel,
  InspectionRenderedEvent,
  InspectionSink,
  InspectionTokenUsage,
} from "./contracts.js";
import { formatToolEnd, formatToolStart, formatToolUpdate } from "./toolInspectionFormatters.js";

interface ContextWatermarks {
  lowWaterMark: number;
  highWaterMark: number;
}

export interface EventInspectionSinkBinding {
  channel: InspectionChannel;
  sink: InspectionSink;
}

export interface EventInspectionDeps {
  sinks: EventInspectionSinkBinding[];
  logger?: Pick<Console, "debug" | "warn" | "error">;
  now?: () => number;
  supportsAnsi?: (channel: InspectionChannel) => boolean;
  getContextWatermarks?: () => ContextWatermarks | undefined;
}

/**
 * Subscribes to AgentEvent stream (via Agent.onAgentEvent). Two-stage microtask deferral:
 * (1) handleAgentEvent → queueMicrotask(processEvent) so the runtime's subscribe callback returns fast;
 * (2) per rendered line → queueMicrotask(sink.publish) so synchronous terminal I/O does not run on
 * the same tick as processEvent. Complements docs/progress_sink_and_inspection_sink.md sequence diagram.
 */
export class EventInspection {
  private readonly logger: Pick<Console, "debug" | "warn" | "error">;
  private readonly now: () => number;
  private readonly supportsAnsi: (channel: InspectionChannel) => boolean;
  private readonly getContextWatermarks: () => ContextWatermarks | undefined;
  private lastUsageFingerprint: string | null = null;

  constructor(
    private readonly config: EventInspectionConfig,
    private readonly deps: EventInspectionDeps
  ) {
    this.logger = deps.logger ?? console;
    this.now = deps.now ?? (() => Date.now());
    this.supportsAnsi = deps.supportsAnsi ?? (() => false);
    this.getContextWatermarks = deps.getContextWatermarks ?? (() => undefined);
  }

  handleAgentEvent(event: AgentEvent): void {
    // Keep callback path minimal: enqueue inspection work and return immediately.
    queueMicrotask(() => this.processEvent(event));
  }

  private processEvent(event: AgentEvent): void {
    try {
      if (!this.config.useEventInspection) {
        return;
      }

      const includeMainEvent = shouldInclude(event.type, this.config);
      const includeTokenUsage = this.config.showTokenUsage && event.type === "turn_end";

      if (!includeMainEvent && !includeTokenUsage) {
        return;
      }

      const tokenUsage =
        includeTokenUsage && event.type === "turn_end"
          ? extractTokenUsage(event, this.getContextWatermarks())
          : undefined;
      const shouldEmitTokenUsage =
        tokenUsage !== undefined && toUsageFingerprint(tokenUsage) !== this.lastUsageFingerprint;

      if (shouldEmitTokenUsage && tokenUsage) {
        this.lastUsageFingerprint = toUsageFingerprint(tokenUsage);
      }

      for (const target of this.deps.sinks) {
        const renderedEvents: InspectionRenderedEvent[] = [];

        if (includeMainEvent) {
          const lineParts = summarizeEvent(event);
          renderedEvents.push({
            channel: target.channel,
            eventType: event.type,
            line: renderInspectionLine(
              lineParts.label,
              lineParts.content,
              target.channel,
              this.supportsAnsi(target.channel)
            ),
            timestamp: this.now(),
            metadata: {
              kind: "event",
            },
          } satisfies InspectionRenderedEvent);
        }

        if (shouldEmitTokenUsage && tokenUsage) {
          renderedEvents.push({
            channel: target.channel,
            eventType: event.type,
            line: renderInspectionLine(
              "token_usage",
              formatTokenUsageLine(tokenUsage),
              target.channel,
              this.supportsAnsi(target.channel)
            ),
            timestamp: this.now(),
            metadata: {
              kind: "token_usage",
              tokenUsage,
            },
          });
        }

        for (const rendered of renderedEvents) {
          // Non-blocking guarantee:
          // sink I/O should never run inline on the agent event callback path.
          queueMicrotask(() => {
            try {
              target.sink.publish(rendered);
            } catch (error) {
              this.logger.warn(`[inspection sink error] ${String(error)}`);
            }
          });
        }
      }
    } catch (error) {
      // Inspection failures must never affect the agent loop.
      this.logger.warn(`[event inspection error] ${String(error)}`);
    }
  }
}

function shouldInclude(eventType: AgentEvent["type"], config: EventInspectionConfig): boolean {
  return config.include[eventType] === true;
}

function renderInspectionLine(
  eventName: string,
  content: string,
  channel: InspectionChannel,
  ansiEnabled: boolean
): string {
  const line = `[${eventName}] ${content}`;
  if (channel !== "cli" || !ansiEnabled) {
    return line;
  }

  // Keep inspection output subtle so it does not compete with user input/final answers.
  return `\u001b[2m${line}\u001b[0m`;
}

function formatTokenUsageLine(usage: InspectionTokenUsage): string {
  return [
    `curContextSize=${usage.curContextSize}`,
    `lowWaterMark=${usage.lowWaterMark}`,
    `highWaterMark=${usage.highWaterMark}`,
  ].join(" ");
}

function extractTokenUsage(
  event: Extract<AgentEvent, { type: "turn_end" }>,
  fallbackWatermarks: ContextWatermarks | undefined
): InspectionTokenUsage | undefined {
  const messageUsage = isRecord(event.message) && isRecord(event.message.usage) ? event.message.usage : undefined;
  const curContextSize = messageUsage ? toNumber(messageUsage.totalTokens) : undefined;
  if (curContextSize === undefined) {
    return undefined;
  }

  const contextBudget = extractContextBudget(event, fallbackWatermarks);
  if (!contextBudget) {
    return undefined;
  }

  return {
    curContextSize,
    lowWaterMark: contextBudget.lowWaterMark,
    highWaterMark: contextBudget.highWaterMark,
  };
}

function extractContextBudget(
  event: AgentEvent,
  fallbackWatermarks: ContextWatermarks | undefined
): ContextWatermarks | undefined {
  const eventWithContextBudget = event as AgentEvent & {
    contextBudget?: {
      lowWaterMark?: unknown;
      highWaterMark?: unknown;
    };
  };

  const lowFromEvent = toNumber(eventWithContextBudget.contextBudget?.lowWaterMark);
  const highFromEvent = toNumber(eventWithContextBudget.contextBudget?.highWaterMark);
  if (lowFromEvent !== undefined && highFromEvent !== undefined) {
    return {
      lowWaterMark: lowFromEvent,
      highWaterMark: highFromEvent,
    };
  }

  if (fallbackWatermarks) {
    return fallbackWatermarks;
  }

  return undefined;
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return undefined;
}

function toUsageFingerprint(usage: InspectionTokenUsage): string {
  return [usage.curContextSize, usage.lowWaterMark, usage.highWaterMark].join("|");
}

function summarizeEvent(event: AgentEvent): { label: string; content: string } {
  switch (event.type) {
    case "agent_start":
      return { label: event.type, content: "Agent started." };
    case "agent_end":
      return { label: event.type, content: "Agent finished." };
    case "turn_start":
      return { label: event.type, content: "Starting your request." };
    case "turn_end":
      return { label: event.type, content: "Turn complete." };
    case "message_start":
      return { label: event.type, content: "Assistant is preparing a response." };
    case "message_update":
      return { label: event.type, content: "Assistant is writing the response." };
    case "message_end":
      return { label: event.type, content: "Assistant finished the response." };
    case "tool_execution_start":
      return {
        label: event.toolName,
        content: formatToolStart(event.toolName, event.args),
      };
    case "tool_execution_update":
      return {
        label: event.toolName,
        content: formatToolUpdate(event.toolName, event.partialResult),
      };
    case "tool_execution_end":
      return {
        label: event.toolName,
        content: formatToolEnd(event.toolName, event.result, event.isError),
      };
    default:
      return { label: "event", content: "Agent updated." };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

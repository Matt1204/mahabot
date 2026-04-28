import type { AgentEvent } from "@mariozechner/pi-agent-core";

import type { EventInspectionConfig } from "../../config/types.js";
import type { AgentRuntimeStatusPublisher } from "../runtimeStatus/types.js";
import type { InspectionTokenUsage } from "./contracts.js";
import { formatToolEnd, formatToolStart, formatToolUpdate } from "./toolInspectionFormatters.js";

interface ContextWatermarks {
  lowWaterMark: number;
  highWaterMark: number;
}

export interface EventInspectionDeps {
  publishStatus: AgentRuntimeStatusPublisher;
  logger?: Pick<Console, "debug" | "warn" | "error">;
  getContextWatermarks?: () => ContextWatermarks | undefined;
}

/**
 * Subscribes to AgentEvent stream (via Agent.onAgentEvent). Two-stage microtask deferral:
 * (1) handleAgentEvent → queueMicrotask(processEvent) so the runtime's subscribe callback returns fast;
 * (2) per rendered line → queueMicrotask(publishStatus) so status publishing work does not run on
 * the same tick as processEvent.
 */
export class EventInspection {
  private readonly logger: Pick<Console, "debug" | "warn" | "error">;
  private readonly publishStatus: AgentRuntimeStatusPublisher;
  private readonly getContextWatermarks: () => ContextWatermarks | undefined;
  private lastUsageFingerprint: string | null = null;
  private turnSeq = 0;
  private assistantSeq = 0;
  private activeThinkingByContentIndex = new Map<number, string>();

  constructor(private readonly config: EventInspectionConfig, deps: EventInspectionDeps) {
    this.logger = deps.logger ?? console;
    this.publishStatus = deps.publishStatus;
    this.getContextWatermarks = deps.getContextWatermarks ?? (() => undefined);
  }

  handleAgentEvent(event: AgentEvent): void {
    // Keep callback path minimal: enqueue inspection work and return immediately.
    queueMicrotask(() => this.processEvent(event));
  }

  private processEvent(event: AgentEvent): void {
    try {
      this.processThinkingEvent(event);

      const includeMainEvent = this.config.useEventInspection && shouldInclude(event.type, this.config);
      const includeTokenUsage =
        this.config.useEventInspection && this.config.showTokenUsage && event.type === "turn_end";

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

      if (includeMainEvent) {
        const lineParts = summarizeEvent(event);
        queueMicrotask(() => {
          try {
            this.publishStatus({
              kind: "agent.runtime.event",
              source: "event_inspection",
              priority: "low",
              text: renderInspectionLine(lineParts.label, lineParts.content),
              raw: {
                eventType: event.type,
              },
              renderHints: {
                style: "dim",
                prefix: lineParts.label,
              },
            });
          } catch (error) {
            this.logger.warn(`[event inspection publish error] ${String(error)}`);
          }
        });
      }

      if (shouldEmitTokenUsage && tokenUsage) {
        queueMicrotask(() => {
          try {
            this.publishStatus({
              kind: "agent.runtime.token_usage",
              source: "event_inspection",
              priority: "low",
              text: renderInspectionLine("token_usage", formatTokenUsageLine(tokenUsage)),
              raw: {
                tokenUsage,
              },
              renderHints: {
                style: "dim",
                prefix: "token_usage",
              },
            });
          } catch (error) {
            this.logger.warn(`[token usage publish error] ${String(error)}`);
          }
        });
      }
    } catch (error) {
      // Inspection failures must never affect the agent loop.
      this.logger.warn(`[event inspection error] ${String(error)}`);
    }
  }

  private processThinkingEvent(event: AgentEvent): void {
    if (!this.config.thinking.enabled) {
      return;
    }

    switch (event.type) {
      case "turn_start":
        this.turnSeq += 1;
        this.activeThinkingByContentIndex.clear();
        return;
      case "message_start":
        if (isAssistantMessage(event.message)) {
          this.assistantSeq += 1;
          this.activeThinkingByContentIndex.clear();
        }
        return;
      case "message_end":
        if (isAssistantMessage(event.message)) {
          this.activeThinkingByContentIndex.clear();
        }
        return;
      case "agent_end":
        this.activeThinkingByContentIndex.clear();
        return;
      case "message_update":
        this.handleThinkingUpdate(event);
        return;
      default:
        return;
    }
  }

  private handleThinkingUpdate(event: Extract<AgentEvent, { type: "message_update" }>): void {
    const assistantEvent = event.assistantMessageEvent;

    switch (assistantEvent.type) {
      case "thinking_start":
        this.activeThinkingByContentIndex.set(assistantEvent.contentIndex, "");
        return;
      case "thinking_delta": {
        const previous = this.activeThinkingByContentIndex.get(assistantEvent.contentIndex) ?? "";
        this.activeThinkingByContentIndex.set(assistantEvent.contentIndex, previous + assistantEvent.delta);
        return;
      }
      case "thinking_end": {
        const rawThinking =
          assistantEvent.content ??
          this.activeThinkingByContentIndex.get(assistantEvent.contentIndex) ??
          extractThinkingFromAssistantMessage(event.message, assistantEvent.contentIndex);
        const thinkingText = normalizeThinkingText(rawThinking, this.config.thinking.maxChars);
        this.activeThinkingByContentIndex.delete(assistantEvent.contentIndex);

        if (!thinkingText) {
          return;
        }

        queueMicrotask(() => {
          try {
            this.publishStatus({
              kind: "agent.runtime.thinking",
              source: "event_inspection",
              priority: "low",
              text: `[thinking] ${thinkingText}`,
              raw: {
                phase: "end",
                turnSeq: this.turnSeq,
                assistantSeq: this.assistantSeq,
                contentIndex: assistantEvent.contentIndex,
              },
              renderHints: {
                style: "dim",
                prefix: "thinking",
              },
            });
          } catch (error) {
            this.logger.warn(`[thinking publish error] ${String(error)}`);
          }
        });
        return;
      }
      default:
        return;
    }
  }
}

function shouldInclude(eventType: AgentEvent["type"], config: EventInspectionConfig): boolean {
  return config.include[eventType] === true;
}

function renderInspectionLine(eventName: string, content: string): string {
  return `[${eventName}] ${content}`;
}

function formatTokenUsageLine(usage: InspectionTokenUsage): string {
  return [
    `curContextSize=${usage.curContextSize}`
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

function isAssistantMessage(message: unknown): boolean {
  return isRecord(message) && message.role === "assistant";
}

function extractThinkingFromAssistantMessage(message: unknown, contentIndex: number): string {
  if (!isRecord(message) || !Array.isArray(message.content)) {
    return "";
  }

  const block = message.content[contentIndex];
  if (!isRecord(block) || block.type !== "thinking") {
    return "";
  }

  if (typeof block.thinking === "string") {
    return block.thinking;
  }
  if (typeof block.text === "string") {
    return block.text;
  }
  return "";
}

function normalizeThinkingText(value: unknown, maxChars?: number): string {
  if (typeof value !== "string") {
    return "";
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return "";
  }

  if (maxChars === undefined || trimmed.length <= maxChars) {
    return trimmed;
  }

  return `${trimmed.slice(0, maxChars)}...(truncated)`;
}

import type { AgentEvent } from "@mariozechner/pi-agent-core";

import type { EventInspectionConfig } from "../../config/types.js";
import type {
  InspectionChannel,
  InspectionRenderedEvent,
  InspectionSink,
  InspectionTokenUsage,
} from "./contracts.js";

const INSPECTION_PREFIX = "[inspection]";
const MAX_SUMMARY_CHARS = 120;
const MAX_PARAMS_CHARS = 180;
const MAX_OBJECT_DEPTH = 2;
const MAX_OBJECT_KEYS = 8;
const MAX_ARRAY_ITEMS = 5;

export interface EventInspectionSinkBinding {
  channel: InspectionChannel;
  sink: InspectionSink;
}

export interface EventInspectionDeps {
  sinks: EventInspectionSinkBinding[];
  logger?: Pick<Console, "debug" | "warn" | "error">;
  now?: () => number;
  supportsAnsi?: (channel: InspectionChannel) => boolean;
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
  private hasEmittedUsageInCurrentTurn = false;
  private lastUsageFingerprint: string | null = null;

  constructor(
    private readonly config: EventInspectionConfig,
    private readonly deps: EventInspectionDeps
  ) {
    this.logger = deps.logger ?? console;
    this.now = deps.now ?? (() => Date.now());
    this.supportsAnsi = deps.supportsAnsi ?? (() => false);
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
      const canEmitTokenUsageFromStream =
        this.config.showTokenUsage && event.type === "message_update";
      const canEmitTokenUsageFromTurnEndFallback =
        this.config.showTokenUsage && event.type === "turn_end" && !this.hasEmittedUsageInCurrentTurn;
      const includeTokenUsage = canEmitTokenUsageFromStream || canEmitTokenUsageFromTurnEndFallback;

      if (!includeMainEvent && !includeTokenUsage) {
        return;
      }

      if (event.type === "turn_start") {
        this.hasEmittedUsageInCurrentTurn = false;
        this.lastUsageFingerprint = null;
      }

      for (const target of this.deps.sinks) {
        const renderedEvents: InspectionRenderedEvent[] = [
          ...(includeMainEvent
            ? [
                {
                  channel: target.channel,
                  eventType: event.type,
                  line: renderInspectionLine(
                    summarizeEvent(event),
                    target.channel,
                    this.supportsAnsi(target.channel)
                  ),
                  timestamp: this.now(),
                  metadata: {
                    kind: "event",
                  },
                } satisfies InspectionRenderedEvent,
              ]
            : []),
        ];

        if (includeTokenUsage && (event.type === "message_update" || event.type === "turn_end")) {
          const tokenUsage = extractTokenUsage(event.message);
          if (tokenUsage) {
            const usageFingerprint = toUsageFingerprint(tokenUsage);
            if (event.type === "message_update" && usageFingerprint === this.lastUsageFingerprint) {
              continue;
            }
            this.hasEmittedUsageInCurrentTurn = true;
            this.lastUsageFingerprint = usageFingerprint;
            renderedEvents.push({
              channel: target.channel,
              eventType: event.type,
              line: renderInspectionLine(
                formatTokenUsageLine(tokenUsage, event.type),
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

function renderInspectionLine(summary: string, channel: InspectionChannel, ansiEnabled: boolean): string {
  const prefix =
    channel === "cli" && ansiEnabled
      ? `\u001b[36m${INSPECTION_PREFIX}\u001b[0m`
      : INSPECTION_PREFIX;

  return `${prefix} ${summary}`;
}

function formatTokenUsageLine(
  usage: InspectionTokenUsage,
  sourceEventType: "message_update" | "turn_end"
): string {
  return [
    "token_usage",
    `source=${sourceEventType}`,
    `input=${usage.input}`,
    `output=${usage.output}`,
    `cacheRead=${usage.cacheRead}`,
    `cacheWrite=${usage.cacheWrite}`,
    `total=${usage.totalTokens}`,
    `cost=$${usage.costTotal.toFixed(4)}`,
  ].join(" ");
}

function extractTokenUsage(message: unknown): InspectionTokenUsage | undefined {
  if (!isRecord(message)) {
    return undefined;
  }

  const usage = message.usage;
  if (!isRecord(usage)) {
    return undefined;
  }

  const input = toNumber(usage.input);
  const output = toNumber(usage.output);
  const cacheRead = toNumber(usage.cacheRead);
  const cacheWrite = toNumber(usage.cacheWrite);
  const totalTokens = toNumber(usage.totalTokens);
  const cost = isRecord(usage.cost) ? usage.cost : undefined;
  const costTotal = cost ? toNumber(cost.total) : undefined;

  if (
    input === undefined ||
    output === undefined ||
    cacheRead === undefined ||
    cacheWrite === undefined ||
    totalTokens === undefined ||
    costTotal === undefined
  ) {
    return undefined;
  }

  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens,
    costTotal,
  };
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return undefined;
}

function toUsageFingerprint(usage: InspectionTokenUsage): string {
  return [
    usage.input,
    usage.output,
    usage.cacheRead,
    usage.cacheWrite,
    usage.totalTokens,
    usage.costTotal,
  ].join("|");
}

function summarizeEvent(event: AgentEvent): string {
  switch (event.type) {
    case "agent_start":
      return "agent_start";
    case "agent_end":
      return `agent_end messages=${event.messages.length}`;
    case "turn_start":
      return "turn_start";
    case "turn_end":
      return `turn_end role=${extractRole(event.message)} toolResults=${event.toolResults.length}`;
    case "message_start":
      return `message_start role=${extractRole(event.message)}`;
    case "message_update":
      return summarizeMessageUpdate(event);
    case "message_end":
      return `message_end role=${extractRole(event.message)}`;
    case "tool_execution_start":
      return `tool_start name=${event.toolName} id=${event.toolCallId} argsKeys=[${extractArgKeys(event.args).join(", ")}] params=${shortSummary(
        event.args,
        MAX_PARAMS_CHARS
      )}`;
    case "tool_execution_update":
      return `tool_update name=${event.toolName} id=${event.toolCallId} summary=${shortSummary(event.partialResult)}`;
    case "tool_execution_end":
      return `tool_end name=${event.toolName} id=${event.toolCallId} status=${
        event.isError ? "error" : "success"
      } summary=${shortSummary(event.result)}`;
    default:
      return `event=${String((event as { type: unknown }).type)}`;
  }
}

function summarizeMessageUpdate(event: Extract<AgentEvent, { type: "message_update" }>): string {
  const updateType = event.assistantMessageEvent?.type ?? "unknown";
  const delta = (event.assistantMessageEvent as { delta?: unknown }).delta;
  if (typeof delta === "string") {
    return `message_update stream=${updateType} deltaChars=${delta.length}`;
  }

  return `message_update stream=${updateType}`;
}

function extractRole(message: unknown): string {
  if (isRecord(message) && typeof message.role === "string" && message.role.trim().length > 0) {
    return message.role;
  }
  return "unknown";
}

function extractArgKeys(value: unknown): string[] {
  if (!isRecord(value)) {
    return [];
  }
  return Object.keys(value).sort();
}

function shortSummary(value: unknown, maxChars = MAX_SUMMARY_CHARS): string {
  const masked = sanitizeValue(value, MAX_OBJECT_DEPTH);

  let serialized = "";
  try {
    serialized = JSON.stringify(masked);
  } catch {
    serialized = String(masked);
  }

  if (!serialized || serialized === "undefined") {
    return "\"\"";
  }

  const singleLine = serialized.replace(/\s+/g, " ").trim();
  return truncate(singleLine, maxChars);
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "string") {
    return truncate(value, MAX_SUMMARY_CHARS);
  }

  if (typeof value !== "object") {
    return value;
  }

  if (depth <= 0) {
    return "[Truncated]";
  }

  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitizeValue(item, depth - 1));
    if (value.length > MAX_ARRAY_ITEMS) {
      items.push(`...(${value.length - MAX_ARRAY_ITEMS} more)`);
    }
    return items;
  }

  if (!isRecord(value)) {
    return "[Unserializable]";
  }

  const entries = Object.entries(value);
  const trimmedEntries = entries.slice(0, MAX_OBJECT_KEYS);
  const output: Record<string, unknown> = {};
  for (const [key, child] of trimmedEntries) {
    output[key] = isSensitiveKey(key) ? "[REDACTED]" : sanitizeValue(child, depth - 1);
  }
  if (entries.length > MAX_OBJECT_KEYS) {
    output.__truncated_keys__ = entries.length - MAX_OBJECT_KEYS;
  }
  return output;
}

function truncate(input: string, maxChars: number): string {
  if (input.length <= maxChars) {
    return input;
  }
  return `${input.slice(0, Math.max(0, maxChars - 3))}...`;
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return (
    normalized === "key" ||
    normalized.includes("token") ||
    normalized.includes("secret") ||
    normalized.includes("password") ||
    normalized.includes("authorization") ||
    normalized.includes("api_key") ||
    normalized.includes("apikey") ||
    normalized.includes("access_key") ||
    normalized.includes("private_key")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

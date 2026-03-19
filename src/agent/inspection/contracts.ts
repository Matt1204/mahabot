import type { AgentEvent } from "@mariozechner/pi-agent-core";

export type InspectionChannel = "cli" | "telegram";

export interface InspectionTokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  costTotal: number;
}

export interface InspectionRenderedEvent {
  channel: InspectionChannel;
  eventType: AgentEvent["type"];
  line: string;
  timestamp: number;
  metadata?: {
    kind?: "event" | "token_usage";
    tokenUsage?: InspectionTokenUsage;
    [key: string]: unknown;
  };
}

/**
 * Contract for sinks that consume inspection output.
 *
 * Future ingress note:
 * - Telegram/webhook delivery should implement this sink.
 * - Implementations must return immediately and offload network work to async queues/workers.
 * - Never block agent loop progression on sink I/O, retries, or rate limiting.
 */
export interface InspectionSink {
  publish(event: InspectionRenderedEvent): void;
}

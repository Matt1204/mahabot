import type { AgentEvent } from "@mariozechner/pi-agent-core";

export type InspectionChannel = "cli" | "telegram";

export interface InspectionTokenUsage {
  curContextSize: number;
  lowWaterMark: number;
  highWaterMark: number;
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
 * Contract for sinks that consume EventInspection output (built from AgentEvent, not from tools).
 *
 * Future ingress note:
 * - Telegram/webhook delivery should implement this sink.
 * - Implementations must return immediately and offload network work to async queues/workers.
 * - Never block agent loop progression on sink I/O, retries, or rate limiting.
 *
 * Distinct from ProgressUpdateSink: different payload type, produced by EventInspection after gating
 * and summarization, not by the `in_flight_update` tool.
 */
export interface InspectionSink {
  publish(event: InspectionRenderedEvent): void;
}

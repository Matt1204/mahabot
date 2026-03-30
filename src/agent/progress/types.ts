/**
 * User-visible progress updates (`in_flight_update` tool), separate from AgentEvent / EventInspection.
 * Gateway wires `ProgressUpdateSink` into assembleTools; the tool calls the sink synchronously after
 * validation — same non-blocking contract as InspectionSink.
 */

export interface AgentProgressUpdatePayload {
  message: string;
  nextStep?: string;
  progressPercent?: number;
  stage?: string;
  dedupeKey?: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

/** Synchronous, must return immediately; no blocking I/O (see design doc / InspectionSink ingress note). */
export type ProgressUpdateSink = (payload: AgentProgressUpdatePayload) => void;

export type InFlightUpdateDroppedReason = "validation_error" | "sink_failed";

export interface InFlightUpdateDetails {
  delivered: boolean;
  droppedReason?: InFlightUpdateDroppedReason;
}

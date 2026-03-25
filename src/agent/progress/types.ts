/**
 * User-visible progress updates (`in_flight_update` tool), separate from AgentEvent / EventInspection.
 * Gateway wires `ProgressUpdateSink` + `InFlightUpdateQuotaRef` into assembleTools and Agent deps;
 * the tool calls the sink synchronously after validation — same non-blocking contract as InspectionSink.
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

export interface InFlightUpdateQuotaRef {
  used: number;
}

export type InFlightUpdateDroppedReason = "quota_exceeded" | "validation_error" | "sink_failed";

export interface InFlightUpdateDetails {
  delivered: boolean;
  droppedReason?: InFlightUpdateDroppedReason;
  quota: { limit: number; used: number; remaining: number };
}

export const IN_FLIGHT_UPDATE_LIMIT = 3;

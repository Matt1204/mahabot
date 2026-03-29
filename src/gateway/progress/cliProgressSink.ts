import type { AgentProgressUpdatePayload, ProgressUpdateSink } from "../../agent/progress/types.js";

/**
 * CLI implementation of ProgressUpdateSink (docs/progress_sink_and_inspection_sink.md).
 * - Called synchronously from `in_flight_update` execute(); must stay fast (stdout write only).
 * - Output prefix `[agent-update]` distinguishes from EventInspection's `[event_name]`.
 */
export function createCliProgressUpdateSink(
  output: { write: (chunk: string) => unknown },
  supportsAnsi: boolean
): ProgressUpdateSink {
  return (payload: AgentProgressUpdatePayload) => {
    const line = formatProgressLine(payload, supportsAnsi);
    output.write(`${line}\n`);
  };
}

function formatProgressLine(payload: AgentProgressUpdatePayload, supportsAnsi: boolean): string {
  const parts = [`[agent-update] ${payload.message}`];
  if (payload.nextStep !== undefined && payload.nextStep.length > 0) {
    parts.push(`| next: ${payload.nextStep}`);
  }
  if (payload.progressPercent !== undefined) {
    parts.push(`| ${payload.progressPercent}%`);
  }
  const core = parts.join(" ");
  if (!supportsAnsi) {
    return core;
  }
  return `\x1b[2;36m${core}\x1b[0m`;
}

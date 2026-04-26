/**
 * `in_flight_update` tool: validates params, builds a user-facing status text,
 * and publishes runtime status to the MessageBus path.
 */
import { Type } from "@mariozechner/pi-ai";

import type { InFlightUpdateDetails } from "../progress/types.js";
import type { AgentRuntimeStatusPublisher } from "../runtimeStatus/types.js";
import type { DescribedAgentTool } from "./registry/types.js";
import { textResult } from "./showcase/shared.js";

const stageSchema = Type.Union([
  Type.Literal("planning"),
  Type.Literal("executing"),
  Type.Literal("validating"),
  Type.Literal("finalizing"),
]);

const parametersSchema = Type.Object({
  message: Type.String({ minLength: 1, maxLength: 280 }),
  nextStep: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  progressPercent: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
  stage: Type.Optional(stageSchema),
  dedupeKey: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
});

export interface CreateInFlightUpdateToolInput {
  publishStatus: AgentRuntimeStatusPublisher;
  logger?: Pick<Console, "warn">;
  now?: () => number;
}

function buildToolRulePrompt(): string {
  return [
    "Whenever you call **any other tool(s)** in an assistant turn, include **one** `in_flight_update` in the **same** tool-call batch (parallel with those tools).",
    "Keep `message` short: current situation, intent, progress",
  ].join(" ");
}

export function createInFlightUpdateTool(input: CreateInFlightUpdateToolInput): DescribedAgentTool {
  const logger = input.logger ?? console;
  const now = input.now ?? (() => Date.now());

  const tool: DescribedAgentTool = {
    name: "in_flight_update",
    label: "In-flight update",
    description:
      "Non-final short message to user during multi-step work to explain your situation, intent, progress. **Pairing rule:** whenever you invoke any other tool(s), call `in_flight_update` once **in parallel** with that same round of tool calls.",
    toolRulePrompt: buildToolRulePrompt(),
    parameters: parametersSchema,
    async execute(_toolCallId, params) {
      let pct: number | undefined;
      if (params.progressPercent !== undefined) {
        const raw = params.progressPercent;
        if (!Number.isInteger(raw) || raw < 0 || raw > 100) {
          return errorResult("progressPercent must be an integer between 0 and 100.", "validation_error");
        }
        pct = raw;
      }

      const message = params.message.trim();
      if (message.length === 0 || message.length > 280) {
        return errorResult("message must be 1–280 non-whitespace characters.", "validation_error");
      }

      let nextStep: string | undefined;
      if (params.nextStep !== undefined) {
        const ns = params.nextStep.trim();
        if (ns.length === 0 || ns.length > 200) {
          return errorResult("nextStep must be 1–200 characters when provided.", "validation_error");
        }
        nextStep = ns;
      }

      const rawPayload = {
        message,
        nextStep,
        progressPercent: pct,
        stage: params.stage,
        dedupeKey: params.dedupeKey,
        timestamp: now(),
      };

      try {
        // Producer-side formatting rule:
        // convert structured update fields to direct user-visible text before publishing.
        input.publishStatus({
          kind: "agent.runtime.inflight_update",
          source: "in_flight_update",
          priority: "normal",
          text: formatInFlightText(rawPayload),
          raw: rawPayload,
          renderHints: {
            style: "secondary",
            prefix: "agent-update",
          },
        });
      } catch (error) {
        logger.warn?.(`[in_flight_update] publish failed: ${String(error)}`);
        return errorResult("Progress update could not be delivered (publish error).", "sink_failed");
      }

      return textResult("Progress update sent.", { delivered: true });
    },
  };

  return tool;
}

function errorResult(
  text: string,
  reason: NonNullable<InFlightUpdateDetails["droppedReason"]>
): ReturnType<typeof textResult<InFlightUpdateDetails>> {
  const details: InFlightUpdateDetails = {
    delivered: false,
    droppedReason: reason,
  };
  return textResult(text, details);
}

function formatInFlightText(payload: {
  message: string;
  nextStep?: string;
  progressPercent?: number;
}): string {
  const parts = [payload.message];
  if (payload.nextStep) {
    parts.push(`next: ${payload.nextStep}`);
  }
  if (payload.progressPercent !== undefined) {
    parts.push(`${payload.progressPercent}%`);
  }
  return parts.join(" | ");
}

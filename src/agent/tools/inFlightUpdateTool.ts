/**
 * `in_flight_update` tool: validates params, enforces IN_FLIGHT_UPDATE_LIMIT against shared quotaRef,
 * then calls ProgressUpdateSink synchronously. Quota increments only after a successful sink call.
 * Not part of EventInspection; paired with gateway wiring (manager.ts) + Agent.invokeAgentLoop reset.
 */
import { Type } from "@mariozechner/pi-ai";

import type {
  AgentProgressUpdatePayload,
  InFlightUpdateDetails,
  InFlightUpdateQuotaRef,
  ProgressUpdateSink,
} from "../progress/types.js";
import { IN_FLIGHT_UPDATE_LIMIT } from "../progress/types.js";
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
  sink: ProgressUpdateSink;
  quotaRef: InFlightUpdateQuotaRef;
  logger?: Pick<Console, "warn">;
  now?: () => number;
}

function quotaSnapshot(used: number) {
  const limit = IN_FLIGHT_UPDATE_LIMIT;
  const remaining = Math.max(0, limit - used);
  return { limit, used, remaining };
}

function buildToolRulePrompt(): string {
  return [
    "Send a **non-final** progress update to the user during long or multi-step work.",
    `At most **${IN_FLIGHT_UPDATE_LIMIT}** successful updates per user turn; check tool result \`quota.remaining\`.`,
    "This is not the final answer — continue until you output the full reply for the user turn.",
    "Do not use for trivial one-shot tasks.",
  ].join(" ");
}

export function createInFlightUpdateTool(input: CreateInFlightUpdateToolInput): DescribedAgentTool {
  const logger = input.logger ?? console;
  const now = input.now ?? (() => Date.now());

  const tool: DescribedAgentTool = {
    name: "in_flight_update",
    label: "In-flight update",
    description:
      "Send a one-way progress update to the user (current work and optional next step). Does not complete the task.",
    toolRulePrompt: buildToolRulePrompt(),
    parameters: parametersSchema,
    async execute(_toolCallId, params) {
      const snap = () => quotaSnapshot(input.quotaRef.used);

      let pct: number | undefined;
      if (params.progressPercent !== undefined) {
        const raw = params.progressPercent;
        if (!Number.isInteger(raw) || raw < 0 || raw > 100) {
          return errorResult(
            "progressPercent must be an integer between 0 and 100.",
            "validation_error",
            snap()
          );
        }
        pct = raw;
      }

      const message = params.message.trim();
      if (message.length === 0 || message.length > 280) {
        return errorResult("message must be 1–280 non-whitespace characters.", "validation_error", snap());
      }

      let nextStep: string | undefined;
      if (params.nextStep !== undefined) {
        const ns = params.nextStep.trim();
        if (ns.length === 0 || ns.length > 200) {
          return errorResult("nextStep must be 1–200 characters when provided.", "validation_error", snap());
        }
        nextStep = ns;
      }

      if (input.quotaRef.used >= IN_FLIGHT_UPDATE_LIMIT) {
        return errorResult(
          `Progress update quota exceeded (${IN_FLIGHT_UPDATE_LIMIT} per user turn).`,
          "quota_exceeded",
          snap()
        );
      }

      const payload: AgentProgressUpdatePayload = {
        message,
        nextStep,
        progressPercent: pct,
        stage: params.stage,
        dedupeKey: params.dedupeKey,
        timestamp: now(),
      };

      try {
        // Sync sink: must not await network; failures become tool error without bumping quota.
        input.sink(payload);
      } catch (error) {
        logger.warn?.(`[in_flight_update] sink failed: ${String(error)}`);
        return errorResult(
          "Progress update could not be delivered (sink error).",
          "sink_failed",
          snap()
        );
      }

      input.quotaRef.used += 1;
      const after = snap();
      const details: InFlightUpdateDetails = {
        delivered: true,
        quota: after,
      };
      const text = `Progress update sent. ${after.remaining} update(s) remaining this user turn.`;
      return textResult(text, details);
    },
  };

  return tool;
}

function errorResult(
  text: string,
  reason: InFlightUpdateDetails["droppedReason"],
  quota: InFlightUpdateDetails["quota"]
): ReturnType<typeof textResult<InFlightUpdateDetails>> {
  const details: InFlightUpdateDetails = {
    delivered: false,
    droppedReason: reason,
    quota,
  };
  return textResult(text, details);
}

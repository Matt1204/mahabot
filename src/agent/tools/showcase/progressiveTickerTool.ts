import { Type } from "@mariozechner/pi-ai";
import type { DescribedAgentTool } from "../registry/types.js";

import { sleep, textResult } from "./shared.js";

interface ProgressDetails {
  step: number;
  total: number;
  label: string | null;
}

export function createProgressiveTickerTool(): DescribedAgentTool {
  const progressiveTickerSchema = Type.Object({
    steps: Type.Integer({ minimum: 1, maximum: 8, default: 3 }),
    delayMs: Type.Integer({ minimum: 100, maximum: 1200, default: 350 }),
    label: Type.Optional(Type.String({ minLength: 1 })),
  });

  const progressiveTickerTool: DescribedAgentTool = {
    name: "progressive_ticker",
    label: "Progressive Ticker",
    description: "Emit progressive updates to showcase tool_execution_update events.",
    toolRulePrompt:
      "Use `progressive_ticker` when you need visible progress while a multi-step task is running. " +
      "Keep steps between 1 and 8, use short labels, and avoid stacking multiple long ticker runs.",
    parameters: progressiveTickerSchema,
    async execute(_toolCallId, params, signal, onUpdate) {
      for (let step = 1; step <= params.steps; step += 1) {
        if (signal?.aborted) {
          throw new Error("progressive_ticker aborted by signal");
        }

        onUpdate?.(
          textResult(`progressive_ticker ${step}/${params.steps}`, {
            step,
            total: params.steps,
            label: params.label ?? null,
          })
        );

        await sleep(params.delayMs);
      }

      return textResult(`progressive_ticker finished (${params.steps} step(s))`, {
        step: params.steps,
        total: params.steps,
        label: params.label ?? null,
      });
    },
  };

  return progressiveTickerTool;
}

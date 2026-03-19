import { StringEnum, Type } from "@mariozechner/pi-ai";
import type { DescribedAgentTool } from "../registry/types.js";

import { textResult } from "./shared.js";

interface EchoDetails {
  received: {
    title: string;
    mood: string;
    tags: string[];
    options: {
      includeChecklist: boolean;
      maxItems: number;
    };
    metadata?: {
      source: string;
      priority?: number;
    };
  };
}

export function createEchoStructuredInputTool(): DescribedAgentTool {
  const echoStructuredInputSchema = Type.Object({
    title: Type.String({ minLength: 1, description: "Short title" }),
    mood: StringEnum(["calm", "focused", "playful"], {
      description: "Response tone hint",
      default: "focused",
    }),
    tags: Type.Array(Type.String({ minLength: 1 }), {
      minItems: 0,
      maxItems: 6,
    }),
    options: Type.Object({
      includeChecklist: Type.Boolean({ default: true }),
      maxItems: Type.Integer({ minimum: 1, maximum: 10, default: 3 }),
    }),
    metadata: Type.Optional(
      Type.Object({
        source: Type.String({ minLength: 1 }),
        priority: Type.Optional(Type.Integer({ minimum: 0, maximum: 5 })),
      })
    ),
  });

  const echoStructuredInputTool: DescribedAgentTool = {
    name: "echo_structured_input",
    label: "Echo Structured Input",
    description: "Echo rich nested parameters to demonstrate schema validation and typed args.",
    parameters: echoStructuredInputSchema,
    async execute(_toolCallId, params) {
      const checklist = params.options.includeChecklist
        ? `\nChecklist:\n${Array.from(
            { length: params.options.maxItems },
            (_, i) => `${i + 1}. ${params.title} - item ${i + 1}`
          ).join("\n")}`
        : "";

      return textResult(
        `Structured echo (${params.mood}): ${params.title}\nTags: ${params.tags.join(", ") || "(none)"}${checklist}`,
        { received: params }
      );
    },
  };

  return echoStructuredInputTool;
}

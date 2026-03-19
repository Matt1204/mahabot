import type { AgentTool } from "@mariozechner/pi-agent-core";
import { StringEnum, Type } from "@mariozechner/pi-ai";

import { demoGeneratePngBase64, textAndImageResult } from "./shared.js";

interface BadgeDetails {
  label: string;
  color: string;
  includeText: boolean;
  includesImage: boolean;
}

export function createRenderDebugBadgeTool(): AgentTool<any> {
  const debugBadgeSchema = Type.Object({
    label: Type.String({ minLength: 1, maxLength: 32 }),
    color: StringEnum(["teal", "orange", "gray"], { default: "teal" }),
    includeText: Type.Boolean({ default: true }),
  });

  const debugBadgeTool: AgentTool<typeof debugBadgeSchema, BadgeDetails> = {
    name: "render_debug_badge",
    label: "Render Debug Badge",
    description: "Return text plus an inline tiny PNG image as toolResult content.",
    parameters: debugBadgeSchema,
    async execute(_toolCallId, params) {
      const message = params.includeText ? `Debug badge generated: [${params.color}] ${params.label}` : "";

      return textAndImageResult(message, demoGeneratePngBase64(), {
        label: params.label,
        color: params.color,
        includeText: params.includeText,
        includesImage: true,
      });
    },
  };

  return debugBadgeTool;
}

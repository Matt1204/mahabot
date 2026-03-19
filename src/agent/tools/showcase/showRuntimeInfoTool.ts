import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@mariozechner/pi-ai";

import { textResult } from "./shared.js";

interface RuntimeInfoDetails {
  toolCallId: string;
  now: number;
  isoTime: string;
}

export function createShowRuntimeInfoTool(): AgentTool<any> {
  const runtimeInfoSchema = Type.Object({});

  const runtimeInfoTool: AgentTool<typeof runtimeInfoSchema, RuntimeInfoDetails> = {
    name: "show_runtime_info",
    label: "Show Runtime Info",
    description: "Return current runtime timestamp and include toolCallId in details.",
    parameters: runtimeInfoSchema,
    async execute(toolCallId) {
      const now = Date.now();
      return textResult(`Runtime timestamp: ${now}`, {
        toolCallId,
        now,
        isoTime: new Date(now).toISOString(),
      });
    },
  };

  return runtimeInfoTool;
}

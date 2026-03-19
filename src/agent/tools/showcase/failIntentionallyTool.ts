import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@mariozechner/pi-ai";

interface FailureDetails {
  reason: string;
  retryable: boolean;
}

export function createFailIntentionallyTool(): AgentTool<any> {
  const failIntentionallySchema = Type.Object({
    reason: Type.Optional(Type.String({ minLength: 1 })),
    retryable: Type.Optional(Type.Boolean({ default: false })),
  });

  const failIntentionallyTool: AgentTool<typeof failIntentionallySchema, FailureDetails> = {
    name: "fail_intentionally",
    label: "Fail Intentionally",
    description: "Throw an error intentionally to demonstrate tool error handling.",
    parameters: failIntentionallySchema,
    async execute(_toolCallId, params) {
      const reason = params.reason ?? "Intentional failure from showcase tool.";
      const retryable = params.retryable ?? false;
      throw new Error(`${reason} (retryable=${retryable})`);
    },
  };

  return failIntentionallyTool;
}

import { Agent as PiAgent } from "@mariozechner/pi-agent-core";
import { getModel } from "@mariozechner/pi-ai";

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { Model } from "@mariozechner/pi-ai";

import type { AgentRuntimeConfig } from "../types.js";

/**
 * Agent runtime factory using @mariozechner/pi-agent-core.
 *
 * Setup examples:
 *
 * 1) Official OpenAI endpoint + env key:
 *    - Set OPENAI_API_KEY in your shell.
 *    - model: getModel("openai", "gpt-4o-mini")
 *
 * 2) Custom OpenAI-compatible base URL:
 *    - Put baseUrl/apiKey in config (see ConfigManager).
 *    - getApiKey callback can return provider-specific keys at runtime.
 *
 * 3) Per-provider key dispatch:
 *    - getApiKey: async (provider) => provider === "openai" ? "sk-..." : undefined
 */

export function createAgentRuntime(agentRuntimeconfig: AgentRuntimeConfig): PiAgent {
  const model: Model<any> = agentRuntimeconfig.model;
  const tools = agentRuntimeconfig.toolRegistry.getTools();

  return new PiAgent({
    initialState: {
      systemPrompt: agentRuntimeconfig.systemPrompt,
      model,
      thinkingLevel: agentRuntimeconfig.thinkingLevel,
      tools: tools,
      messages: [],
    },
    convertToLlm: agentRuntimeconfig.convertToLlm ?? defaultConvertToLlm,
    transformContext: agentRuntimeconfig.transformContext,
    sessionId: agentRuntimeconfig.sessionId,
    getApiKey: agentRuntimeconfig.getApiKey,
    onPayload: agentRuntimeconfig.onPayload as any,
    thinkingBudgets: agentRuntimeconfig.thinkingBudgets as any,
    transport: agentRuntimeconfig.transport,
    maxRetryDelayMs: agentRuntimeconfig.maxRetryDelayMs,
  } as any);
}

function defaultConvertToLlm(messages: AgentMessage[]): AgentMessage[] {
  // Beginner note:
  // This default converter only filters by role; it does NOT strip fields from messages.
  // So for tool results, both `content` and `details` are kept on the message object
  // that is passed to the LLM adapter.
  //
  // If you want to hide `details` from the LLM (and keep it app-only),
  // customize `convertToLlm` and explicitly map toolResult messages.
  return messages.filter((message) => {
    const role = (message as any).role;
    return role === "user" || role === "assistant" || role === "toolResult";
  });
}

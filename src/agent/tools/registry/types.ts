import type { AgentTool } from "@mariozechner/pi-agent-core";

export type ToolCategory = "standard" | "addon";

export interface DescribedAgentTool extends AgentTool<any> {
  toolRulePrompt?: string;
}

export interface RegisteredTool {
  category: ToolCategory;
  tool: DescribedAgentTool;
}

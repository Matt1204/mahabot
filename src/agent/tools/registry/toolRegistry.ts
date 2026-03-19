import type { AgentTool } from "@mariozechner/pi-agent-core";

import type { DescribedAgentTool, RegisteredTool } from "./types.js";

export class ToolRegistry {
  private readonly ordered: RegisteredTool[] = [];
  private readonly byName = new Set<string>();

  registerStandard(tool: DescribedAgentTool): void {
    this.register(tool, "standard");
  }

  registerAddon(_tool: DescribedAgentTool): void {
    throw new Error("Add-on tool registration is disabled in this phase.");
  }

  getTools(): AgentTool<any>[] {
    return this.ordered.map((entry) => entry.tool);
  }

  getToolNames(): string[] {
    return this.ordered.map((entry) => entry.tool.name);
  }

  getAllToolRulePrompts(): Array<{ name: string; toolRulePrompt: string }> {
    return this.ordered.flatMap((entry) => {
      const toolRulePrompt = entry.tool.toolRulePrompt?.trim();
      if (!toolRulePrompt) {
        return [];
      }

      return [{ name: entry.tool.name, toolRulePrompt }];
    });
  }

  private register(tool: DescribedAgentTool, category: RegisteredTool["category"]): void {
    const name = tool?.name?.trim();
    if (!name) {
      throw new Error("Invalid tool: name is required.");
    }

    if (this.byName.has(name)) {
      throw new Error(
        `Duplicate tool name '${name}'. Ensure each Standard tool name is globally unique.`
      );
    }

    this.byName.add(name);
    this.ordered.push({ category, tool });
  }
}

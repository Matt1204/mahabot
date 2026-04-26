import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { renderSkillsPromptSection, resolveBuiltinSkillsRoot, SkillsCatalogService } from "../agent/skills/index.js";
import type { ToolRegistry } from "../agent/tools/registry/toolRegistry.js";
import type { ConfigManager, PromptScaffoldFileName } from "../config/configManager.js";
import type { ContextAssemblyResult, PromptSection } from "./types.js";

type ContextLogger = Pick<Console, "debug" | "warn" | "error">;

export class ContextManager {
  constructor(
    private readonly configManager: ConfigManager,
    private readonly logger: ContextLogger = console,
    private readonly skillsCatalogService: SkillsCatalogService = new SkillsCatalogService()
  ) {}

  async assembleSystemPrompt(
    workspaceSessionId: string,
    sessionRoot: string,
    workspaceRoot: string,
    persistenceRoot: string,
    toolRegistry: ToolRegistry
  ): Promise<ContextAssemblyResult> {
    const agentsPath = resolve(sessionRoot, "AGENTS.md");
    const soulPath = resolve(workspaceRoot, "SOUL.md");
    const userPath = resolve(workspaceRoot, "USER.md");

    const agents = await this.readRequiredFile(
      agentsPath,
      "AGENTS.md",
      "Re-run `mahabot cli` to regenerate workspace files or restore this file manually."
    );

    const usedTemplateFallback: Array<"SOUL.md" | "USER.md"> = [];
    await this.ensureOptionalPromptFile(sessionRoot, "SOUL.md", usedTemplateFallback);
    await this.ensureOptionalPromptFile(sessionRoot, "USER.md", usedTemplateFallback);

    const soul = await this.readRequiredFile(
      soulPath,
      "SOUL.md",
      "Template recovery was attempted. Verify file permissions and template availability."
    );
    const user = await this.readRequiredFile(
      userPath,
      "USER.md",
      "Template recovery was attempted. Verify file permissions and template availability."
    );

    const skillsSummary = await this.skillsCatalogService.buildSkillsSummary({
      workspaceSkillsRoot: resolve(workspaceRoot, "skills"),
      builtinSkillsRoot: resolveBuiltinSkillsRoot(),
    });

    const sections: PromptSection[] = [
      { id: "agents", required: true, content: agents.trim() },
      {
        id: "runtime",
        required: true,
        content: this.buildRuntimeSection(
          workspaceSessionId,
          workspaceRoot,
          resolve(persistenceRoot, "history.md"),
          resolve(persistenceRoot, "session.sqlite")
        ),
      },
      {
        id: "tools",
        required: false,
        content: this.buildToolsPromptSection(toolRegistry),
      },
      { id: "soul", required: false, content: soul.trim() },
      { id: "user", required: false, content: user.trim() },
      {
        id: "skills",
        required: false,
        content: renderSkillsPromptSection(skillsSummary.skills),
      },
    ];

    const systemPrompt = sections
      .map((section) => section.content)
      .filter((content) => content.length > 0)
      .join("\n\n");

    this.logger.debug(
      `[skills_catalog] scanned=${skillsSummary.stats.scanned} loaded=${skillsSummary.stats.loaded} skipped=${skillsSummary.stats.skipped} warnings=${skillsSummary.warnings.length}`
    );
    for (const warning of skillsSummary.warnings) {
      this.logger.warn(
        `[skills_catalog] code=${warning.code} location=${warning.location} message=${warning.message}`
      );
    }

    this.logger.debug(
      `[context_manager] assembled prompt from ${sessionRoot} (${systemPrompt.length} chars)`
    );

    return {
      systemPrompt,
      sections,
      diagnostics: {
        promptCharCount: systemPrompt.length,
        usedTemplateFallback,
      },
    };
  }

  private async ensureOptionalPromptFile(
    sessionRoot: string,
    fileName: PromptScaffoldFileName,
    usedTemplateFallback: Array<"SOUL.md" | "USER.md">
  ): Promise<void> {
    const result = await this.configManager.ensurePromptScaffoldIfMissing(sessionRoot, fileName);
    if (result.created) {
      usedTemplateFallback.push(fileName);
      this.logger.warn(
        `[context_manager] missing ${fileName}; created from template at ${result.filePath}`
      );
    }
  }

  private async readRequiredFile(path: string, label: string, remediation: string): Promise<string> {
    try {
      return await readFile(path, "utf-8");
    } catch (error) {
      throw new Error(
        `Failed to read required prompt file '${label}' at '${path}'. ${remediation} Original error: ${String(
          error
        )}`
      );
    }
  }

  private buildRuntimeSection(
    workspaceSessionId: string,
    workspaceRoot: string,
    historyPath: string,
    sessionDbPath: string
  ): string {
    const pythonVersion = process.env.PYTHON_VERSION ?? "unavailable";

    return [
      "## Runtime Context",
      `workspaceSessionId: ${workspaceSessionId}`,
      `platform: ${process.platform}`,
      `node: ${process.version}`,
      `python: ${pythonVersion}`,
      `workspaceRoot: ${workspaceRoot}`,
      `historyPath: ${historyPath} (reserved for conversation transcript persistence)`,
      `sessionDbPath: ${sessionDbPath} (reserved for structured turn persistence)`,
    ].join("\n");
  }

  private buildToolsPromptSection(toolRegistry: ToolRegistry): string {
    const rulesOfTools = toolRegistry.getAllToolRulePrompts();
    if (rulesOfTools.length === 0) {
      return "";
    }

    const lines = rulesOfTools.map(
      ({ name, toolRulePrompt }) => `- \`${name}\`: ${toolRulePrompt}`
    );

    return ["## Tools", ...lines].join("\n");
  }
}

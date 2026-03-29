import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, test } from "node:test";

import { ToolRegistry } from "../../src/agent/tools/registry/toolRegistry.ts";
import { ContextManager } from "../../src/context/contextManager.ts";

describe("ContextManager skills integration", () => {
  test("appends skills section at the end with metadata-only progressive discovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "context-manager-skills-test-"));
    const sessionRoot = join(root, "session");
    const workspaceRoot = join(sessionRoot, "workspace");
    const persistenceRoot = join(workspaceRoot, "persistence");

    try {
      await mkdir(persistenceRoot, { recursive: true });
      await mkdir(join(workspaceRoot, "skills", "review"), { recursive: true });

      await writeFile(join(sessionRoot, "AGENTS.md"), "# Agents\n", "utf-8");
      await writeFile(join(workspaceRoot, "SOUL.md"), "# Soul\n", "utf-8");
      await writeFile(join(workspaceRoot, "USER.md"), "# User\n", "utf-8");
      await writeFile(
        join(workspaceRoot, "skills", "review", "SKILL.md"),
        [
          "---",
          "name: review",
          "description: Review pull requests. Use when user asks for review.",
          "---",
          "# SECRET BODY",
          "Do not preload this line in system prompt.",
        ].join("\n"),
        "utf-8"
      );

      const configManagerStub = {
        async ensurePromptScaffoldIfMissing(currentSessionRoot: string, fileName: "SOUL.md" | "USER.md") {
          return {
            created: false,
            filePath: join(currentSessionRoot, "workspace", fileName),
          };
        },
      };

      const contextManager = new ContextManager(
        configManagerStub as any,
        {
          debug: () => {},
          warn: () => {},
          error: () => {},
        }
      );

      const registry = new ToolRegistry();
      const result = await contextManager.assembleSystemPrompt(
        "session-1",
        sessionRoot,
        workspaceRoot,
        persistenceRoot,
        registry
      );

      assert.equal(result.sections[result.sections.length - 1]?.id, "skills");
      const skillsSection = result.sections.find((section) => section.id === "skills");
      assert.ok(skillsSection);
      assert.match(skillsSection.content, /^## Skills/m);
      assert.match(skillsSection.content, /<name>review<\/name>/);
      assert.doesNotMatch(result.systemPrompt, /Do not preload this line in system prompt\./);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

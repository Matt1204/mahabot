import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { describe, test } from "node:test";

import { SkillsCatalogService } from "../../src/agent/skills/skillsCatalogService.ts";

async function withFixture(
  files: Record<string, string>,
  run: (root: string) => Promise<void>
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "skills-catalog-service-test-"));
  try {
    for (const [relativePath, content] of Object.entries(files)) {
      const absolutePath = join(root, relativePath);
      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, content, "utf-8");
    }
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("SkillsCatalogService", () => {
  test("merges builtin and workspace skills with workspace override and stable sort", async () => {
    await withFixture(
      {
        "workspace/skills/review/SKILL.md": [
          "---",
          "name: review",
          "description: Workspace override. Use when user asks for review.",
          "---",
          "# Workspace review body",
        ].join("\n"),
        "builtin/skills/review/SKILL.md": [
          "---",
          "name: review",
          "description: Builtin review. Use when user asks for review.",
          "---",
          "# Builtin review body",
        ].join("\n"),
        "builtin/skills/triage/SKILL.md": [
          "---",
          "name: triage",
          "description: Triage tasks. Use when user asks for triage.",
          "---",
        ].join("\n"),
      },
      async (root) => {
        const service = new SkillsCatalogService();
        const result = await service.buildSkillsSummary({
          workspaceSkillsRoot: join(root, "workspace", "skills"),
          builtinSkillsRoot: join(root, "builtin", "skills"),
        });

        assert.equal(result.stats.scanned, 3);
        assert.equal(result.stats.skipped, 0);
        assert.equal(result.stats.loaded, 2);
        assert.deepEqual(
          result.skills.map((skill) => skill.name),
          ["review", "triage"]
        );
        assert.equal(result.skills[0]?.description, "Workspace override. Use when user asks for review.");
        assert.match(
          result.skills[0]?.location ?? "",
          /workspace\/skills\/review\/SKILL\.md$/
        );
        assert.match(result.xmlSummary, /<skills>/);
        assert.match(result.xmlSummary, /<name>review<\/name>/);
      }
    );
  });

  test("skips parse failures and keeps warning diagnostics", async () => {
    await withFixture(
      {
        "workspace/skills/bad/SKILL.md": "name: missing delimiters",
      },
      async (root) => {
        const service = new SkillsCatalogService();
        const result = await service.buildSkillsSummary({
          workspaceSkillsRoot: join(root, "workspace", "skills"),
          builtinSkillsRoot: join(root, "builtin", "skills"),
        });

        assert.equal(result.stats.scanned, 1);
        assert.equal(result.stats.loaded, 0);
        assert.equal(result.stats.skipped, 1);
        assert.equal(result.skills.length, 0);
        assert.equal(result.warnings.length, 1);
        assert.equal(result.warnings[0]?.code, "parse_failed");
      }
    );
  });
});


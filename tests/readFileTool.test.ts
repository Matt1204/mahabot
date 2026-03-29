import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { describe, test } from "node:test";

import { createReadFileTool } from "../src/agent/tools/readFileTool.ts";

async function withFixture(
  files: Record<string, string>,
  run: (root: string) => Promise<void>
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "read-file-tool-test-"));
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

function getText(result: { content: Array<{ type: string; text?: string }> }): string {
  const textBlock = result.content.find((part) => part.type === "text");
  assert.ok(textBlock?.text);
  return textBlock.text;
}

describe("createReadFileTool", () => {
  test("allows reading builtin SKILL.md outside workspace when restricted", async () => {
    await withFixture(
      {
        "workspace/README.md": "workspace file\n",
        "repo/src/agent/skills/review/SKILL.md": "---\nname: review\ndescription: review code\n---\n# Review skill\n",
      },
      async (root) => {
        const workspaceRoot = join(root, "workspace");
        const builtinSkillsRoot = join(root, "repo", "src", "agent", "skills");
        const skillPath = join(builtinSkillsRoot, "review", "SKILL.md");

        const tool = createReadFileTool({
          workspaceRoot,
          restrictToWorkspace: true,
          builtinSkillsRoot,
        });

        const result = await tool.execute("call-1", { path: skillPath });
        const details = result.details as any;
        const text = getText(result as any);

        assert.equal(details.ok, true);
        assert.equal(details.resolvedPath, await realpath(skillPath));
        assert.match(text, /# Review skill/);
      }
    );
  });

  test("rejects paths outside both workspace and builtin skill roots", async () => {
    await withFixture(
      {
        "workspace/a.txt": "ok\n",
        "outside.txt": "nope\n",
      },
      async (root) => {
        const workspaceRoot = join(root, "workspace");
        const builtinSkillsRoot = join(root, "repo", "src", "agent", "skills");
        const outsidePath = join(root, "outside.txt");

        const tool = createReadFileTool({
          workspaceRoot,
          restrictToWorkspace: true,
          builtinSkillsRoot,
        });

        const result = await tool.execute("call-2", { path: outsidePath });
        const details = result.details as any;

        assert.equal(details.ok, false);
        assert.equal(details.errorCode, "outside_workspace");
      }
    );
  });

  test("returns invalid_max_bytes for invalid maxBytes input", async () => {
    await withFixture(
      {
        "workspace/a.txt": "hello\n",
      },
      async (root) => {
        const workspaceRoot = join(root, "workspace");
        const builtinSkillsRoot = join(root, "repo", "src", "agent", "skills");

        const tool = createReadFileTool({
          workspaceRoot,
          restrictToWorkspace: true,
          builtinSkillsRoot,
        });

        const result = await tool.execute("call-3", {
          path: join(workspaceRoot, "a.txt"),
          maxBytes: 128,
        });
        const details = result.details as any;

        assert.equal(details.ok, false);
        assert.equal(details.errorCode, "invalid_max_bytes");
      }
    );
  });

  test("includes skill discovery guidance in toolRulePrompt", () => {
    const tool = createReadFileTool({
      workspaceRoot: "/tmp/workspace",
      restrictToWorkspace: true,
      builtinSkillsRoot: "/repo/src/agent/skills",
    });

    assert.ok(tool.toolRulePrompt);
    assert.match(tool.toolRulePrompt as string, /SKILL\.md/);
    assert.match(tool.toolRulePrompt as string, /read_file/);
    assert.match(tool.toolRulePrompt as string, /\/repo\/src\/agent\/skills/);
  });
});

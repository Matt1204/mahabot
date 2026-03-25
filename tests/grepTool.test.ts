import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { describe, test } from "node:test";

import { createGrepTool } from "../src/agent/tools/grepTool.ts";

type FileFixture = string | Uint8Array;

async function withWorkspace(
  files: Record<string, FileFixture>,
  run: (workspaceRoot: string) => Promise<void>
): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "grep-tool-test-"));
  try {
    for (const [relativePath, content] of Object.entries(files)) {
      const absolutePath = join(workspaceRoot, relativePath);
      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, content);
    }
    await run(workspaceRoot);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

function getText(result: { content: Array<{ type: string; text?: string }> }): string {
  const textBlock = result.content.find((part) => part.type === "text");
  assert.ok(textBlock?.text);
  return textBlock.text;
}

describe("createGrepTool", () => {
  test("returns literal matches with default context lines", async () => {
    await withWorkspace(
      {
        "src/a.ts": "alpha\nbeta target\ngamma\n",
      },
      async (workspaceRoot) => {
        const tool = createGrepTool({ workspaceRoot, restrictToWorkspace: true });
        const result = await tool.execute("call-1", { pattern: "target" });
        const details = result.details as any;

        assert.equal(details.ok, true);
        assert.equal(details.returnedMatches, 1);
        assert.equal(details.matches[0].path, "src/a.ts");
        assert.equal(details.matches[0].line, 2);
        assert.deepEqual(details.matches[0].before, ["alpha"]);
        assert.deepEqual(details.matches[0].after, ["gamma"]);
      }
    );
  });

  test("supports case-insensitive literal search", async () => {
    await withWorkspace(
      {
        "file.txt": "Hello\nHELLO\nbye\n",
      },
      async (workspaceRoot) => {
        const tool = createGrepTool({ workspaceRoot, restrictToWorkspace: true });
        const result = await tool.execute("call-2", {
          pattern: "hello",
          caseSensitive: false,
        });
        const details = result.details as any;

        assert.equal(details.ok, true);
        assert.equal(details.returnedMatches, 2);
        assert.deepEqual(
          details.matches.map((entry: any) => entry.line),
          [1, 2]
        );
      }
    );
  });

  test("supports regex and returns multiple spans for one line", async () => {
    await withWorkspace(
      {
        "regex.txt": "foo bar foo\n",
      },
      async (workspaceRoot) => {
        const tool = createGrepTool({ workspaceRoot, restrictToWorkspace: true });
        const result = await tool.execute("call-3", {
          pattern: "foo",
          isRegex: true,
        });
        const details = result.details as any;

        assert.equal(details.ok, true);
        assert.equal(details.returnedMatches, 1);
        assert.deepEqual(details.matches[0].spans, [
          { startColumn: 1, endColumn: 3 },
          { startColumn: 9, endColumn: 11 },
        ]);
      }
    );
  });

  test("respects include/exclude globs and hidden-file default skip", async () => {
    await withWorkspace(
      {
        ".secret.txt": "target\n",
        "src/include.ts": "target\n",
        "src/ignore/skip.ts": "target\n",
      },
      async (workspaceRoot) => {
        const tool = createGrepTool({ workspaceRoot, restrictToWorkspace: true });
        const result = await tool.execute("call-4", {
          pattern: "target",
          include: ["src/**/*.ts"],
          exclude: ["src/ignore/**"],
        });
        const details = result.details as any;

        assert.equal(details.ok, true);
        assert.equal(details.returnedMatches, 1);
        assert.equal(details.matches[0].path, "src/include.ts");
        assert.ok(details.filesSkippedHidden >= 1);
        assert.ok(details.filesSkippedExcluded >= 1);
      }
    );
  });

  test("marks truncation when maxMatches is reached", async () => {
    await withWorkspace(
      {
        "many.txt": "hit\nhit\nhit\n",
      },
      async (workspaceRoot) => {
        const tool = createGrepTool({ workspaceRoot, restrictToWorkspace: true });
        const result = await tool.execute("call-5", {
          pattern: "hit",
          maxMatches: 2,
        });
        const details = result.details as any;

        assert.equal(details.ok, true);
        assert.equal(details.returnedMatches, 2);
        assert.equal(details.truncated, true);
        assert.equal(details.truncatedBy, "max_matches");
      }
    );
  });

  test("marks truncation when maxFiles is reached", async () => {
    await withWorkspace(
      {
        "a.txt": "first\n",
        "b.txt": "second\n",
      },
      async (workspaceRoot) => {
        const tool = createGrepTool({ workspaceRoot, restrictToWorkspace: true });
        const result = await tool.execute("call-6", {
          pattern: "second",
          maxFiles: 1,
        });
        const details = result.details as any;

        assert.equal(details.ok, true);
        assert.equal(details.truncated, true);
        assert.equal(details.truncatedBy, "max_files");
        assert.equal(details.filesScanned, 1);
      }
    );
  });

  test("skips binary files", async () => {
    await withWorkspace(
      {
        "bin/data.bin": new Uint8Array([0, 1, 2, 3]),
        "text.txt": "target\n",
      },
      async (workspaceRoot) => {
        const tool = createGrepTool({ workspaceRoot, restrictToWorkspace: true });
        const result = await tool.execute("call-7", { pattern: "target" });
        const details = result.details as any;

        assert.equal(details.ok, true);
        assert.equal(details.returnedMatches, 1);
        assert.equal(details.filesSkippedBinary, 1);
      }
    );
  });

  test("returns invalid_regex error for malformed regex patterns", async () => {
    await withWorkspace({}, async (workspaceRoot) => {
      const tool = createGrepTool({ workspaceRoot, restrictToWorkspace: true });
      const result = await tool.execute("call-8", {
        pattern: "[",
        isRegex: true,
      });
      const details = result.details as any;

      assert.equal(details.ok, false);
      assert.equal(details.errorCode, "invalid_regex");
      assert.match(getText(result as any), /^Grep failed:/);
    });
  });
});

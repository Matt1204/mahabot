import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { describe, test } from "node:test";

import { createGlobTool } from "../src/agent/tools/globTool.ts";

type FileFixture = string | Uint8Array;

async function withWorkspace(
  files: Record<string, FileFixture>,
  run: (workspaceRoot: string) => Promise<void>
): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "glob-tool-test-"));
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

describe("createGlobTool", () => {
  test("returns matching files and applies default excludes", async () => {
    await withWorkspace(
      {
        "src/a.ts": "export const a = 1;\n",
        "src/b.js": "console.log('x')\n",
        "node_modules/pkg/index.ts": "export const bad = 1;\n",
        "dist/out.ts": "export const bad = 2;\n",
      },
      async (workspaceRoot) => {
        const tool = createGlobTool({ workspaceRoot, restrictToWorkspace: true });
        const result = await tool.execute("call-1", { pattern: "**/*.ts" });
        const details = result.details as any;

        assert.equal(details.ok, true);
        assert.equal(details.truncated, false);
        assert.deepEqual(
          details.matches.map((entry: any) => entry.path),
          ["src/a.ts"]
        );
      }
    );
  });

  test("skips hidden entries by default", async () => {
    await withWorkspace(
      {
        ".hidden.ts": "secret\n",
        "visible.ts": "ok\n",
      },
      async (workspaceRoot) => {
        const tool = createGlobTool({ workspaceRoot, restrictToWorkspace: true });
        const result = await tool.execute("call-2", { pattern: "**/*.ts" });
        const details = result.details as any;

        assert.equal(details.ok, true);
        assert.deepEqual(
          details.matches.map((entry: any) => entry.path),
          ["visible.ts"]
        );
      }
    );
  });

  test("supports directory-only mode and returns relative paths", async () => {
    await withWorkspace(
      {
        "src/core/a.ts": "x\n",
        "src/core/b.ts": "y\n",
      },
      async (workspaceRoot) => {
        const tool = createGlobTool({ workspaceRoot, restrictToWorkspace: true });
        const result = await tool.execute("call-3", {
          pattern: "src/**",
          includeFiles: false,
          includeDirectories: true,
        });
        const details = result.details as any;

        assert.equal(details.ok, true);
        assert.deepEqual(
          details.matches.map((entry: any) => entry.path),
          ["src", "src/core"]
        );
        assert.ok(details.matches.every((entry: any) => entry.type === "dir"));
      }
    );
  });

  test("returns invalid_glob for malformed patterns", async () => {
    await withWorkspace({}, async (workspaceRoot) => {
      const tool = createGlobTool({ workspaceRoot, restrictToWorkspace: true });
      const result = await tool.execute("call-4", { pattern: "[" });
      const details = result.details as any;

      assert.equal(details.ok, false);
      assert.equal(details.errorCode, "invalid_glob");
    });
  });

  test("avoids symlink recursion cycles when followSymlinks=true", async () => {
    await withWorkspace(
      {
        "cycle/file.txt": "hello\n",
      },
      async (workspaceRoot) => {
        await symlink("../cycle", join(workspaceRoot, "cycle/link"), "dir");

        const tool = createGlobTool({ workspaceRoot, restrictToWorkspace: true });
        const result = await tool.execute("call-5", {
          pattern: "**/*.txt",
          followSymlinks: true,
          maxResults: 20,
        });
        const details = result.details as any;

        assert.equal(details.ok, true);
        assert.equal(details.truncated, false);
        assert.ok(details.returnedMatches >= 1);
        assert.ok(
          details.matches.some((entry: any) => entry.path === "cycle/file.txt"),
          "expected base file match"
        );
      }
    );
  });
});

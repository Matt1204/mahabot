import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { createBashTool } from "../src/agent/tools/bashTool.ts";

async function withTempWorkspace<T>(run: (workspaceRoot: string) => Promise<T>): Promise<T> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "mahabot-bash-tool-"));
  try {
    return await run(workspaceRoot);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

describe("createBashTool", () => {
  test("uses a 60000ms default timeout and returns it in details", async () => {
    await withTempWorkspace(async (workspaceRoot) => {
      const tool = createBashTool({ workspaceRoot, restrictToWorkspace: false });

      const result = await tool.execute("tc-default-timeout", {
        command: "printf ok",
        toolDescription: "print ok",
      });

      assert.equal(result.details.timeoutMs, 60000);
      assert.match(result.content[0].text, /- timeoutMs: 60000/);
    });
  });

  test("uses model-provided timeoutMs and returns it in details", async () => {
    await withTempWorkspace(async (workspaceRoot) => {
      const tool = createBashTool({ workspaceRoot, restrictToWorkspace: false });

      const result = await tool.execute("tc-custom-timeout", {
        command: "printf ok",
        toolDescription: "print ok",
        timeoutMs: 1000,
      });

      assert.equal(result.details.timeoutMs, 1000);
      assert.match(result.content[0].text, /- timeoutMs: 1000/);
    });
  });

  test("rejects timeoutMs outside the allowed range", async () => {
    await withTempWorkspace(async (workspaceRoot) => {
      const tool = createBashTool({ workspaceRoot, restrictToWorkspace: false });

      const result = await tool.execute("tc-invalid-timeout", {
        command: "printf ok",
        toolDescription: "print ok",
        timeoutMs: 500,
      });

      assert.equal(result.details.blockedReason, "invalid_timeout_ms");
      assert.match(result.content[0].text, /invalid_timeout_ms/);
    });
  });
});

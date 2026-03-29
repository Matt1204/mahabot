import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "node:test";

import { ConfigManager } from "../../src/config/configManager.ts";

describe("ConfigManager skills workspace bootstrap", () => {
  test("initializeSessionWorkspace ensures workspace/skills exists", async () => {
    const sessionId = `skills-test-${randomUUID()}`;
    let sessionRootForCleanup: string | null = null;

    try {
      const manager = new ConfigManager();
      const bootstrap = await manager.initializeSessionWorkspace(sessionId);
      sessionRootForCleanup = bootstrap.sessionRoot;

      const skillsRoot = join(bootstrap.workspaceRoot, "skills");
      const skillsStats = await stat(skillsRoot);
      assert.equal(skillsStats.isDirectory(), true);
    } finally {
      if (sessionRootForCleanup) {
        await rm(sessionRootForCleanup, { recursive: true, force: true });
      }
    }
  });
});

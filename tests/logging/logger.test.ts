import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { createLogger } from "../../src/logging/index.ts";
import type { LoggingConfig } from "../../src/logging/index.ts";

const baseConfig: LoggingConfig = {
  level: "info",
  persist: true,
  path: "logs/latest.ndjson",
  maxEntries: 100,
  maxAgeMs: 60_000,
  compactEveryWrites: 100,
  compactIntervalMs: 60_000,
  debugEvents: false,
  redactMessageText: true,
  messagePreviewChars: 120,
  includeStack: false,
};

describe("createLogger", () => {
  test("writes structured events to NDJSON and redacts secret-looking data", async () => {
    const root = await mkdtemp(join(tmpdir(), "mahabot-logger-"));
    const lines: string[] = [];
    try {
      const logger = createLogger({
        config: baseConfig,
        persistenceRoot: root,
        sessionId: "session-1",
        now: () => 1234,
        consoleLike: {
          debug: () => undefined,
          info: (line) => lines.push(String(line)),
          warn: () => undefined,
          error: () => undefined,
        },
      });

      logger.info({
        category: "agent_turn",
        event: "agent_turn.start",
        component: "test",
        summary: "started",
        data: {
          apiKey: "secret",
          visible: "ok",
        },
      });
      await logger.flush();

      assert.match(lines[0]!, /agent_turn\.start/);
      const raw = await readFile(join(root, "logs", "latest.ndjson"), "utf-8");
      const parsed = JSON.parse(raw.trim());
      assert.equal(parsed.sessionId, "session-1");
      assert.equal(parsed.data.apiKey, "[redacted]");
      assert.equal(parsed.data.visible, "ok");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not persist debug events unless debugEvents is enabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "mahabot-logger-"));
    try {
      const logger = createLogger({
        config: {
          ...baseConfig,
          level: "debug",
          debugEvents: false,
        },
        persistenceRoot: root,
        now: () => 1234,
        consoleLike: {
          debug: () => undefined,
          info: () => undefined,
          warn: () => undefined,
          error: () => undefined,
        },
      });

      logger.debug({
        category: "context",
        event: "context.compact_skipped",
        component: "test",
        summary: "skipped",
      });
      await logger.flush();

      const raw = await readFile(join(root, "logs", "latest.ndjson"), "utf-8").catch(() => "");
      assert.equal(raw, "");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

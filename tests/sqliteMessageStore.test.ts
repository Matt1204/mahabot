import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, test } from "node:test";
import { DatabaseSync } from "node:sqlite";

import type { AgentMessage } from "@mariozechner/pi-agent-core";

import { SqliteMessageStore } from "../src/agent/persistence/sqliteMessageStore.ts";

describe("SqliteMessageStore", () => {
  test("appends and reads records for the configured session only", async () => {
    const root = await mkdtemp(join(tmpdir(), "sqlite-message-store-test-"));
    const sessionDbPath = join(root, "session.sqlite");
    const warns: string[] = [];

    try {
      const store = new SqliteMessageStore(
        { sessionId: "s1", sessionDbPath },
        { now: () => 2000, logger: { warn: (line) => warns.push(line) } }
      );

      await store.appendMessages([
        {
          role: "user",
          content: [{ type: "text", text: "hello" }],
          timestamp: 1,
        } as AgentMessage,
      ]);

      const db = new DatabaseSync(sessionDbPath);
      try {
        db.prepare(
          "INSERT INTO messages (schema_version, session_id, persisted_at, message_json) VALUES (?, ?, ?, ?)"
        ).run(1, "other", 2001, JSON.stringify({
          role: "user",
          content: [{ type: "text", text: "skip other session" }],
          timestamp: 2,
        }));
        db.prepare(
          "INSERT INTO messages (schema_version, session_id, persisted_at, message_json) VALUES (?, ?, ?, ?)"
        ).run(1, "s1", 2002, "{not-json");
      } finally {
        db.close();
      }

      const records = await store.readAll();
      assert.equal(records.length, 1);
      assert.equal(records[0]!.schemaVersion, 1);
      assert.equal(records[0]!.sessionId, "s1");
      assert.equal(records[0]!.persistedAt, 2000);
      assert.deepEqual(records[0]!.message, {
        role: "user",
        content: [{ type: "text", text: "hello" }],
        timestamp: 1,
      });
      assert.equal(
        warns.some((line) => line.includes("skipping invalid SQLite message row")),
        true
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

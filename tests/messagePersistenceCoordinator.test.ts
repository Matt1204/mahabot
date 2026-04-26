import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, test } from "node:test";

import type { AgentMessage } from "@mariozechner/pi-agent-core";

import { MessagePersistenceCoordinator } from "../src/agent/persistence/messagePersistenceCoordinator.ts";
import { SqliteMessageStore } from "../src/agent/persistence/sqliteMessageStore.ts";

function message(role: "user" | "assistant", text: string, timestamp: number): AgentMessage {
  return {
    role,
    content: [{ type: "text", text }],
    timestamp,
  } as AgentMessage;
}

describe("MessagePersistenceCoordinator", () => {
  test("persists image blocks with base64 intact so restored context shape is unchanged", async () => {
    const root = await mkdtemp(join(tmpdir(), "message-persistence-coordinator-image-test-"));
    const sessionDbPath = join(root, "session.sqlite");

    try {
      const config = {
        enabled: true,
        sessionId: "session-1",
        sessionDbPath,
        startupRestoreMessageCount: 10,
        compactHighWatermarkTokens: 100,
        compactLowWatermarkTokens: 40,
      };
      const coordinator = new MessagePersistenceCoordinator(config);
      const imageMessage = {
        role: "user",
        content: [
          {
            type: "image",
            data: "base64-data",
            mimeType: "image/jpeg",
            sourcePath: "/tmp/photo.jpg",
          },
          {
            type: "text",
            text: "这是什么？",
          },
        ],
        timestamp: 123,
      } as unknown as AgentMessage;

      const persisted = await coordinator.persistPendingMessages([imageMessage]);
      assert.equal(persisted.persistedCount, 1);

      const store = new SqliteMessageStore({
        sessionId: "session-1",
        sessionDbPath,
      });
      const records = await store.readAll();
      assert.equal(records.length, 1);

      const content = (records[0]!.message as any).content;
      assert.equal(content[0].type, "image");
      assert.equal(content[0].data, "base64-data");
      assert.equal(content[0].mimeType, "image/jpeg");
      assert.equal(content[0].sourcePath, "/tmp/photo.jpg");
      assert.deepEqual(content[1], {
        type: "text",
        text: "这是什么？",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("restores aligned startup window, persists pending tail, and compacts by token watermark", async () => {
    const root = await mkdtemp(join(tmpdir(), "message-persistence-coordinator-test-"));
    const sessionDbPath = join(root, "session.sqlite");

    try {
      const config = {
        enabled: true,
        sessionId: "session-1",
        sessionDbPath,
        startupRestoreMessageCount: 2,
        compactHighWatermarkTokens: 100,
        compactLowWatermarkTokens: 40,
      };

      const seedCoordinator = new MessagePersistenceCoordinator(config);
      const seedMessages = [
        message("user", "u1", 1),
        message("assistant", "a1", 2),
        message("user", "u2", 3),
        message("assistant", "a2", 4),
      ];
      const seeded = await seedCoordinator.persistPendingMessages(seedMessages);
      assert.equal(seeded.persistedCount, 4);
      assert.equal(seeded.persistedCursor, 4);

      const coordinator = new MessagePersistenceCoordinator(config);
      const loaded = await coordinator.loadPersistedContextWindow([]);
      assert.deepEqual(
        loaded.messages.map((entry) => ((entry as any).content?.[0] as { text?: string })?.text),
        ["u2", "a2"]
      );
      assert.equal(loaded.persistedCursor, 2);

      const inMemoryMessages = [
        ...loaded.messages,
        message("user", "u3", 5),
        message("assistant", "a3", 6),
        message("user", "u4", 7),
        message("assistant", "a4", 8),
      ];
      coordinator.noteTurnUsage({ totalTokens: 300 });

      const compacted = await coordinator.compactContextIfNeeded(inMemoryMessages);
      assert.equal(compacted.didCompact, true);
      assert.equal(compacted.persistedCursor, 2);
      assert.deepEqual(
        compacted.messages.map((entry) => ((entry as any).content?.[0] as { text?: string })?.text),
        ["u4", "a4"]
      );

      const flushAfterCompact = await coordinator.persistPendingMessages(compacted.messages);
      assert.equal(flushAfterCompact.persistedCount, 0);
      assert.equal(flushAfterCompact.persistedCursor, 2);

      const store = new SqliteMessageStore({
        sessionId: "session-1",
        sessionDbPath,
      });
      const allRecords = await store.readAll();
      assert.equal(allRecords.length, 8);
      assert.deepEqual(
        allRecords.map((entry) => ((entry.message as any).content?.[0] as { text?: string })?.text),
        ["u1", "a1", "u2", "a2", "u3", "a3", "u4", "a4"]
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, test } from "node:test";

import type { AgentMessage } from "@mariozechner/pi-agent-core";

import { JsonlMessageStore } from "../src/agent/persistence/jsonlMessageStore.ts";

function message(role: "user" | "assistant", text: string, timestamp: number): AgentMessage {
  return {
    role,
    content: [{ type: "text", text }],
    timestamp,
  } as AgentMessage;
}

describe("JsonlMessageStore", () => {
  test("appends and reads records while tolerating malformed trailing line", async () => {
    const root = await mkdtemp(join(tmpdir(), "jsonl-store-test-"));
    const sessionJsonlPath = join(root, "session.jsonl");
    const warns: string[] = [];

    try {
      const store = new JsonlMessageStore(
        { sessionId: "s1", sessionJsonlPath },
        { logger: { warn: (line) => warns.push(line) }, now: () => 1000 }
      );

      await store.appendMessages([
        message("user", "hello", 1),
        message("assistant", "hi", 2),
      ]);

      await appendFile(
        sessionJsonlPath,
        [
          JSON.stringify({
            schemaVersion: 1,
            sessionId: "other-session",
            persistedAt: 2000,
            message: message("user", "ignore-me", 3),
          }),
          "{\"schemaVersion\":1",
        ].join("\n"),
        "utf-8"
      );

      const records = await store.readAll();
      assert.equal(records.length, 2);
      assert.equal(((records[0]?.message as any).content?.[0] as { text?: string })?.text, "hello");
      assert.equal(((records[1]?.message as any).content?.[0] as { text?: string })?.text, "hi");
      assert.ok(
        warns.some((line) => line.includes("unexpected session")) &&
          warns.some((line) => line.includes("malformed trailing JSONL line"))
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";

import { NdjsonLogStore } from "../../src/logging/ndjsonLogStore.ts";
import type { LogEvent } from "../../src/logging/index.ts";

function event(id: string, ts: number): LogEvent {
  return {
    id,
    ts,
    level: "info",
    category: "agent_turn",
    event: "agent_turn.start",
    component: "test",
    summary: "test event",
  };
}

describe("NdjsonLogStore", () => {
  test("appends events and flushes to NDJSON", async () => {
    const root = await mkdtemp(join(tmpdir(), "mahabot-logs-"));
    try {
      const path = join(root, "logs", "latest.ndjson");
      const store = new NdjsonLogStore({
        path,
        maxEntries: 100,
        compactEveryWrites: 100,
        compactIntervalMs: 60_000,
        now: () => 1000,
      });

      store.append(event("one", 1000));
      await store.flush();

      const lines = (await readFile(path, "utf-8")).trim().split("\n");
      assert.equal(lines.length, 1);
      assert.equal(JSON.parse(lines[0]!).id, "one");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("compacts by maxEntries and maxAgeMs", async () => {
    const root = await mkdtemp(join(tmpdir(), "mahabot-logs-"));
    try {
      const path = join(root, "logs", "latest.ndjson");
      await mkdir(dirname(path), { recursive: true });
      await writeFile(
        path,
        [
          JSON.stringify(event("old", 1000)),
          "not-json",
          JSON.stringify(event("keep-1", 4000)),
          JSON.stringify(event("keep-2", 5000)),
          JSON.stringify(event("keep-3", 6000)),
          "",
        ].join("\n"),
        "utf-8"
      );

      const store = new NdjsonLogStore({
        path,
        maxEntries: 2,
        maxAgeMs: 2500,
        compactEveryWrites: 1,
        compactIntervalMs: 1000,
        now: () => 6000,
      });

      await store.flush();

      const ids = (await readFile(path, "utf-8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).id);
      assert.deepEqual(ids, ["keep-2", "keep-3"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

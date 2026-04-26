import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { InFlightUpdateDetails } from "../src/agent/progress/types.js";
import type { AgentRuntimeStatusMessage } from "../src/agent/runtimeStatus/types.js";
import { createInFlightUpdateTool } from "../src/agent/tools/inFlightUpdateTool.ts";

describe("createInFlightUpdateTool", () => {
  test("exposes standard tool name in_flight_update", () => {
    const tool = createInFlightUpdateTool({
      publishStatus: () => {},
    });
    assert.equal(tool.name, "in_flight_update");
  });

  test("successful call publishes runtime status and returns delivered", async () => {
    const received: AgentRuntimeStatusMessage[] = [];
    const fixedNow = () => 42_000;

    const tool = createInFlightUpdateTool({
      publishStatus: (message) => received.push(message),
      now: fixedNow,
    });

    const result = await tool.execute("tc-1", {
      message: "Doing work",
      nextStep: "Run tests",
      progressPercent: 50,
      stage: "executing",
      dedupeKey: "k1",
    });

    const details = result.details as InFlightUpdateDetails;
    assert.equal(details.delivered, true);
    assert.equal(details.droppedReason, undefined);

    assert.equal(result.content[0]?.type, "text");
    assert.match((result.content[0] as { text: string }).text, /Progress update sent/);

    assert.equal(received.length, 1);
    assert.equal(received[0].kind, "agent.runtime.inflight_update");
    assert.equal(received[0].text, "Doing work | next: Run tests | 50%");
    assert.deepEqual(received[0].raw, {
      message: "Doing work",
      nextStep: "Run tests",
      progressPercent: 50,
      stage: "executing",
      dedupeKey: "k1",
      timestamp: 42_000,
    });
  });

  test("FIFO: multiple successful deliveries preserve publish order", async () => {
    const order: string[] = [];
    const tool = createInFlightUpdateTool({
      publishStatus: (message) => order.push(message.text),
    });

    await tool.execute("a", { message: "first" });
    await tool.execute("b", { message: "second" });
    await tool.execute("c", { message: "third" });

    assert.deepEqual(order, ["first", "second", "third"]);
  });

  test("many sequential successful calls are allowed", async () => {
    let count = 0;
    const tool = createInFlightUpdateTool({
      publishStatus: () => {
        count += 1;
      },
    });

    for (let i = 0; i < 20; i++) {
      const r = await tool.execute(`ok-${i}`, { message: `step ${i}` });
      assert.equal((r.details as InFlightUpdateDetails).delivered, true);
    }
    assert.equal(count, 20);
  });

  test("validation_error: empty message after trim", async () => {
    let publishCalls = 0;
    const tool = createInFlightUpdateTool({
      publishStatus: () => {
        publishCalls += 1;
      },
    });

    const result = await tool.execute("v1", { message: "   " });
    const d = result.details as InFlightUpdateDetails;
    assert.equal(d.delivered, false);
    assert.equal(d.droppedReason, "validation_error");
    assert.equal(publishCalls, 0);
  });

  test("validation_error: message longer than 280 chars", async () => {
    const tool = createInFlightUpdateTool({
      publishStatus: () => {},
    });

    const result = await tool.execute("v2", { message: "x".repeat(281) });
    const d = result.details as InFlightUpdateDetails;
    assert.equal(d.delivered, false);
    assert.equal(d.droppedReason, "validation_error");
  });

  test("validation_error: nextStep empty when provided", async () => {
    const tool = createInFlightUpdateTool({
      publishStatus: () => {},
    });

    const result = await tool.execute("v3", { message: "ok", nextStep: "  " });
    const d = result.details as InFlightUpdateDetails;
    assert.equal(d.delivered, false);
    assert.equal(d.droppedReason, "validation_error");
  });

  test("validation_error: progressPercent must be integer 0–100", async () => {
    const tool = createInFlightUpdateTool({
      publishStatus: () => {},
    });

    const half = await tool.execute("v4a", { message: "m", progressPercent: 12.5 });
    assert.equal((half.details as InFlightUpdateDetails).droppedReason, "validation_error");

    const neg = await tool.execute("v4b", { message: "m", progressPercent: -1 });
    assert.equal((neg.details as InFlightUpdateDetails).droppedReason, "validation_error");
  });

  test("sink_failed: publish throw returns structured failure", async () => {
    const warns: string[] = [];
    const tool = createInFlightUpdateTool({
      publishStatus: () => {
        throw new Error("publish boom");
      },
      logger: { warn: (m: string) => warns.push(m) },
    });

    const result = await tool.execute("sf", { message: "hello" });
    const d = result.details as InFlightUpdateDetails;
    assert.equal(d.delivered, false);
    assert.equal(d.droppedReason, "sink_failed");
    assert.ok(warns.some((w) => w.includes("publish failed")));
  });

  test("optional fields omitted: text keeps only message", async () => {
    const received: AgentRuntimeStatusMessage[] = [];
    const tool = createInFlightUpdateTool({
      publishStatus: (message) => received.push(message),
    });

    await tool.execute("opt", { message: "only message" });
    assert.equal(received[0]?.text, "only message");
  });
});

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { AgentProgressUpdatePayload, InFlightUpdateDetails } from "../src/agent/progress/types.js";
import { IN_FLIGHT_UPDATE_LIMIT } from "../src/agent/progress/types.js";
import { createInFlightUpdateTool } from "../src/agent/tools/inFlightUpdateTool.ts";

describe("createInFlightUpdateTool", () => {
  test("exposes standard tool name in_flight_update", () => {
    const tool = createInFlightUpdateTool({
      sink: () => {},
      quotaRef: { used: 0 },
    });
    assert.equal(tool.name, "in_flight_update");
  });

  test("successful call delivers payload, increments used, and returns quota + delivered", async () => {
    const received: AgentProgressUpdatePayload[] = [];
    const quotaRef = { used: 0 };
    const fixedNow = () => 42_000;

    const tool = createInFlightUpdateTool({
      sink: (p) => received.push(p),
      quotaRef,
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
    assert.deepEqual(details.quota, {
      limit: IN_FLIGHT_UPDATE_LIMIT,
      used: 1,
      remaining: IN_FLIGHT_UPDATE_LIMIT - 1,
    });
    assert.equal(quotaRef.used, 1);

    assert.equal(result.content[0]?.type, "text");
    assert.match((result.content[0] as { text: string }).text, /2 update\(s\) remaining/);

    assert.equal(received.length, 1);
    assert.deepEqual(received[0], {
      message: "Doing work",
      nextStep: "Run tests",
      progressPercent: 50,
      stage: "executing",
      dedupeKey: "k1",
      timestamp: 42_000,
    });
  });

  test("FIFO: multiple successful deliveries preserve call order in sink", async () => {
    const order: string[] = [];
    const quotaRef = { used: 0 };
    const tool = createInFlightUpdateTool({
      sink: (p) => order.push(p.message),
      quotaRef,
    });

    await tool.execute("a", { message: "first" });
    await tool.execute("b", { message: "second" });
    await tool.execute("c", { message: "third" });

    assert.deepEqual(order, ["first", "second", "third"]);
    assert.equal(quotaRef.used, 3);
  });

  test("quota: allows exactly IN_FLIGHT_UPDATE_LIMIT successful deliveries per user turn", async () => {
    const quotaRef = { used: 0 };
    const tool = createInFlightUpdateTool({
      sink: () => {},
      quotaRef,
    });

    for (let i = 0; i < IN_FLIGHT_UPDATE_LIMIT; i++) {
      const r = await tool.execute(`ok-${i}`, { message: `step ${i}` });
      const d = r.details as InFlightUpdateDetails;
      assert.equal(d.delivered, true);
      assert.equal(d.quota.used, i + 1);
      assert.equal(d.quota.remaining, IN_FLIGHT_UPDATE_LIMIT - (i + 1));
    }

    assert.equal(quotaRef.used, IN_FLIGHT_UPDATE_LIMIT);

    const denied = await tool.execute("denied", { message: "one too many" });
    const dd = denied.details as InFlightUpdateDetails;
    assert.equal(dd.delivered, false);
    assert.equal(dd.droppedReason, "quota_exceeded");
    assert.deepEqual(dd.quota, {
      limit: IN_FLIGHT_UPDATE_LIMIT,
      used: IN_FLIGHT_UPDATE_LIMIT,
      remaining: 0,
    });
    assert.equal(quotaRef.used, IN_FLIGHT_UPDATE_LIMIT);
  });

  test("validation_error: empty message after trim does not consume quota", async () => {
    let sinkCalls = 0;
    const quotaRef = { used: 0 };
    const tool = createInFlightUpdateTool({
      sink: () => {
        sinkCalls += 1;
      },
      quotaRef,
    });

    const result = await tool.execute("v1", { message: "   " });
    const d = result.details as InFlightUpdateDetails;
    assert.equal(d.delivered, false);
    assert.equal(d.droppedReason, "validation_error");
    assert.equal(d.quota.used, 0);
    assert.equal(quotaRef.used, 0);
    assert.equal(sinkCalls, 0);
  });

  test("validation_error: message longer than 280 chars does not consume quota", async () => {
    const quotaRef = { used: 0 };
    const tool = createInFlightUpdateTool({
      sink: () => {},
      quotaRef,
    });

    const result = await tool.execute("v2", { message: "x".repeat(281) });
    const d = result.details as InFlightUpdateDetails;
    assert.equal(d.delivered, false);
    assert.equal(d.droppedReason, "validation_error");
    assert.equal(quotaRef.used, 0);
  });

  test("validation_error: nextStep empty when provided does not consume quota", async () => {
    const quotaRef = { used: 0 };
    const tool = createInFlightUpdateTool({
      sink: () => {},
      quotaRef,
    });

    const result = await tool.execute("v3", { message: "ok", nextStep: "  " });
    const d = result.details as InFlightUpdateDetails;
    assert.equal(d.delivered, false);
    assert.equal(d.droppedReason, "validation_error");
    assert.equal(quotaRef.used, 0);
  });

  test("validation_error: progressPercent must be integer 0–100", async () => {
    const quotaRef = { used: 0 };
    const tool = createInFlightUpdateTool({
      sink: () => {},
      quotaRef,
    });

    const half = await tool.execute("v4a", { message: "m", progressPercent: 12.5 });
    assert.equal((half.details as InFlightUpdateDetails).droppedReason, "validation_error");

    const neg = await tool.execute("v4b", { message: "m", progressPercent: -1 });
    assert.equal((neg.details as InFlightUpdateDetails).droppedReason, "validation_error");

    assert.equal(quotaRef.used, 0);
  });

  test("sink_failed: sink throw does not increment used and returns structured failure", async () => {
    const quotaRef = { used: 0 };
    const warns: string[] = [];
    const tool = createInFlightUpdateTool({
      sink: () => {
        throw new Error("sink boom");
      },
      quotaRef,
      logger: { warn: (m: string) => warns.push(m) },
    });

    const result = await tool.execute("sf", { message: "hello" });
    const d = result.details as InFlightUpdateDetails;
    assert.equal(d.delivered, false);
    assert.equal(d.droppedReason, "sink_failed");
    assert.equal(d.quota.used, 0);
    assert.equal(quotaRef.used, 0);
    assert.ok(warns.some((w) => w.includes("sink failed")));
  });

  test("optional fields omitted: payload omits nextStep when not provided", async () => {
    const received: AgentProgressUpdatePayload[] = [];
    const tool = createInFlightUpdateTool({
      sink: (p) => received.push(p),
      quotaRef: { used: 0 },
    });

    await tool.execute("opt", { message: "only message" });
    assert.equal(received[0]?.nextStep, undefined);
    assert.equal(received[0]?.progressPercent, undefined);
  });
});

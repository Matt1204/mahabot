import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { InMemoryMessageBus, createBusMessageId } from "../src/messageBus/index.ts";

describe("InMemoryMessageBus", () => {
  test("routes envelopes into ingress / assistant egress / status egress queues", () => {
    const bus = new InMemoryMessageBus();
    const now = () => 1000;

    bus.publish({
      id: createBusMessageId(now),
      sessionId: "s1",
      ts: now(),
      direction: "user_to_agent",
      source: "cli",
      kind: "ui.user_message",
      priority: "high",
      payload: {
        parts: [{ type: "text", text: "hello" }],
      },
    });

    bus.publish({
      id: createBusMessageId(now),
      sessionId: "s1",
      ts: now(),
      direction: "agent_to_user",
      source: "agent_core",
      kind: "agent.assistant_message",
      priority: "high",
      payload: {
        text: "world",
      },
    });

    bus.publish({
      id: createBusMessageId(now),
      sessionId: "s1",
      ts: now(),
      direction: "agent_to_user",
      source: "event_inspection",
      kind: "agent.runtime.event",
      priority: "low",
      payload: {
        text: "[event] done",
      },
    });

    const queues = bus.getQueues();
    assert.equal(queues.ingressQueue.length, 1);
    assert.equal(queues.assistantEgressQueue.length, 1);
    assert.equal(queues.statusEgressQueue.length, 1);
  });

  test("getUserMsgFromBus waits and resolves when new ingress message arrives", async () => {
    const bus = new InMemoryMessageBus();
    const pending = bus.getUserMsgFromBus("session-1");

    bus.publish({
      id: "msg_1",
      sessionId: "session-1",
      ts: Date.now(),
      direction: "user_to_agent",
      source: "cli",
      kind: "ui.user_message",
      priority: "high",
      payload: {
        parts: [{ type: "text", text: "hello" }],
      },
    });

    const envelope = await pending;
    assert.equal(envelope.kind, "ui.user_message");
    assert.equal(envelope.payload.parts[0]?.type, "text");
  });

  test("getUserMsgFromBus preserves FIFO ordering per session", async () => {
    const bus = new InMemoryMessageBus();

    bus.publish({
      id: "msg_1",
      sessionId: "session-2",
      ts: Date.now(),
      direction: "user_to_agent",
      source: "cli",
      kind: "ui.user_message",
      priority: "high",
      payload: {
        parts: [{ type: "text", text: "first" }],
      },
    });
    bus.publish({
      id: "msg_2",
      sessionId: "session-2",
      ts: Date.now(),
      direction: "user_to_agent",
      source: "cli",
      kind: "ui.user_message",
      priority: "high",
      payload: {
        parts: [{ type: "text", text: "second" }],
      },
    });

    const first = await bus.getUserMsgFromBus("session-2");
    const second = await bus.getUserMsgFromBus("session-2");
    assert.equal(first.payload.parts[0]?.type, "text");
    assert.equal((first.payload.parts[0] as any).text, "first");
    assert.equal((second.payload.parts[0] as any).text, "second");
  });
});

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { createTelegramEgressRelay } from "../../src/gateway/egress/telegramEgressAdapter.ts";
import { InMemoryMessageBus, createBusMessageId } from "../../src/messageBus/index.ts";

function flushDispatch(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("telegramEgressAdapter", () => {
  test("forwards assistant + runtime status agent_to_user envelopes to telegram chat", async () => {
    const bus = new InMemoryMessageBus();
    const sent: Array<{ chatId: string; text: string }> = [];
    const now = () => 1000;

    const stopRelay = createTelegramEgressRelay({
      bus,
      sessionId: "tg:1001",
      chatId: "1001",
      client: {
        sendMessage: async (chatId, text) => {
          sent.push({ chatId, text });
        },
      },
    });

    bus.publish({
      id: createBusMessageId(now),
      sessionId: "tg:1001",
      ts: now(),
      direction: "agent_to_user",
      source: "agent_core",
      kind: "agent.assistant_message",
      priority: "high",
      payload: { text: "assistant reply" },
    });

    bus.publish({
      id: createBusMessageId(now),
      sessionId: "tg:1001",
      ts: now(),
      direction: "agent_to_user",
      source: "agent_runtime",
      kind: "agent.runtime.event",
      priority: "normal",
      payload: { text: "[tool] running..." },
    });

    bus.publish({
      id: createBusMessageId(now),
      sessionId: "tg:other",
      ts: now(),
      direction: "agent_to_user",
      source: "agent_runtime",
      kind: "agent.runtime.event",
      priority: "normal",
      payload: { text: "must not forward to this relay" },
    });

    await flushDispatch();
    stopRelay();

    assert.deepEqual(sent, [
      { chatId: "1001", text: "assistant reply" },
      { chatId: "1001", text: "[tool] running..." },
    ]);
  });

  test("does not forward user_to_agent envelopes", async () => {
    const bus = new InMemoryMessageBus();
    const sent: Array<{ chatId: string; text: string }> = [];
    const now = () => 2000;

    const stopRelay = createTelegramEgressRelay({
      bus,
      sessionId: "tg:1001",
      chatId: "1001",
      client: {
        sendMessage: async (chatId, text) => {
          sent.push({ chatId, text });
        },
      },
    });

    bus.publish({
      id: createBusMessageId(now),
      sessionId: "tg:1001",
      ts: now(),
      direction: "user_to_agent",
      source: "telegram",
      kind: "ui.user_message",
      priority: "high",
      payload: {
        parts: [{ type: "text", text: "hello" }],
      },
    });

    await flushDispatch();
    stopRelay();
    assert.equal(sent.length, 0);
  });
});

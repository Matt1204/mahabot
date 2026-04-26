import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { InMemoryMessageBus } from "../../src/messageBus/index.ts";
import {
  publishTelegramUserMessage,
  publishTelegramUserParts,
} from "../../src/gateway/ingress/telegramIngressAdapter.ts";

describe("telegramIngressAdapter", () => {
  test("publishes normalized telegram text as ui.user_message envelope", () => {
    const bus = new InMemoryMessageBus();
    const now = () => 12345;

    const published = publishTelegramUserMessage({
      bus,
      sessionId: "tg:1001",
      text: "  hello from tg  ",
      chatId: "1001",
      userId: "2002",
      username: "alice",
      firstName: "Alice",
      lastName: "W",
      now,
    });

    assert.equal(published, true);

    const queues = bus.getQueues();
    assert.equal(queues.ingressQueue.length, 1);

    const envelope = queues.ingressQueue[0];
    assert.equal(envelope.sessionId, "tg:1001");
    assert.equal(envelope.source, "telegram");
    assert.equal(envelope.kind, "ui.user_message");
    assert.deepEqual(envelope.payload.parts, [
      { type: "text", text: "hello from tg", origin: "telegram_text" },
    ]);
    assert.deepEqual(envelope.meta, {
      telegram: {
        chatId: "1001",
        userId: "2002",
        username: "alice",
        firstName: "Alice",
        lastName: "W",
      },
    });
  });

  test("ignores empty or whitespace-only text", () => {
    const bus = new InMemoryMessageBus();

    const published = publishTelegramUserMessage({
      bus,
      sessionId: "tg:1001",
      text: "   ",
      chatId: "1001",
      userId: "2002",
    });

    assert.equal(published, false);
    assert.equal(bus.getQueues().ingressQueue.length, 0);
  });

  test("publishes structured image parts before voice transcript text", () => {
    const bus = new InMemoryMessageBus();

    const published = publishTelegramUserParts({
      bus,
      sessionId: "tg:1001",
      chatId: "1001",
      userId: "2002",
      parts: [
        {
          type: "image",
          source: "local_file",
          path: "/tmp/image.jpg",
          mimeType: "image/jpeg",
          caption: "菜单",
        },
        {
          type: "text",
          text: "  这张图是什么？ ",
          origin: "telegram_voice_transcript",
        },
      ],
      voice: {
        transcriptModel: "gpt-4o-mini-transcribe",
        duration: 3,
        mimeType: "audio/ogg",
        fileSize: 1234,
      },
    });

    assert.equal(published, true);
    const envelope = bus.getQueues().ingressQueue[0];
    assert.deepEqual(envelope.payload.parts, [
      {
        type: "image",
        source: "local_file",
        path: "/tmp/image.jpg",
        mimeType: "image/jpeg",
        caption: "菜单",
      },
      {
        type: "text",
        text: "这张图是什么？",
        origin: "telegram_voice_transcript",
      },
    ]);
    assert.deepEqual(envelope.meta?.voice, {
      transcriptModel: "gpt-4o-mini-transcribe",
      duration: 3,
      mimeType: "audio/ogg",
      fileSize: 1234,
    });
  });
});

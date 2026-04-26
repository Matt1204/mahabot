import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { TelegramPendingImageBuffer } from "../../src/gateway/ingress/telegramPendingImageBuffer.ts";

function image(path: string) {
  return {
    type: "image" as const,
    source: "local_file" as const,
    path,
    mimeType: "image/jpeg",
  };
}

describe("TelegramPendingImageBuffer", () => {
  test("preserves order and clears images on trigger", () => {
    let now = 1000;
    const buffer = new TelegramPendingImageBuffer({
      timeoutMs: 10000,
      now: () => now,
    });

    buffer.addImage("tg:1", image("/tmp/1.jpg"));
    now += 100;
    buffer.addImage("tg:1", image("/tmp/2.jpg"));

    const taken = buffer.takeImages("tg:1", now);
    assert.equal(taken.type, "ready");
    assert.deepEqual(
      taken.type === "ready" ? taken.images.map((entry) => entry.path) : [],
      ["/tmp/1.jpg", "/tmp/2.jpg"]
    );
    assert.deepEqual(buffer.takeImages("tg:1"), { type: "empty", images: [] });
  });

  test("expires pending images after timeout", () => {
    const buffer = new TelegramPendingImageBuffer({
      timeoutMs: 5000,
      now: () => 1000,
    });

    buffer.addImage("tg:1", image("/tmp/old.jpg"));

    const taken = buffer.takeImages("tg:1", 6000);
    assert.equal(taken.type, "expired");
    assert.deepEqual(
      taken.type === "expired" ? taken.expiredImages.map((entry) => entry.path) : [],
      ["/tmp/old.jpg"]
    );
    assert.deepEqual(buffer.takeImages("tg:1"), { type: "empty", images: [] });
  });
});

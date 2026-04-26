import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { evaluateTelegramIngress } from "../../src/gateway/ingress/telegramAccessPolicy.ts";

describe("telegramAccessPolicy", () => {
  test("rejects non-whitelisted user", () => {
    const decision = evaluateTelegramIngress({
      activeChatId: null,
      chatId: "1001",
      userId: "2002",
      allowedUserIds: new Set(["3003"]),
    });

    assert.deepEqual(decision, { type: "reject_not_whitelisted" });
  });

  test("accepts first allowed chat and then same chat", () => {
    const allowedUserIds = new Set(["2002"]);

    const first = evaluateTelegramIngress({
      activeChatId: null,
      chatId: "1001",
      userId: "2002",
      allowedUserIds,
    });
    assert.deepEqual(first, { type: "accept_activate" });

    const second = evaluateTelegramIngress({
      activeChatId: "1001",
      chatId: "1001",
      userId: "2002",
      allowedUserIds,
    });
    assert.deepEqual(second, { type: "accept_existing" });
  });

  test("rejects a different chat once an active chat exists", () => {
    const decision = evaluateTelegramIngress({
      activeChatId: "1001",
      chatId: "1009",
      userId: "2002",
      allowedUserIds: new Set(["2002"]),
    });

    assert.deepEqual(decision, {
      type: "reject_other_chat",
      activeChatId: "1001",
    });
  });
});

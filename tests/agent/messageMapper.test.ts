import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { extractTextForHuman } from "../../src/agent/mappers/message.mapper.ts";

describe("extractTextForHuman", () => {
  test("prefers text blocks when text exists", () => {
    const message = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "internal thought" },
        { type: "text", text: "final answer" },
      ],
    } as any;

    assert.equal(extractTextForHuman(message), "final answer");
  });

  test("reports tool call summary when no text but has tool calls", () => {
    const message = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "need to call tool" },
        { type: "toolCall", id: "1", name: "search", arguments: {} },
      ],
    } as any;

    assert.equal(extractTextForHuman(message), "[agent] Assistant requested 1 tool call(s).");
  });

  test("does not expose thinking-only content to users", () => {
    const message = {
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: "I should search for atletico madrid news first.",
          thinkingSignature: "reasoning_content",
        },
      ],
    } as any;

    assert.equal(extractTextForHuman(message), "[agent] Assistant returned no text.");
  });

  test("keeps no-text fallback when content has no readable blocks", () => {
    const message = {
      role: "assistant",
      content: [{ type: "image", image: "..." }],
    } as any;

    assert.equal(extractTextForHuman(message), "[agent] Assistant returned no text.");
  });
});

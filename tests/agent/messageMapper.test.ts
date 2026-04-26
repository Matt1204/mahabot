import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import {
  extractTextForHuman,
  toAgentMessages,
} from "../../src/agent/mappers/message.mapper.ts";

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

describe("toAgentMessages", () => {
  test("maps local image file parts to base64 image blocks with caption", async () => {
    const root = await mkdtemp(join(tmpdir(), "mahabot-message-mapper-"));
    const imagePath = join(root, "photo.jpg");

    try {
      await writeFile(imagePath, Buffer.from("fake-image-bytes"));

      const messages = await toAgentMessages(
        {
          id: "in_1",
          channel: "telegram",
          chatId: "1001",
          userId: "2002",
          text: "这是什么？",
          parts: [
            {
              type: "image",
              source: "local_file",
              path: imagePath,
              mimeType: "image/jpeg",
              caption: "菜单",
            },
            {
              type: "text",
              text: "这是什么？",
              origin: "telegram_text",
            },
          ],
          timestamp: 123,
        },
        { shortTermMessages: [] },
        { supportsImageInput: true }
      );

      const userMessage = messages[0] as any;
      assert.equal(userMessage.role, "user");
      assert.deepEqual(userMessage.content[0], {
        type: "text",
        text: "Image caption: 菜单",
      });
      assert.equal(userMessage.content[1].type, "image");
      assert.equal(userMessage.content[1].mimeType, "image/jpeg");
      assert.equal(userMessage.content[1].sourcePath, imagePath);
      assert.equal(userMessage.content[1].data, Buffer.from("fake-image-bytes").toString("base64"));
      assert.deepEqual(userMessage.content[2], {
        type: "text",
        text: "这是什么？",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects image parts when active model is text-only", async () => {
    await assert.rejects(
      () =>
        toAgentMessages(
          {
            id: "in_1",
            channel: "telegram",
            chatId: "1001",
            userId: "2002",
            text: "[image]",
            parts: [
              {
                type: "image",
                source: "local_file",
                path: "/tmp/photo.jpg",
                mimeType: "image/jpeg",
              },
            ],
            timestamp: 123,
          },
          { shortTermMessages: [] },
          { supportsImageInput: false }
        ),
      /Current model does not support image input/
    );
  });
});

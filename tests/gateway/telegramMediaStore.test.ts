import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { TelegramMediaStore } from "../../src/gateway/ingress/telegramMediaStore.ts";

describe("TelegramMediaStore", () => {
  test("stores largest photo locally without persisting telegram file URL", async () => {
    const root = await mkdtemp(join(tmpdir(), "mahabot-media-store-"));
    const requestedFileIds: string[] = [];

    try {
      const store = new TelegramMediaStore({
        persistenceRoot: root,
        sessionId: "tg:1001",
        now: () => 12345,
        telegram: {
          async getFileLink(fileId) {
            requestedFileIds.push(fileId);
            return new URL(`https://api.telegram.org/file/botSECRET/${fileId}.jpg`);
          },
        },
        fetch: (async () =>
          new Response(Buffer.from("photo-bytes"), {
            status: 200,
          })) as typeof fetch,
      });

      const image = await store.savePhoto({
        message_id: 77,
        caption: "menu",
        photo: [
          { file_id: "small", file_unique_id: "small_unique", width: 100, height: 100 },
          { file_id: "large", file_unique_id: "large_unique", width: 1000, height: 800 },
        ],
      });

      assert.deepEqual(requestedFileIds, ["large"]);
      assert.equal(image.path.includes("botSECRET"), false);
      assert.equal(await readFile(image.path, "utf-8"), "photo-bytes");
      assert.equal(image.caption, "menu");
      assert.equal(image.width, 1000);
      assert.equal(image.height, 800);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

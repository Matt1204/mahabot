import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { DEFAULT_CONFIG, type AppConfig } from "../../src/config/types.ts";
import { resolveTelegramRuntimeConfig } from "../../src/gateway/ingress/telegramRuntimeConfig.ts";

function cloneConfig(): AppConfig {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as AppConfig;
}

describe("telegramRuntimeConfig", () => {
  test("fails when telegram mode is disabled", () => {
    const config = cloneConfig();
    config.ingress.telegram.enabled = false;

    assert.throws(
      () => resolveTelegramRuntimeConfig(config, { TELEGRAM_BOT_TOKEN: "abc" }),
      /Telegram mode is disabled/
    );
  });

  test("fails when bot token env var is missing", () => {
    const config = cloneConfig();
    config.ingress.telegram.enabled = true;
    config.ingress.telegram.allowedChatIds = ["12345"];
    config.ingress.telegram.botTokenEnvVar = "TELEGRAM_BOT_TOKEN";

    assert.throws(
      () => resolveTelegramRuntimeConfig(config, {}),
      /Missing Telegram bot token/
    );
  });

  test("resolves token + normalized whitelist when config is valid", () => {
    const config = cloneConfig();
    config.ingress.telegram.enabled = true;
    config.ingress.telegram.allowedChatIds = ["12345", "67890"];
    config.ingress.telegram.botTokenEnvVar = "TG_TOKEN";

    const resolved = resolveTelegramRuntimeConfig(config, { TG_TOKEN: "  x:y  " });
    assert.equal(resolved.botToken, "x:y");
    assert.deepEqual(Array.from(resolved.allowedUserIds), ["12345", "67890"]);
  });
});

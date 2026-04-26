import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { DEFAULT_CONFIG, type AppConfig } from "../../src/config/types.ts";
import {
  buildTelegramOnboardingReport,
  renderTelegramOnboardingReport,
  writeTelegramEnvExample,
  type TelegramOnboardingPaths,
} from "../../src/onboarding/telegramOnboarding.ts";

function cloneConfig(): AppConfig {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as AppConfig;
}

function paths(): TelegramOnboardingPaths {
  return {
    workspaceSessionId: "telegram-stable-session",
    sessionRoot: "/tmp/mahabot/telegram-stable-session",
    workspaceRoot: "/tmp/mahabot/telegram-stable-session/workspace",
    persistenceRoot: "/tmp/mahabot/telegram-stable-session/workspace/persistence",
    configPath: "/tmp/mahabot/telegram-stable-session/config.json",
    envExamplePath: "/tmp/mahabot/telegram-stable-session/.env.example",
    isFirstConfigCreated: false,
  };
}

describe("telegram onboarding", () => {
  test("reports all blocking telegram startup items without leaking secrets", () => {
    const config = cloneConfig();
    config.ingress.telegram.enabled = false;
    config.ingress.telegram.allowedChatIds = [];

    const report = buildTelegramOnboardingReport({
      paths: paths(),
      appConfig: config,
      env: {},
      envExampleWritten: true,
    });

    assert.equal(report.ready, false);
    assert.deepEqual(
      report.checks
        .filter((check) => check.severity === "blocking")
        .map((check) => check.id),
      [
        "telegram_enabled",
        "telegram_bot_token_present",
        "telegram_allowed_user_ids",
      ]
    );

    const rendered = renderTelegramOnboardingReport(report);
    assert.match(rendered, /ingress\.telegram\.allowedChatIds/);
    assert.match(rendered, /TELEGRAM_BOT_TOKEN/);
    assert.doesNotMatch(rendered, /secret-value/);
    assert.doesNotMatch(rendered, /OPENAI_API_KEY/);
  });

  test("marks telegram onboarding ready when blocking config and env are present", () => {
    const config = cloneConfig();
    config.ingress.telegram.enabled = true;
    config.ingress.telegram.allowedChatIds = ["12345"];

    const report = buildTelegramOnboardingReport({
      paths: paths(),
      appConfig: config,
      env: {
        TELEGRAM_BOT_TOKEN: "telegram-secret",
      },
      envExampleWritten: true,
    });

    assert.equal(report.ready, true);
    assert.equal(report.checks.some((check) => check.severity === "blocking"), false);
    assert.match(renderTelegramOnboardingReport(report), /Next: run `mahabot telegram`/);
  });

  test("writes placeholder env example using configured env var names", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mahabot-onboarding-"));
    const envPath = join(dir, ".env.example");

    try {
      const config = cloneConfig();
      config.ingress.telegram.botTokenEnvVar = "TG_BOT_TOKEN";
      config.agent.llmProviders[0].apiKeyEnvVar = "MAHABOT_LLM_KEY";

      await writeTelegramEnvExample(envPath, config);

      const content = await readFile(envPath, "utf-8");
      assert.match(content, /TG_BOT_TOKEN=your_telegram_bot_token_here/);
      assert.doesNotMatch(content, /MAHABOT_LLM_KEY/);
      assert.doesNotMatch(content, /secret-value/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

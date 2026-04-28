import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { ConfigManager } from "../../src/config/configManager.ts";
import { createModelFromConfig } from "../../src/config/modelFactory.ts";
import { DEFAULT_CONFIG, type AppConfig } from "../../src/config/types.ts";

function cloneConfig(): AppConfig {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as AppConfig;
}

describe("config slimming validation", () => {
  test("accepts slim model overrides only", () => {
    const config = cloneConfig();
    config.agent.activeProvider = "openai";
    config.agent.activeModel = "gpt-4o-mini";
    config.agent.defaultProvider = "openai";
    config.agent.defaultModel = "gpt-4o-mini";
    config.agent.llmProviders = [
      {
        provider: "openai",
        enabled: true,
        apiKeyEnvVar: "OPENAI_API_KEY",
        models: [
          {
            name: "gpt-4o-mini",
            params: {
              model: {
                reasoning: true,
                input: ["text", "image"],
                headers: { "X-Test": "1" },
                compat: { supportsStore: true },
              },
            },
          },
        ],
      },
    ];

    const manager = new ConfigManager();
    const normalized = manager.set(config);

    const modelParams = normalized.agent.llmProviders[0]?.models[0]?.params?.model;
    assert.equal(modelParams?.reasoning, true);
    assert.deepEqual(modelParams?.input, ["text", "image"]);
    assert.equal(modelParams?.headers?.["X-Test"], "1");
  });

  test("rejects removed params.agent and params.stream", () => {
    const config = cloneConfig() as any;
    config.agent.llmProviders[0].models = [
      {
        name: "gpt-4o-mini",
        params: {
          agent: { thinkingLevel: "high" },
        },
      },
    ];

    const manager = new ConfigManager();
    assert.throws(
      () => manager.set(config),
      /params\.agent is removed/
    );

    config.agent.llmProviders[0].models = [
      {
        name: "gpt-4o-mini",
        params: {
          stream: { temperature: 0.2 },
        },
      },
    ];
    assert.throws(
      () => manager.set(config),
      /params\.stream is removed/
    );
  });

  test("rejects unknown and removed params.model keys", () => {
    const config = cloneConfig() as any;
    config.agent.llmProviders[0].models = [
      {
        name: "gpt-4o-mini",
        params: {
          model: {
            randomKey: true,
          },
        },
      },
    ];

    const manager = new ConfigManager();
    assert.throws(
      () => manager.set(config),
      /params\.model\.randomKey is not supported/
    );

    config.agent.llmProviders[0].models = [
      {
        name: "gpt-4o-mini",
        params: {
          model: {
            baseUrl: "https://example.com/v1",
          },
        },
      },
    ];
    assert.throws(
      () => manager.set(config),
      /params\.model\.baseUrl is removed/
    );
  });

  test("rejects removed agent.runtimeStatus and validates eventInspection.thinking", () => {
    const config = cloneConfig() as any;
    config.agent.runtimeStatus = { emitThinking: true };

    const manager = new ConfigManager();
    assert.throws(
      () => manager.set(config),
      /agent\.runtimeStatus is removed/
    );

    const validConfig = cloneConfig() as any;
    validConfig.eventInspection.thinking = {
      enabled: true,
      emitMode: "on_end",
      maxChars: 120,
    };

    const normalized = manager.set(validConfig);
    assert.equal(normalized.eventInspection.thinking.enabled, true);
    assert.equal(normalized.eventInspection.thinking.emitMode, "on_end");
    assert.equal(normalized.eventInspection.thinking.maxChars, 120);
  });

  test("validates ingress.telegram schema and normalizes allowed user ids", () => {
    const config = cloneConfig() as any;
    config.ingress.telegram.enabled = true;
    config.ingress.telegram.botTokenEnvVar = " TELEGRAM_BOT_TOKEN ";
    config.ingress.telegram.allowedChatIds = ["123", 456];

    const manager = new ConfigManager();
    const normalized = manager.set(config);

    assert.equal(normalized.ingress.telegram.enabled, true);
    assert.equal(normalized.ingress.telegram.botTokenEnvVar, "TELEGRAM_BOT_TOKEN");
    assert.deepEqual(normalized.ingress.telegram.allowedChatIds, ["123", "456"]);
    assert.equal(normalized.ingress.telegram.media.pendingImageTimeoutMs, 600000);
    assert.equal(normalized.ingress.telegram.media.transcription.model, "gpt-4o-mini-transcribe");
  });

  test("rejects invalid ingress.telegram allowedChatIds and botTokenEnvVar", () => {
    const manager = new ConfigManager();

    const invalidToken = cloneConfig() as any;
    invalidToken.ingress.telegram.botTokenEnvVar = "   ";
    assert.throws(
      () => manager.set(invalidToken),
      /ingress\.telegram\.botTokenEnvVar must be a non-empty string/
    );

    const invalidAllowedShape = cloneConfig() as any;
    invalidAllowedShape.ingress.telegram.allowedChatIds = "123";
    assert.throws(
      () => manager.set(invalidAllowedShape),
      /ingress\.telegram\.allowedChatIds must be an array/
    );

    const invalidAllowedEntry = cloneConfig() as any;
    invalidAllowedEntry.ingress.telegram.allowedChatIds = [""];
    assert.throws(
      () => manager.set(invalidAllowedEntry),
      /ingress\.telegram\.allowedChatIds\[0\] must be non-empty/
    );

    const invalidMediaTimeout = cloneConfig() as any;
    invalidMediaTimeout.ingress.telegram.media.pendingImageTimeoutMs = 999;
    assert.throws(
      () => manager.set(invalidMediaTimeout),
      /ingress\.telegram\.media\.pendingImageTimeoutMs/
    );
  });

  test("validates logging config", () => {
    const manager = new ConfigManager();
    const config = cloneConfig();
    config.logging.level = "debug";
    config.logging.path = " logs/test.ndjson ";
    config.logging.maxEntries = 500;

    const normalized = manager.set(config);
    assert.equal(normalized.logging.level, "debug");
    assert.equal(normalized.logging.path, "logs/test.ndjson");
    assert.equal(normalized.logging.maxEntries, 500);

    const invalid = cloneConfig() as any;
    invalid.logging.maxEntries = 10;
    assert.throws(
      () => manager.set(invalid),
      /logging\.maxEntries/
    );
  });
});

describe("modelFactory fallback order", () => {
  test("uses requested -> active -> default fallback order", () => {
    const config = cloneConfig();
    config.agent.activeProvider = "openai";
    config.agent.activeModel = "gpt-4o-mini";
    config.agent.defaultProvider = "openai";
    config.agent.defaultModel = "gpt-4o";
    config.agent.llmProviders = [
      {
        provider: "openai",
        enabled: true,
        apiKeyEnvVar: "OPENAI_API_KEY",
        models: [{ name: "gpt-4o-mini" }, { name: "gpt-4o" }],
      },
    ];

    const modelFromMissingRequested = createModelFromConfig(config, "openai", "non-existent");
    assert.equal(modelFromMissingRequested.id, "gpt-4o-mini");

    const modelFromNoRequest = createModelFromConfig(config);
    assert.equal(modelFromNoRequest.id, "gpt-4o-mini");

    const configWithMissingActive = cloneConfig();
    configWithMissingActive.agent.activeProvider = "openai";
    configWithMissingActive.agent.activeModel = "non-existent";
    configWithMissingActive.agent.defaultProvider = "openai";
    configWithMissingActive.agent.defaultModel = "gpt-4o-mini";
    configWithMissingActive.agent.llmProviders = [
      {
        provider: "openai",
        enabled: true,
        apiKeyEnvVar: "OPENAI_API_KEY",
        models: [{ name: "gpt-4o-mini" }],
      },
    ];

    const modelFromDefaultFallback = createModelFromConfig(configWithMissingActive as AppConfig);
    assert.equal(modelFromDefaultFallback.id, "gpt-4o-mini");
  });
});

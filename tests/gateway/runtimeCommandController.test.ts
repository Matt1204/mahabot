import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { EventInspectionConfig } from "../../src/config/types.ts";
import {
  RuntimeCommandController,
  createRuntimeEventInspectionConfig,
  type ParsedRuntimeCommand,
  type RuntimeCommandAgentStateSnapshot,
} from "../../src/gateway/commands/index.ts";

function createConfig(): EventInspectionConfig {
  return {
    useEventInspection: false,
    showTokenUsage: false,
    include: {
      agent_start: false,
      agent_end: false,
      turn_start: false,
      turn_end: false,
      message_start: false,
      message_update: false,
      message_end: false,
      tool_execution_start: false,
      tool_execution_update: false,
      tool_execution_end: false,
    },
    thinking: {
      enabled: false,
      emitMode: "on_end",
    },
  };
}

function command(name: ParsedRuntimeCommand["name"]): ParsedRuntimeCommand {
  return {
    name,
    raw: `/${name}`,
    source: "leading",
  };
}

function contextSnapshot() {
  return {
    curContextSize: 10,
    compactLowWatermarkTokens: 40000,
    compactHighWatermarkTokens: 100000,
    runtimeMessageCount: 3,
    agentBusy: true,
  };
}

function agentStateSnapshot(): RuntimeCommandAgentStateSnapshot {
  return {
    context: contextSnapshot(),
    appliedConfig: {
      providerName: "openai",
      modelName: "gpt-4o-mini",
      modelProvider: "openai",
      modelId: "gpt-4o-mini",
      modelDisplayName: "GPT-4o mini",
      thinkingLevel: "off",
      supportsImageInput: true,
    },
    runtime: {
      running: true,
      agentBusy: true,
      runtimeMessageCount: 3,
      persistenceEnabled: true,
      startupRestoreMessageCount: 50,
    },
    toolCount: 8,
  };
}

describe("RuntimeCommandController", () => {
  test("context formats runtime context snapshot", () => {
    const controller = new RuntimeCommandController({
      eventInspectionConfig: createRuntimeEventInspectionConfig(createConfig()),
      getContextSnapshot: () => ({
        curContextSize: 0,
        compactLowWatermarkTokens: 40000,
        compactHighWatermarkTokens: 100000,
        runtimeMessageCount: 3,
        agentBusy: true,
      }),
      getAgentStateSnapshot: agentStateSnapshot,
    });

    const result = controller.execute([command("context")]);

    assert.equal(result.replies.length, 1);
    assert.match(result.replies[0], /curContextSize: 0/);
    assert.match(result.replies[0], /agentBusy: true/);
  });

  test("inspect formats current inspection state", () => {
    const controller = new RuntimeCommandController({
      eventInspectionConfig: createRuntimeEventInspectionConfig({
        ...createConfig(),
        useEventInspection: true,
        include: {
          ...createConfig().include,
          turn_start: true,
        },
      }),
      getContextSnapshot: () => ({
        curContextSize: 10,
        compactLowWatermarkTokens: 1,
        compactHighWatermarkTokens: 2,
        runtimeMessageCount: 1,
        agentBusy: false,
      }),
      getAgentStateSnapshot: agentStateSnapshot,
    });

    const result = controller.execute([command("inspect")]);

    assert.equal(result.replies.length, 1);
    assert.match(result.replies[0], /useEventInspection: true/);
    assert.match(result.replies[0], /enabledEvents: turn_start/);
  });

  test("multiple commands produce multiple separate replies", () => {
    const controller = new RuntimeCommandController({
      eventInspectionConfig: createRuntimeEventInspectionConfig(createConfig()),
      getContextSnapshot: () => ({
        curContextSize: 10,
        compactLowWatermarkTokens: 1,
        compactHighWatermarkTokens: 2,
        runtimeMessageCount: 1,
        agentBusy: false,
      }),
      getAgentStateSnapshot: agentStateSnapshot,
    });

    const result = controller.execute([command("context"), command("inspect_all_on")]);

    assert.equal(result.replies.length, 2);
    assert.match(result.replies[0], /^context:/);
    assert.match(result.replies[1], /^inspection:/);
  });

  test("agent_state formats context, applied config, runtime, tool count, and inspection", () => {
    const controller = new RuntimeCommandController({
      eventInspectionConfig: createRuntimeEventInspectionConfig({
        ...createConfig(),
        useEventInspection: true,
        include: {
          ...createConfig().include,
          tool_execution_start: true,
        },
      }),
      getContextSnapshot: contextSnapshot,
      getAgentStateSnapshot: agentStateSnapshot,
    });

    const result = controller.execute([command("agent_state")]);

    assert.equal(result.replies.length, 1);
    assert.match(result.replies[0], /^agent_state:/);
    assert.match(result.replies[0], /curContextSize: 10/);
    assert.match(result.replies[0], /providerName: openai/);
    assert.match(result.replies[0], /modelName: gpt-4o-mini/);
    assert.match(result.replies[0], /thinkingLevel: off/);
    assert.match(result.replies[0], /running: true/);
    assert.match(result.replies[0], /toolCount: 8/);
    assert.match(result.replies[0], /enabledEvents: tool_execution_start/);
  });
});

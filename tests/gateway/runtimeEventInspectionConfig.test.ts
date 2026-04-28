import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { EventInspectionConfig } from "../../src/config/types.ts";
import { createRuntimeEventInspectionConfig } from "../../src/gateway/commands/index.ts";

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
      maxChars: 120,
    },
  };
}

describe("RuntimeEventInspectionConfig", () => {
  test("initializes from config", () => {
    const runtimeConfig = createRuntimeEventInspectionConfig({
      ...createConfig(),
      useEventInspection: true,
      include: {
        ...createConfig().include,
        turn_start: true,
      },
    });

    const snapshot = runtimeConfig.getSnapshot();
    assert.equal(snapshot.useEventInspection, true);
    assert.equal(snapshot.include.turn_start, true);
    assert.equal(snapshot.thinking.enabled, false);
  });

  test("inspect_all_on enables all event includes but not thinking", () => {
    const runtimeConfig = createRuntimeEventInspectionConfig(createConfig());

    const snapshot = runtimeConfig.setAllEvents(true);

    assert.equal(snapshot.useEventInspection, true);
    assert.equal(Object.values(snapshot.include).every(Boolean), true);
    assert.equal(snapshot.thinking.enabled, false);
  });

  test("inspect_all_off disables normal event inspection and does not change thinking", () => {
    const runtimeConfig = createRuntimeEventInspectionConfig({
      ...createConfig(),
      thinking: {
        enabled: true,
        emitMode: "on_end",
      },
    });
    runtimeConfig.setAllEvents(true);

    const snapshot = runtimeConfig.setAllEvents(false);

    assert.equal(snapshot.useEventInspection, false);
    assert.equal(Object.values(snapshot.include).every((enabled) => !enabled), true);
    assert.equal(snapshot.thinking.enabled, true);
  });

  test("tool commands affect only tool events", () => {
    const runtimeConfig = createRuntimeEventInspectionConfig({
      ...createConfig(),
      include: {
        ...createConfig().include,
        turn_start: true,
      },
    });

    const snapshot = runtimeConfig.setToolEvents(true);

    assert.equal(snapshot.useEventInspection, true);
    assert.equal(snapshot.include.turn_start, true);
    assert.equal(snapshot.include.tool_execution_start, true);
    assert.equal(snapshot.include.tool_execution_update, true);
    assert.equal(snapshot.include.tool_execution_end, true);
  });

  test("thinking commands affect only thinking", () => {
    const runtimeConfig = createRuntimeEventInspectionConfig({
      ...createConfig(),
      include: {
        ...createConfig().include,
        turn_start: true,
      },
    });

    const snapshot = runtimeConfig.setThinking(true);

    assert.equal(snapshot.useEventInspection, false);
    assert.equal(snapshot.include.turn_start, true);
    assert.equal(snapshot.thinking.enabled, true);
  });
});

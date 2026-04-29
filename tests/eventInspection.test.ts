import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { EventInspectionConfig } from "../src/config/types.js";
import { EventInspection } from "../src/agent/inspection/eventInspection.ts";
import type { AgentRuntimeStatusMessage } from "../src/agent/runtimeStatus/types.js";

function createConfig(
  include: Partial<EventInspectionConfig["include"]>,
  overrides?: Partial<Pick<EventInspectionConfig, "useEventInspection" | "showTokenUsage">>,
  thinkingEnabled = false
): EventInspectionConfig {
  return {
    useEventInspection: overrides?.useEventInspection ?? true,
    showTokenUsage: overrides?.showTokenUsage ?? false,
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
      ...include,
    },
    thinking: {
      enabled: thinkingEnabled,
      emitMode: "on_end",
    },
  };
}

async function waitForInspectionFlush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("EventInspection to MessageBus runtime status", () => {
  test("tool_execution_start publishes agent.runtime.event with [tool_name] prefix", async () => {
    const published: AgentRuntimeStatusMessage[] = [];
    const inspection = new EventInspection(createConfig({ tool_execution_start: true }), {
      publishStatus: (message) => published.push(message),
    });

    inspection.handleAgentEvent({
      type: "tool_execution_start",
      toolCallId: "tc-1",
      toolName: "read_file",
      args: { path: "/Users/zihanma/demo.txt" },
    } as any);

    await waitForInspectionFlush();

    assert.equal(published.length, 1);
    assert.equal(published[0].kind, "agent.runtime.event");
    assert.equal(
      published[0].text,
      "[read_file] \"/Users/zihanma/demo.txt\""
    );
  });

  test("tool_execution_update publishes agent.runtime.event", async () => {
    const published: AgentRuntimeStatusMessage[] = [];
    const inspection = new EventInspection(createConfig({ tool_execution_update: true }), {
      publishStatus: (message) => published.push(message),
    });

    inspection.handleAgentEvent({
      type: "tool_execution_update",
      toolCallId: "tc-2",
      toolName: "progressive_ticker",
      args: { steps: 5 },
      partialResult: {
        content: [{ type: "text", text: "progressive_ticker 2/5" }],
        details: { step: 2, total: 5 },
      },
    } as any);

    await waitForInspectionFlush();

    assert.equal(published.length, 1);
    assert.equal(published[0].kind, "agent.runtime.event");
    assert.equal(published[0].text, "[progressive_ticker] \"step 2/5\"");
  });

  test("tool_execution_end publishes agent.runtime.event and keeps stderr with stdout", async () => {
    const published: AgentRuntimeStatusMessage[] = [];
    const inspection = new EventInspection(createConfig({ tool_execution_end: true }), {
      publishStatus: (message) => published.push(message),
    });

    inspection.handleAgentEvent({
      type: "tool_execution_end",
      toolCallId: "tc-3",
      toolName: "bash",
      isError: false,
      result: {
        content: [
          {
            type: "text",
            text: [
              "Bash command execution result:",
              "",
              "stdout:",
              "done",
              "",
              "stderr:",
              "warn",
            ].join("\n"),
          },
        ],
        details: {
          tool: "bash",
          ok: true,
        },
      },
    } as any);

    await waitForInspectionFlush();

    assert.equal(published.length, 1);
    assert.equal(published[0].kind, "agent.runtime.event");
    assert.equal(published[0].text, "[bash] \"stdout: done; stderr: warn\"");
  });

  test("thinking_end publishes one complete agent.runtime.thinking line", async () => {
    const published: AgentRuntimeStatusMessage[] = [];
    const inspection = new EventInspection(createConfig({}, { useEventInspection: false }, true), {
      publishStatus: (message) => published.push(message),
    });

    inspection.handleAgentEvent({ type: "turn_start" } as any);
    inspection.handleAgentEvent({
      type: "message_start",
      message: {
        role: "assistant",
      },
    } as any);
    inspection.handleAgentEvent({
      type: "message_update",
      assistantMessageEvent: {
        type: "thinking_start",
        contentIndex: 0,
      },
      message: {
        role: "assistant",
      },
    } as any);
    inspection.handleAgentEvent({
      type: "message_update",
      assistantMessageEvent: {
        type: "thinking_delta",
        contentIndex: 0,
        delta: "draft reasoning",
      },
      message: {
        role: "assistant",
      },
    } as any);
    inspection.handleAgentEvent({
      type: "message_update",
      assistantMessageEvent: {
        type: "thinking_end",
        contentIndex: 0,
        content: "final reasoning",
      },
      message: {
        role: "assistant",
      },
    } as any);

    await waitForInspectionFlush();

    assert.equal(published.length, 1);
    assert.equal(published[0].kind, "agent.runtime.thinking");
    assert.equal(published[0].text, "[thinking] final reasoning");
    assert.deepEqual(published[0].raw, {
      phase: "end",
      turnSeq: 1,
      assistantSeq: 1,
      contentIndex: 0,
    });
  });

  test("thinking_end falls back to buffered delta content when event content is absent", async () => {
    const published: AgentRuntimeStatusMessage[] = [];
    const inspection = new EventInspection(createConfig({}, { useEventInspection: false }, true), {
      publishStatus: (message) => published.push(message),
    });

    inspection.handleAgentEvent({ type: "turn_start" } as any);
    inspection.handleAgentEvent({
      type: "message_start",
      message: {
        role: "assistant",
      },
    } as any);
    inspection.handleAgentEvent({
      type: "message_update",
      assistantMessageEvent: {
        type: "thinking_start",
        contentIndex: 2,
      },
      message: {
        role: "assistant",
      },
    } as any);
    inspection.handleAgentEvent({
      type: "message_update",
      assistantMessageEvent: {
        type: "thinking_delta",
        contentIndex: 2,
        delta: "assembled from",
      },
      message: {
        role: "assistant",
      },
    } as any);
    inspection.handleAgentEvent({
      type: "message_update",
      assistantMessageEvent: {
        type: "thinking_delta",
        contentIndex: 2,
        delta: " deltas",
      },
      message: {
        role: "assistant",
      },
    } as any);
    inspection.handleAgentEvent({
      type: "message_update",
      assistantMessageEvent: {
        type: "thinking_end",
        contentIndex: 2,
      },
      message: {
        role: "assistant",
      },
    } as any);

    await waitForInspectionFlush();

    assert.equal(published.length, 1);
    assert.equal(published[0].kind, "agent.runtime.thinking");
    assert.equal(published[0].text, "[thinking] assembled from deltas");
  });

  test("reads dynamic inspection config after construction", async () => {
    const published: AgentRuntimeStatusMessage[] = [];
    let config = createConfig({});
    const inspection = new EventInspection(createConfig({}), {
      publishStatus: (message) => published.push(message),
      getInspectionConfig: () => config,
    });

    inspection.handleAgentEvent({ type: "turn_start" } as any);
    await waitForInspectionFlush();
    assert.equal(published.length, 0);

    config = createConfig({ turn_start: true });
    inspection.handleAgentEvent({ type: "turn_start" } as any);
    await waitForInspectionFlush();

    assert.equal(published.length, 1);
    assert.equal(published[0].text, "[turn_start] Starting your request.");
  });

  test("reads one inspection config snapshot per runtime event", async () => {
    let snapshotReadCount = 0;
    const inspection = new EventInspection(createConfig({ turn_start: true }), {
      publishStatus: () => {},
      getInspectionConfig: () => {
        snapshotReadCount += 1;
        return createConfig({ turn_start: true });
      },
    });

    inspection.handleAgentEvent({ type: "turn_start" } as any);
    await waitForInspectionFlush();

    assert.equal(snapshotReadCount, 1);
  });
});

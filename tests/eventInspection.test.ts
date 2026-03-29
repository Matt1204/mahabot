import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { EventInspectionConfig } from "../src/config/types.js";
import { EventInspection } from "../src/agent/inspection/eventInspection.ts";
import type { InspectionRenderedEvent } from "../src/agent/inspection/contracts.js";

function createConfig(include: Partial<EventInspectionConfig["include"]>): EventInspectionConfig {
  return {
    useEventInspection: true,
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
      ...include,
    },
  };
}

async function waitForInspectionFlush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("EventInspection tool labels", () => {
  test("tool_execution_start uses [tool_name] prefix", async () => {
    const published: InspectionRenderedEvent[] = [];
    const inspection = new EventInspection(createConfig({ tool_execution_start: true }), {
      sinks: [
        {
          channel: "cli",
          sink: {
            publish: (event) => published.push(event),
          },
        },
      ],
      supportsAnsi: () => false,
    });

    inspection.handleAgentEvent({
      type: "tool_execution_start",
      toolCallId: "tc-1",
      toolName: "read_file",
      args: { path: "/Users/zihanma/demo.txt" },
    } as any);

    await waitForInspectionFlush();

    assert.equal(published.length, 1);
    assert.equal(
      published[0].line,
      "[read_file] \"/Users/zihanma/demo.txt\""
    );
  });

  test("tool_execution_update uses [tool_name] prefix", async () => {
    const published: InspectionRenderedEvent[] = [];
    const inspection = new EventInspection(createConfig({ tool_execution_update: true }), {
      sinks: [
        {
          channel: "cli",
          sink: {
            publish: (event) => published.push(event),
          },
        },
      ],
      supportsAnsi: () => false,
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
    assert.equal(published[0].line, "[progressive_ticker] \"step 2/5\"");
  });

  test("tool_execution_end uses [tool_name] prefix and keeps stderr when stdout exists", async () => {
    const published: InspectionRenderedEvent[] = [];
    const inspection = new EventInspection(createConfig({ tool_execution_end: true }), {
      sinks: [
        {
          channel: "cli",
          sink: {
            publish: (event) => published.push(event),
          },
        },
      ],
      supportsAnsi: () => false,
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
    assert.equal(published[0].line, "[bash] \"stdout: done; stderr: warn\"");
  });
});

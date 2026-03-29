import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { AgentMessage } from "@mariozechner/pi-agent-core";

import { buildAlignedTailWindow, buildStartupRestoreWindow } from "../src/agent/persistence/windowAlignment.ts";

function message(role: "user" | "assistant" | "toolResult", text: string, timestamp: number): AgentMessage {
  return {
    role,
    content: [{ type: "text", text }],
    timestamp,
  } as AgentMessage;
}

describe("windowAlignment", () => {
  test("startup restore keeps assistant-ended tail and aligns start to user boundary", () => {
    const messages: AgentMessage[] = [
      message("user", "u1", 1),
      message("assistant", "a1", 2),
      message("user", "u2", 3),
      message("assistant", "a2_toolcall", 4),
      message("toolResult", "t2", 5),
      message("assistant", "a2_final", 6),
      message("user", "u3_dangling", 7),
    ];

    const restored = buildStartupRestoreWindow(messages, 3);
    assert.equal(restored.length, 4);
    assert.equal((restored[0] as any).role, "user");
    assert.deepEqual(
      restored.map((entry) => ((entry as any).content?.[0] as { text?: string })?.text),
      ["u2", "a2_toolcall", "t2", "a2_final"]
    );

    const alignedTail = buildAlignedTailWindow(messages, 2);
    assert.deepEqual(
      alignedTail.map((entry) => ((entry as any).content?.[0] as { text?: string })?.text),
      ["u2", "a2_toolcall", "t2", "a2_final"]
    );
  });

  test("returns empty window when no assistant turn end is available", () => {
    const messages: AgentMessage[] = [
      message("user", "u1", 1),
      message("assistant", "a1_toolcall", 2),
      message("toolResult", "t1", 3),
    ];

    assert.deepEqual(buildStartupRestoreWindow(messages, 5), []);
    assert.deepEqual(buildAlignedTailWindow(messages, 5), []);
  });
});

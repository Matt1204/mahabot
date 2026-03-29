import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  MAX_TOOL_IO_CHARS,
  formatToolEnd,
  formatToolStart,
  formatToolUpdate,
} from "../src/agent/inspection/toolInspectionFormatters.ts";

describe("toolInspectionFormatters", () => {
  test("read_file start shows only quoted path", () => {
    const line = formatToolStart("read_file", {
      path: "/Users/zihanma/demo.txt",
      offset: 10,
      maxBytes: 1024,
    });

    assert.equal(line, "\"/Users/zihanma/demo.txt\"");
  });

  test("read_file end always shows content snippet clipped by MAX_TOOL_IO_CHARS", () => {
    const longContent = "A".repeat(MAX_TOOL_IO_CHARS + 20);
    const result = {
      content: [
        {
          type: "text",
          text: `Read file: /tmp/demo.txt\ncontent:\n${longContent}`,
        },
      ],
      details: {
        tool: "read_file",
        ok: true,
        resolvedPath: "/tmp/demo.txt",
        truncated: true,
        nextOffset: 2048,
      },
    };

    const line = formatToolEnd("read_file", result, false);
    assert.match(line, /^"\/tmp\/demo\.txt" "A{30}\.\.\."/);
    assert.match(line, /\(truncated, nextOffset=2048\)$/);
  });

  test("bash end includes stderr when stdout is non-empty", () => {
    const result = {
      content: [
        {
          type: "text",
          text: [
            "Bash command execution result:",
            "",
            "stdout:",
            "build complete",
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
    };

    const line = formatToolEnd("bash", result, false);
    assert.equal(line, "\"stdout: build complete; stderr: warn\"");
  });

  test("tool update formatter uses tool-specific summary", () => {
    const partialResult = {
      content: [{ type: "text", text: "progressive_ticker 2/5" }],
      details: { step: 2, total: 5, label: null },
    };

    const line = formatToolUpdate("progressive_ticker", partialResult);
    assert.equal(line, "\"step 2/5\"");
  });
});

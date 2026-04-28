import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { parseRuntimeCommands } from "../../src/gateway/commands/index.ts";

describe("commandParser", () => {
  test("parses single command-only input", () => {
    const result = parseRuntimeCommands("/context");

    assert.deepEqual(result.commands.map((command) => command.name), ["context"]);
    assert.equal(result.remainingText, "");
    assert.deepEqual(result.unknownCommandTexts, []);
  });

  test("parses agent_state command", () => {
    const result = parseRuntimeCommands("/agent_state");

    assert.deepEqual(result.commands.map((command) => command.name), ["agent_state"]);
    assert.equal(result.remainingText, "");
  });

  test("parses leading command plus prompt", () => {
    const result = parseRuntimeCommands("/context what's the weather?");

    assert.deepEqual(result.commands.map((command) => command.name), ["context"]);
    assert.equal(result.commands[0].source, "leading");
    assert.equal(result.remainingText, "what's the weather?");
  });

  test("parses trailing command plus prompt", () => {
    const result = parseRuntimeCommands("summarize this /inspect");

    assert.deepEqual(result.commands.map((command) => command.name), ["inspect"]);
    assert.equal(result.commands[0].source, "trailing");
    assert.equal(result.remainingText, "summarize this");
  });

  test("parses leading and trailing command regions", () => {
    const result = parseRuntimeCommands("/context summarize this /inspect");

    assert.deepEqual(result.commands.map((command) => command.name), ["context", "inspect"]);
    assert.equal(result.remainingText, "summarize this");
  });

  test("does not parse command-like token in the middle", () => {
    const result = parseRuntimeCommands("what is /context in express?");

    assert.deepEqual(result.commands, []);
    assert.equal(result.remainingText, "what is /context in express?");
  });

  test("accepts telegram bot suffix", () => {
    const result = parseRuntimeCommands("/context@MyBot check this");

    assert.deepEqual(result.commands.map((command) => command.name), ["context"]);
    assert.equal(result.commands[0].raw, "/context@MyBot");
    assert.equal(result.remainingText, "check this");
  });

  test("keeps unknown command in remaining text", () => {
    const result = parseRuntimeCommands("/unknown do something");

    assert.deepEqual(result.commands, []);
    assert.deepEqual(result.unknownCommandTexts, ["/unknown"]);
    assert.equal(result.remainingText, "/unknown do something");
  });

  test("does not remove punctuation-adjacent slash text", () => {
    const result = parseRuntimeCommands("/context, explain this");

    assert.deepEqual(result.commands, []);
    assert.deepEqual(result.unknownCommandTexts, []);
    assert.equal(result.remainingText, "/context, explain this");
  });
});

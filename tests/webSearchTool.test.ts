import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { createWebSearchTool } from "../src/agent/tools/webSearchTool.ts";

interface MockResponse {
  ok: boolean;
  status: number;
  payload: unknown;
}

function mockFetchSequence(sequence: MockResponse[]) {
  const calls: Array<{ url: string; body?: string }> = [];
  let index = 0;

  const fetchImpl = async (url: string, init?: { body?: string }) => {
    calls.push({ url, body: init?.body });
    const current = sequence[index];
    index += 1;
    if (!current) {
      throw new Error(`Unexpected fetch call #${index} for ${url}`);
    }

    return {
      ok: current.ok,
      status: current.status,
      async text() {
        return JSON.stringify(current.payload);
      },
    };
  };

  return { fetchImpl, calls };
}

async function withEnv(
  values: Record<string, string | undefined>,
  run: () => Promise<void>
): Promise<void> {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function extractText(result: { content: Array<{ type: string; text?: string }> }): string {
  const textPart = result.content.find((part) => part.type === "text");
  assert.ok(textPart?.text);
  return textPart.text;
}

describe("createWebSearchTool", () => {
  test("does not expose toolRulePrompt and keeps usage guidance in description", () => {
    const tool = createWebSearchTool();
    assert.equal(tool.name, "web_search");
    assert.equal(tool.toolRulePrompt, undefined);
    assert.match(tool.description, /broad web discovery/i);
  });

  test("returns Tavily results directly when Tavily succeeds", async () => {
    const { fetchImpl, calls } = mockFetchSequence([
      {
        ok: true,
        status: 200,
        payload: {
          results: [
            {
              url: "https://example.com/a",
              content: "Alpha description",
              title: "Alpha",
              score: 0.91,
            },
          ],
        },
      },
    ]);

    await withEnv({ TEST_TAVILY_KEY: "tvly-test", TEST_LINKUP_KEY: "linkup-test" }, async () => {
      const tool = createWebSearchTool({
        fetchImpl,
        tavilyApiKeyEnvVar: "TEST_TAVILY_KEY",
        linkupApiKeyEnvVar: "TEST_LINKUP_KEY",
      });

      const result = await tool.execute("call-1", { query: "alpha" });
      const details = result.details as any;

      assert.equal(details.ok, true);
      assert.equal(details.providerUsed, "tavily");
      assert.deepEqual(details.providerTried, ["tavily"]);
      assert.equal(details.resultCount, 1);
      assert.equal(details.results[0].url, "https://example.com/a");
      assert.equal(details.results[0].description, "Alpha description");
      assert.match(extractText(result as any), /provider: tavily/i);
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.url, "https://api.tavily.com/search");
    });
  });

  test("falls back to Linkup when Tavily credits are insufficient", async () => {
    const { fetchImpl, calls } = mockFetchSequence([
      {
        ok: false,
        status: 432,
        payload: { detail: { error: "This request exceeds your plan's set usage limit." } },
      },
      {
        ok: true,
        status: 200,
        payload: {
          results: [
            {
              url: "https://news.example.com/item",
              content: "News snippet",
              name: "News title",
            },
          ],
        },
      },
    ]);

    await withEnv({ TEST_TAVILY_KEY: "tvly-test", TEST_LINKUP_KEY: "linkup-test" }, async () => {
      const tool = createWebSearchTool({
        fetchImpl,
        tavilyApiKeyEnvVar: "TEST_TAVILY_KEY",
        linkupApiKeyEnvVar: "TEST_LINKUP_KEY",
      });

      const result = await tool.execute("call-2", { query: "latest news", max_results: 3 });
      const details = result.details as any;

      assert.equal(details.ok, true);
      assert.equal(details.providerUsed, "linkup");
      assert.deepEqual(details.providerTried, ["tavily", "linkup"]);
      assert.equal(details.fallbackReason, "tavily_insufficient_credits");
      assert.equal(details.results[0].description, "News snippet");
      assert.equal(calls.length, 2);
      assert.equal(calls[1]?.url, "https://api.linkup.so/v1/search");
    });
  });

  test("returns all_providers_insufficient_credits when Linkup fallback also hits credit limits", async () => {
    const { fetchImpl } = mockFetchSequence([
      {
        ok: false,
        status: 433,
        payload: { detail: { error: "pay-as-you-go limit exceeded" } },
      },
      {
        ok: false,
        status: 429,
        payload: { message: "insufficient credits" },
      },
    ]);

    await withEnv({ TEST_TAVILY_KEY: "tvly-test", TEST_LINKUP_KEY: "linkup-test" }, async () => {
      const tool = createWebSearchTool({
        fetchImpl,
        tavilyApiKeyEnvVar: "TEST_TAVILY_KEY",
        linkupApiKeyEnvVar: "TEST_LINKUP_KEY",
      });

      const result = await tool.execute("call-3", { query: "market update" });
      const details = result.details as any;
      assert.equal(details.ok, false);
      assert.equal(details.errorCode, "all_providers_insufficient_credits");
      assert.deepEqual(details.providerTried, ["tavily", "linkup"]);
    });
  });

  test("does not fallback on Tavily rate-limit 429", async () => {
    const { fetchImpl, calls } = mockFetchSequence([
      {
        ok: false,
        status: 429,
        payload: { detail: { error: "Please reduce rate of requests." } },
      },
    ]);

    await withEnv({ TEST_TAVILY_KEY: "tvly-test", TEST_LINKUP_KEY: "linkup-test" }, async () => {
      const tool = createWebSearchTool({
        fetchImpl,
        tavilyApiKeyEnvVar: "TEST_TAVILY_KEY",
        linkupApiKeyEnvVar: "TEST_LINKUP_KEY",
      });

      const result = await tool.execute("call-4", { query: "something" });
      const details = result.details as any;

      assert.equal(details.ok, false);
      assert.equal(details.errorCode, "tavily_failed_non_credit");
      assert.deepEqual(details.providerTried, ["tavily"]);
      assert.equal(calls.length, 1);
    });
  });

  test("validates input parameters and returns invalid_input", async () => {
    const { fetchImpl, calls } = mockFetchSequence([]);

    await withEnv({ TEST_TAVILY_KEY: "tvly-test", TEST_LINKUP_KEY: "linkup-test" }, async () => {
      const tool = createWebSearchTool({
        fetchImpl,
        tavilyApiKeyEnvVar: "TEST_TAVILY_KEY",
        linkupApiKeyEnvVar: "TEST_LINKUP_KEY",
      });

      const result = await tool.execute("call-5", {
        query: "  ",
        start_date: "2026-13-01",
      });
      const details = result.details as any;

      assert.equal(details.ok, false);
      assert.equal(details.errorCode, "invalid_input");
      assert.equal(calls.length, 0);
    });
  });
});


import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { formatMarkdownForTelegram } from "../../src/gateway/egress/telegramTextFormatter.ts";

describe("formatMarkdownForTelegram", () => {
  test("converts common markdown into Telegram HTML", () => {
    const formatted = formatMarkdownForTelegram([
      "## 结论",
      "这是 **重点** 和 `code`。",
      "看 [OpenAI](https://openai.com)。",
    ].join("\n"));

    assert.equal(formatted.parseMode, "HTML");
    assert.equal(
      formatted.text,
      [
        "<b>结论</b>",
        "这是 <b>重点</b> 和 <code>code</code>。",
        '看 <a href="https://openai.com">OpenAI</a>。',
      ].join("\n")
    );
  });

  test("renders markdown tables as preformatted aligned text", () => {
    const formatted = formatMarkdownForTelegram([
      "| 名称 | 值 |",
      "| --- | ---: |",
      "| alpha | 1 |",
      "| beta | 22 |",
    ].join("\n"));

    assert.equal(
      formatted.text,
      [
        "<pre>名称    | 值",
        "------+----",
        "alpha | 1",
        "beta  | 22</pre>",
      ].join("\n")
    );
  });

  test("escapes html while preserving code fences", () => {
    const formatted = formatMarkdownForTelegram([
      "普通 <tag> & text",
      "```ts",
      "const x = a < b && c > d;",
      "```",
    ].join("\n"));

    assert.equal(
      formatted.text,
      [
        "普通 &lt;tag&gt; &amp; text",
        "<pre>const x = a &lt; b &amp;&amp; c &gt; d;</pre>",
      ].join("\n")
    );
  });
});

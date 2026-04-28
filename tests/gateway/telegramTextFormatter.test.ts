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

  test("renders two-column markdown tables as mobile-friendly key-value lines", () => {
    const formatted = formatMarkdownForTelegram([
      "| 名称 | 值 |",
      "| --- | ---: |",
      "| alpha | 1 |",
      "| beta | 22 |",
    ].join("\n"));

    assert.equal(
      formatted.text,
      [
        "<b>alpha</b>: 1",
        "<b>beta</b>: 22",
      ].join("\n")
    );
  });

  test("renders wide markdown tables as vertical row sections", () => {
    const formatted = formatMarkdownForTelegram([
      "| 对比项 | browser-use | Google Workspace CLI (gws) |",
      "| --- | --- | --- |",
      "| Skill 定义 | SKILL.md | SKILL.md(50+ 个预定义) |",
      "| 执行方式 | Bash CLI (browser-use --session ...) | Bash CLI (gws gmail +read --id ...) |",
    ].join("\n"));

    assert.equal(
      formatted.text,
      [
        "<b>对比项: Skill 定义</b>",
        "- <b>browser-use</b>: SKILL.md",
        "- <b>Google Workspace CLI (gws)</b>: SKILL.md(50+ 个预定义)",
        "",
        "<b>对比项: 执行方式</b>",
        "- <b>browser-use</b>: Bash CLI (browser-use --session ...)",
        "- <b>Google Workspace CLI (gws)</b>: Bash CLI (gws gmail +read --id ...)",
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

  test("handles nested markdown, task lists, and autolinks through remark-gfm", () => {
    const formatted = formatMarkdownForTelegram([
      "- [x] **done** item",
      "- [ ] ~~pending~~ item with www.example.com",
      "",
      "> nested **quote**",
    ].join("\n"));

    assert.equal(
      formatted.text,
      [
        "- [x] <b>done</b> item",
        '- [ ] <s>pending</s> item with <a href="http://www.example.com">www.example.com</a>',
        "> nested <b>quote</b>",
      ].join("\n")
    );
  });
});

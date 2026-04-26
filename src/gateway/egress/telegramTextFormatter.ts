export interface TelegramFormattedMessage {
  text: string;
  parseMode: "HTML";
}

interface MarkdownBlock {
  type: "text" | "code" | "table";
  content: string;
  language?: string;
}

export function formatMarkdownForTelegram(input: string): TelegramFormattedMessage {
  const blocks = splitMarkdownBlocks(input);
  const text = blocks.map(formatBlock).join("\n");
  return {
    text,
    parseMode: "HTML",
  };
}

function splitMarkdownBlocks(input: string): MarkdownBlock[] {
  const lines = input.replace(/\r\n/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let textLines: string[] = [];

  const flushText = (): void => {
    if (textLines.length === 0) {
      return;
    }
    blocks.push({ type: "text", content: textLines.join("\n") });
    textLines = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const fence = line.match(/^```([a-zA-Z0-9_-]*)\s*$/);
    if (fence) {
      flushText();
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index] ?? "")) {
        codeLines.push(lines[index] ?? "");
        index += 1;
      }
      blocks.push({
        type: "code",
        content: codeLines.join("\n"),
        language: fence[1],
      });
      continue;
    }

    if (isMarkdownTableStart(lines, index)) {
      flushText();
      const tableLines: string[] = [];
      while (index < lines.length && isTableLikeLine(lines[index] ?? "")) {
        tableLines.push(lines[index] ?? "");
        index += 1;
      }
      index -= 1;
      blocks.push({ type: "table", content: tableLines.join("\n") });
      continue;
    }

    textLines.push(line);
  }

  flushText();
  return blocks;
}

function formatBlock(block: MarkdownBlock): string {
  if (block.type === "code") {
    return `<pre>${escapeHtml(block.content)}</pre>`;
  }

  if (block.type === "table") {
    return `<pre>${escapeHtml(formatMarkdownTable(block.content))}</pre>`;
  }

  return formatInlineMarkdown(block.content);
}

function formatInlineMarkdown(input: string): string {
  const codeSpans: string[] = [];
  let text = input.replace(/`([^`\n]+)`/g, (_match, code: string) => {
    const token = `\u0000CODE${codeSpans.length}\u0000`;
    codeSpans.push(`<code>${escapeHtml(code)}</code>`);
    return token;
  });

  text = escapeHtml(text);
  text = text.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");
  text = text.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
  text = text.replace(/\*\*([^*\n][^*\n]*?)\*\*/g, "<b>$1</b>");
  text = text.replace(/__([^_\n][^_\n]*?)__/g, "<b>$1</b>");
  text = text.replace(/~~([^~\n][^~\n]*?)~~/g, "<s>$1</s>");

  for (const [index, code] of codeSpans.entries()) {
    text = text.replace(`\u0000CODE${index}\u0000`, code);
  }

  return text;
}

function formatMarkdownTable(input: string): string {
  const lines = input.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length < 2) {
    return input;
  }

  const rows = lines
    .filter((line, index) => index !== 1 || !isMarkdownTableSeparator(line))
    .map(parseTableRow);
  const columnCount = Math.max(...rows.map((row) => row.length));
  const widths = Array.from({ length: columnCount }, (_, columnIndex) =>
    Math.max(...rows.map((row) => (row[columnIndex] ?? "").length))
  );

  const formattedRows = rows.map((row) =>
    widths.map((width, columnIndex) => (row[columnIndex] ?? "").padEnd(width)).join(" | ").trimEnd()
  );

  if (formattedRows.length <= 1) {
    return formattedRows.join("\n");
  }

  const separator = widths.map((width) => "-".repeat(Math.max(width, 3))).join("-+-");
  return [formattedRows[0], separator, ...formattedRows.slice(1)].join("\n");
}

function parseTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

function isMarkdownTableStart(lines: string[], index: number): boolean {
  const current = lines[index] ?? "";
  const next = lines[index + 1] ?? "";
  return isTableLikeLine(current) && isMarkdownTableSeparator(next);
}

function isTableLikeLine(line: string): boolean {
  return line.includes("|") && line.trim().length > 0;
}

function isMarkdownTableSeparator(line: string): boolean {
  const cells = parseTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

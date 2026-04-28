import { unified } from "unified";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";

export interface TelegramFormattedMessage {
  text: string;
  parseMode: "HTML";
}

interface MdNode {
  type: string;
  value?: string;
  url?: string;
  lang?: string;
  ordered?: boolean;
  start?: number | null;
  checked?: boolean | null;
  children?: MdNode[];
}

export function formatMarkdownForTelegram(input: string): TelegramFormattedMessage {
  const tree = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .parse(input) as MdNode;

  return {
    text: renderRoot(tree).trimEnd(),
    parseMode: "HTML",
  };
}

function renderRoot(node: MdNode): string {
  return renderChildren(node).filter((chunk) => chunk.length > 0).join("\n");
}

function renderBlock(node: MdNode, listContext?: ListContext): string {
  switch (node.type) {
    case "paragraph":
      return renderInlineChildren(node);
    case "heading":
      return `<b>${renderInlineChildren(node)}</b>`;
    case "code":
      return `<pre>${escapeHtml(node.value ?? "")}</pre>`;
    case "blockquote":
      return renderBlockquote(node);
    case "list":
      return renderList(node);
    case "listItem":
      return renderListItem(node, listContext);
    case "table":
      return renderTable(node);
    case "thematicBreak":
      return "-----";
    case "html":
      return escapeHtml(node.value ?? "");
    default:
      return renderInline(node);
  }
}

function renderInline(node: MdNode): string {
  switch (node.type) {
    case "text":
      return escapeHtml(node.value ?? "");
    case "break":
      return "\n";
    case "inlineCode":
      return `<code>${escapeHtml(node.value ?? "")}</code>`;
    case "html":
      return escapeHtml(node.value ?? "");
    case "strong":
      return `<b>${renderInlineChildren(node)}</b>`;
    case "emphasis":
      return `<i>${renderInlineChildren(node)}</i>`;
    case "delete":
      return `<s>${renderInlineChildren(node)}</s>`;
    case "link":
      return renderLink(node);
    case "image":
      return renderImage(node);
    default:
      return renderInlineChildren(node);
  }
}

function renderChildren(node: MdNode): string[] {
  return (node.children ?? []).map((child) => renderBlock(child));
}

function renderInlineChildren(node: MdNode): string {
  return (node.children ?? []).map((child) => renderInline(child)).join("");
}

function renderBlockquote(node: MdNode): string {
  return renderChildren(node)
    .join("\n")
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

interface ListContext {
  ordered: boolean;
  start: number;
}

function renderList(node: MdNode): string {
  const context = {
    ordered: node.ordered === true,
    start: typeof node.start === "number" ? node.start : 1,
  };

  return (node.children ?? [])
    .map((child, index) => renderListItem(child, {
      ordered: context.ordered,
      start: context.start + index,
    }))
    .join("\n");
}

function renderListItem(node: MdNode, context?: ListContext): string {
  const prefix = buildListPrefix(node, context);
  const rendered = renderChildren(node).join("\n");
  const lines = rendered.split("\n");
  const [firstLine = "", ...rest] = lines;
  const indent = " ".repeat(prefix.length);

  return [
    `${prefix}${firstLine}`,
    ...rest.map((line) => `${indent}${line}`),
  ].join("\n");
}

function buildListPrefix(node: MdNode, context?: ListContext): string {
  const marker = context?.ordered ? `${context.start}. ` : "- ";
  if (node.checked === true) {
    return `${marker}[x] `;
  }
  if (node.checked === false) {
    return `${marker}[ ] `;
  }
  return marker;
}

function renderLink(node: MdNode): string {
  const url = node.url ?? "";
  const label = renderInlineChildren(node) || escapeHtml(url);
  if (!isSafeTelegramLink(url)) {
    return label;
  }
  return `<a href="${escapeHtmlAttribute(url)}">${label}</a>`;
}

function renderImage(node: MdNode): string {
  const url = node.url ?? "";
  const label = escapeHtml(node.value ?? "image");
  if (!isSafeTelegramLink(url)) {
    return label;
  }
  return `<a href="${escapeHtmlAttribute(url)}">${label}</a>`;
}

function renderTable(node: MdNode): string {
  const rows = (node.children ?? []).map((row) =>
    (row.children ?? []).map((cell) => renderTableCell(cell))
  );

  if (rows.length === 0) {
    return "";
  }

  const [headers = [], ...bodyRows] = rows;
  if (headers.length === 0 || bodyRows.length === 0) {
    return rows.map((row) => row.join(" | ")).join("\n");
  }

  if (headers.length === 2) {
    return bodyRows
      .map((row) => `<b>${escapeHtml(row[0] ?? "")}</b>: ${escapeHtml(row[1] ?? "")}`)
      .join("\n");
  }

  return bodyRows
    .map((row) => renderVerticalTableRow(headers, row))
    .join("\n\n");
}

function renderVerticalTableRow(headers: string[], row: string[]): string {
  const [titleHeader = "Item", ...valueHeaders] = headers;
  const [title = "", ...values] = row;
  const lines = [`<b>${escapeHtml(titleHeader)}: ${escapeHtml(title)}</b>`];

  for (const [index, header] of valueHeaders.entries()) {
    const value = values[index] ?? "";
    if (!value) {
      continue;
    }
    lines.push(`- <b>${escapeHtml(header)}</b>: ${escapeHtml(value)}`);
  }

  return lines.join("\n");
}

function renderTableCell(node: MdNode): string {
  return (node.children ?? [])
    .map((child) => renderPlainText(child))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

function renderPlainText(node: MdNode): string {
  switch (node.type) {
    case "text":
    case "inlineCode":
    case "code":
    case "html":
      return node.value ?? "";
    case "break":
      return " ";
    case "link":
    case "image":
      return renderPlainChildren(node) || node.url || "";
    default:
      return renderPlainChildren(node);
  }
}

function renderPlainChildren(node: MdNode): string {
  return (node.children ?? []).map((child) => renderPlainText(child)).join("");
}

function isSafeTelegramLink(url: string): boolean {
  return /^(https?:\/\/|tg:\/\/user\?id=)/i.test(url);
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeHtmlAttribute(input: string): string {
  return escapeHtml(input).replace(/"/g, "&quot;");
}

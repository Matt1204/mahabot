import { isMap, isScalar, parseDocument } from "yaml";

import type { SkillDescriptionExtraction, SkillParseWarning } from "./types.js";

export interface ParseSkillFrontmatterSuccess {
  ok: true;
  name: string;
  description: SkillDescriptionExtraction;
  warnings: SkillParseWarning[];
}

export interface ParseSkillFrontmatterFailure {
  ok: false;
  warnings: SkillParseWarning[];
}

export type ParseSkillFrontmatterResult =
  | ParseSkillFrontmatterSuccess
  | ParseSkillFrontmatterFailure;

export function parseSkillFrontmatter(
  skillMarkdown: string,
  fallbackName: string,
  location: string
): ParseSkillFrontmatterResult {
  const warnings: SkillParseWarning[] = [];
  const frontmatterText = extractFrontmatterText(skillMarkdown);

  if (!frontmatterText) {
    warnings.push(
      makeWarning(
        "parse_failed",
        "Missing or invalid YAML frontmatter delimited by leading and closing '---' lines.",
        location
      )
    );
    return {
      ok: false,
      warnings,
    };
  }

  const doc = parseDocument(frontmatterText, { keepSourceTokens: true });
  if (doc.errors.length > 0) {
    const first = doc.errors[0];
    warnings.push(makeWarning("parse_failed", `YAML parse failed: ${first.message}`, location));
    return {
      ok: false,
      warnings,
    };
  }

  const nameNode = getTopLevelValueNode(doc.contents, "name");
  const parsedName = getScalarString(nameNode);
  const name = parsedName && parsedName.length > 0 ? parsedName : fallbackName;

  const descriptionNode = getTopLevelValueNode(doc.contents, "description");
  const parsedDescription = getScalarString(descriptionNode);
  const range = toRange(descriptionNode?.range);
  const rawSlice = range ? frontmatterText.slice(range.start, range.end) : undefined;

  let descriptionValue = parsedDescription && parsedDescription.length > 0 ? parsedDescription : undefined;
  if (!descriptionValue) {
    warnings.push(
      makeWarning("description_fallback", "Missing or non-string `description`; fallback to skill name.", location)
    );
    descriptionValue = name;
  }

  if (descriptionValue.length > 1024) {
    warnings.push(
      makeWarning(
        "description_guide_violation",
        "Description exceeds 1024 characters (guide recommendation).",
        location
      )
    );
  }

  if (descriptionValue.includes("<") || descriptionValue.includes(">")) {
    warnings.push(
      makeWarning(
        "description_guide_violation",
        "Description contains XML angle brackets (< or >), which is discouraged.",
        location
      )
    );
  }

  return {
    ok: true,
    name,
    description: {
      value: descriptionValue,
      rawSlice,
      range,
    },
    warnings,
  };
}

function extractFrontmatterText(markdown: string): string | null {
  const normalized = markdown.startsWith("\uFEFF") ? markdown.slice(1) : markdown;
  const lines = normalized.split(/\r?\n/);

  if (lines.length === 0 || lines[0] !== "---") {
    return null;
  }

  let closingIndex = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index] === "---") {
      closingIndex = index;
      break;
    }
  }

  if (closingIndex < 0) {
    return null;
  }

  return lines.slice(1, closingIndex).join("\n");
}

function getTopLevelValueNode(
  root: unknown,
  key: string
): { value: unknown; range?: [number, number, number] } | undefined {
  if (!isMap(root)) {
    return undefined;
  }

  for (const item of root.items) {
    if (!isScalar(item.key)) {
      continue;
    }
    if (item.key.value !== key) {
      continue;
    }
    return item.value as { value: unknown; range?: [number, number, number] } | undefined;
  }

  return undefined;
}

function getScalarString(
  node: { value: unknown } | undefined
): string | undefined {
  if (!node || !isScalar(node)) {
    return undefined;
  }
  if (typeof node.value !== "string") {
    return undefined;
  }
  return node.value.trim();
}

function toRange(
  rawRange: [number, number, number] | undefined
): { start: number; end: number } | undefined {
  if (!rawRange) {
    return undefined;
  }

  const start = rawRange[0];
  const end = rawRange[1];
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) {
    return undefined;
  }

  return { start, end };
}

function makeWarning(
  code: SkillParseWarning["code"],
  message: string,
  location: string
): SkillParseWarning {
  return { code, message, location };
}


import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";

import { Type } from "@mariozechner/pi-ai";

import type { DescribedAgentTool } from "./registry/types.js";
import { textResult } from "./showcase/shared.js";
import {
  FsToolError,
  assertDirectoryPath,
  resolvePolicyPath,
  type FsToolBaseDetails,
} from "./filesystem_shared/core.js";
import { compileGlobList, type GlobMatcher } from "./filesystem_shared/globMatcher.js";

const DEFAULT_EXCLUDES = ["**/node_modules/**", "**/.git/**", "**/dist/**"];
const MAX_LINE_PREVIEW_CHARS = 240;
const BINARY_SNIFF_BYTES = 1024;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

interface CreateGrepToolInput {
  workspaceRoot: string;
  restrictToWorkspace: boolean;
}

interface GrepMatchSpan {
  startColumn: number;
  endColumn: number;
}

interface GrepMatchRecord {
  path: string;
  line: number;
  column: number;
  text: string;
  spans?: GrepMatchSpan[];
  before?: string[];
  after?: string[];
}

interface GrepDetails extends FsToolBaseDetails {
  tool: "grep";
  root?: string;
  pattern?: string;
  isRegex?: boolean;
  caseSensitive?: boolean;
  totalMatches?: number;
  returnedMatches?: number;
  truncated?: boolean;
  truncatedBy?: "max_matches" | "max_files";
  filesConsidered?: number;
  filesScanned?: number;
  filesSkippedBinary?: number;
  filesSkippedHidden?: number;
  filesSkippedExcluded?: number;
  filesReadErrors?: number;
  matches?: GrepMatchRecord[];
}

interface SearchContext {
  matcher: Matcher;
  maxMatches: number;
  maxFiles: number;
  contextBefore: number;
  contextAfter: number;
  includeHidden: boolean;
  includeMatchers: GlobMatcher[];
  excludeMatchers: GlobMatcher[];
}

interface SearchState {
  filesConsidered: number;
  filesScanned: number;
  filesSkippedBinary: number;
  filesSkippedHidden: number;
  filesSkippedExcluded: number;
  filesReadErrors: number;
  totalMatches: number;
  truncated: boolean;
  truncatedBy?: "max_matches" | "max_files";
  matches: GrepMatchRecord[];
}

interface Matcher {
  isRegex: boolean;
  caseSensitive: boolean;
  pattern: string;
  findMatches(line: string): GrepMatchSpan[];
}

export function createGrepTool(input: CreateGrepToolInput): DescribedAgentTool {
  const schema = Type.Object({
    pattern: Type.String({
      minLength: 1,
      description: "Literal text or regular expression to search for.",
    }),
    path: Type.Optional(
      Type.String({
        minLength: 1,
        description: "Root directory to search. Relative paths resolve from workspace root.",
      })
    ),
    isRegex: Type.Optional(
      Type.Boolean({
        description: "When true, treat `pattern` as a JavaScript regular expression.",
      })
    ),
    caseSensitive: Type.Optional(
      Type.Boolean({
        description: "When false, search case-insensitively.",
      })
    ),
    include: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), {
        description: "Optional include globs for candidate file paths relative to the grep root.",
      })
    ),
    exclude: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), {
        description: "Optional exclude globs for candidate file paths relative to the grep root.",
      })
    ),
    maxMatches: Type.Optional(
      Type.Number({
        minimum: 1,
        maximum: 100,
        description: "Maximum number of matching lines to return.",
      })
    ),
    maxFiles: Type.Optional(
      Type.Number({
        minimum: 1,
        maximum: 500,
        description: "Maximum number of files to scan before truncating.",
      })
    ),
    contextBefore: Type.Optional(
      Type.Number({
        minimum: 0,
        maximum: 3,
        description: "Number of preceding lines to include with each match.",
      })
    ),
    contextAfter: Type.Optional(
      Type.Number({
        minimum: 0,
        maximum: 3,
        description: "Number of following lines to include with each match.",
      })
    ),
    includeHidden: Type.Optional(
      Type.Boolean({
        description: "Include dot-prefixed files and directories when true.",
      })
    ),
  });

  const tool: DescribedAgentTool = {
    name: "grep",
    label: "Grep",
    description:
      "Use this tool to search text content across many files without falling back to shell grep. It supports literal and regex search, bounded recursive traversal, conservative default context lines, and structured match metadata for follow-up `read_file` calls.",
    toolRulePrompt:
      "Use `grep` to search file contents across many files. Prefer it over `bash` for identifier lookups, text search, TODO discovery, and finding definitions or usages. After locating relevant hits, use `read_file` to inspect the surrounding code more closely.",
    parameters: schema,
    async execute(_toolCallId, params) {
      const pattern = params.pattern.trim();
      const maxMatches = normalizeIntegerInRange(params.maxMatches, 200, 1, 2000);
      const maxFiles = normalizeIntegerInRange(params.maxFiles, 5000, 1, 20000);
      const contextBefore = normalizeIntegerInRange(params.contextBefore, 1, 0, 5);
      const contextAfter = normalizeIntegerInRange(params.contextAfter, 1, 0, 5);

      if (!pattern) {
        return fail("Invalid `pattern`: expected a non-empty string.", {
          tool: "grep",
          ok: false,
          errorCode: "invalid_path",
        });
      }

      if (maxMatches === null || maxFiles === null || contextBefore === null || contextAfter === null) {
        return fail("Invalid numeric parameters for grep search.", {
          tool: "grep",
          ok: false,
          errorCode: "invalid_path",
          pattern,
        });
      }

      try {
        const matcher = buildMatcher(pattern, params.isRegex ?? false, params.caseSensitive ?? true);
        const includeMatchers = compileGlobList(params.include, "invalid_path");
        const excludeMatchers = compileGlobList(params.exclude ?? DEFAULT_EXCLUDES, "invalid_path");
        const { resolvedPath } = await resolvePolicyPath({
          inputPath: params.path ?? ".",
          workspaceRoot: input.workspaceRoot,
          restrictToWorkspace: input.restrictToWorkspace,
        });

        await assertDirectoryPath(resolvedPath);

        const state: SearchState = {
          filesConsidered: 0,
          filesScanned: 0,
          filesSkippedBinary: 0,
          filesSkippedHidden: 0,
          filesSkippedExcluded: 0,
          filesReadErrors: 0,
          totalMatches: 0,
          truncated: false,
          matches: [],
        };

        const searchContext: SearchContext = {
          matcher,
          maxMatches,
          maxFiles,
          contextBefore,
          contextAfter,
          includeHidden: params.includeHidden ?? false,
          includeMatchers,
          excludeMatchers,
        };

        await walkAndSearch(resolvedPath, resolvedPath, searchContext, state);

        return textResult(formatGrepOutput(resolvedPath, state, matcher), {
          tool: "grep",
          ok: true,
          root: resolvedPath,
          resolvedPath,
          pattern,
          isRegex: matcher.isRegex,
          caseSensitive: matcher.caseSensitive,
          totalMatches: state.totalMatches,
          returnedMatches: state.matches.length,
          truncated: state.truncated,
          truncatedBy: state.truncatedBy,
          filesConsidered: state.filesConsidered,
          filesScanned: state.filesScanned,
          filesSkippedBinary: state.filesSkippedBinary,
          filesSkippedHidden: state.filesSkippedHidden,
          filesSkippedExcluded: state.filesSkippedExcluded,
          filesReadErrors: state.filesReadErrors,
          matches: state.matches,
        } satisfies GrepDetails);
      } catch (error) {
        if (error instanceof FsToolError) {
          return fail(error.message, {
            tool: "grep",
            ok: false,
            errorCode: error.code,
            pattern,
            resolvedPath: error.resolvedPath,
          });
        }

        const message = error instanceof Error ? error.message : "Unknown error.";
        return fail(`Grep failed: ${message}`, {
          tool: "grep",
          ok: false,
          errorCode: "io_error",
          pattern,
        });
      }
    },
  };

  return tool;
}

async function walkAndSearch(
  rootPath: string,
  currentDir: string,
  context: SearchContext,
  state: SearchState
): Promise<void> {
  if (state.truncated && state.truncatedBy === "max_files") {
    return;
  }

  let directoryEntries = await readdir(currentDir, { withFileTypes: true });
  directoryEntries = directoryEntries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of directoryEntries) {
    if (state.truncated && state.truncatedBy === "max_files") {
      return;
    }

    if (!context.includeHidden && entry.name.startsWith(".")) {
      state.filesSkippedHidden += 1;
      continue;
    }

    const absPath = join(currentDir, entry.name);
    const relPath = relative(rootPath, absPath).split("\\").join("/");

    if (entry.isDirectory()) {
      if (shouldExcludePath(relPath, true, context)) {
        state.filesSkippedExcluded += 1;
        continue;
      }

      await walkAndSearch(rootPath, absPath, context, state);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    state.filesConsidered += 1;

    if (!shouldIncludePath(relPath, context) || shouldExcludePath(relPath, false, context)) {
      state.filesSkippedExcluded += 1;
      continue;
    }

    if (state.filesScanned >= context.maxFiles) {
      state.truncated = true;
      state.truncatedBy = "max_files";
      return;
    }

    const outcome = await searchFile(absPath, relPath, context);
    if (outcome.kind === "binary") {
      state.filesSkippedBinary += 1;
      continue;
    }

    if (outcome.kind === "error") {
      state.filesReadErrors += 1;
      continue;
    }

    state.filesScanned += 1;

    for (const match of outcome.matches) {
      if (state.matches.length >= context.maxMatches) {
        state.truncated = true;
        state.truncatedBy = "max_matches";
        return;
      }

      state.matches.push(match);
      state.totalMatches += 1;
    }
  }
}

async function searchFile(
  absPath: string,
  relPath: string,
  context: SearchContext
): Promise<
  | { kind: "ok"; matches: GrepMatchRecord[] }
  | { kind: "binary" }
  | { kind: "error" }
> {
  try {
    const fileInfo = await stat(absPath);
    if (!fileInfo.isFile()) {
      return { kind: "error" };
    }

    const bytes = await readFile(absPath);
    if (looksBinary(bytes)) {
      return { kind: "binary" };
    }

    let text: string;
    try {
      text = UTF8_DECODER.decode(bytes);
    } catch {
      return { kind: "binary" };
    }

    const lines = text.split(/\r\n|\n|\r/);
    const matches: GrepMatchRecord[] = [];

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const spans = context.matcher.findMatches(line);
      if (spans.length === 0) {
        continue;
      }

      matches.push({
        path: relPath,
        line: index + 1,
        column: spans[0].startColumn,
        text: line,
        spans,
        before:
          context.contextBefore > 0
            ? lines.slice(Math.max(0, index - context.contextBefore), index)
            : undefined,
        after:
          context.contextAfter > 0
            ? lines.slice(index + 1, Math.min(lines.length, index + 1 + context.contextAfter))
            : undefined,
      });
    }

    return { kind: "ok", matches };
  } catch {
    return { kind: "error" };
  }
}

function buildMatcher(pattern: string, isRegex: boolean, caseSensitive: boolean): Matcher {
  if (isRegex) {
    try {
      const regex = new RegExp(pattern, caseSensitive ? "g" : "gi");
      return {
        isRegex: true,
        caseSensitive,
        pattern,
        findMatches(line: string): GrepMatchSpan[] {
          const spans: GrepMatchSpan[] = [];
          regex.lastIndex = 0;

          let match: RegExpExecArray | null;
          while ((match = regex.exec(line)) !== null) {
            const text = match[0] ?? "";
            const length = Math.max(text.length, 1);
            spans.push({
              startColumn: match.index + 1,
              endColumn: match.index + length,
            });

            if (text.length === 0) {
              regex.lastIndex = match.index + 1;
            }
          }

          return spans;
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid regular expression.";
      throw new FsToolError("invalid_regex", message);
    }
  }

  const needle = caseSensitive ? pattern : pattern.toLocaleLowerCase();
  return {
    isRegex: false,
    caseSensitive,
    pattern,
    findMatches(line: string): GrepMatchSpan[] {
      const haystack = caseSensitive ? line : line.toLocaleLowerCase();
      const spans: GrepMatchSpan[] = [];
      let index = 0;

      while (index <= haystack.length - needle.length) {
        const matchIndex = haystack.indexOf(needle, index);
        if (matchIndex === -1) {
          break;
        }

        spans.push({
          startColumn: matchIndex + 1,
          endColumn: matchIndex + needle.length,
        });

        index = matchIndex + Math.max(needle.length, 1);
      }

      return spans;
    },
  };
}

function shouldIncludePath(relPath: string, context: SearchContext): boolean {
  if (context.includeMatchers.length === 0) {
    return true;
  }

  return context.includeMatchers.some((matcher) => matcher.regex.test(relPath));
}

function shouldExcludePath(relPath: string, isDirectory: boolean, context: SearchContext): boolean {
  const candidates = isDirectory ? [relPath, `${relPath}/`] : [relPath];
  return context.excludeMatchers.some((matcher) =>
    candidates.some((candidate) => matcher.regex.test(candidate))
  );
}

function looksBinary(bytes: Uint8Array): boolean {
  const sniffLength = Math.min(bytes.length, BINARY_SNIFF_BYTES);
  for (let index = 0; index < sniffLength; index += 1) {
    if (bytes[index] === 0) {
      return true;
    }
  }

  return false;
}

function formatGrepOutput(root: string, state: SearchState, matcher: Matcher): string {
  const lines = [
    `Grep results: ${root}`,
    `- pattern: ${matcher.pattern}`,
    `- isRegex: ${matcher.isRegex}`,
    `- caseSensitive: ${matcher.caseSensitive}`,
    `- filesConsidered: ${state.filesConsidered}`,
    `- filesScanned: ${state.filesScanned}`,
    `- returnedMatches: ${state.matches.length}`,
    `- totalMatchesObserved: ${state.totalMatches}`,
    `- truncated: ${state.truncated}`,
  ];

  if (state.truncatedBy) {
    lines.push(`- truncatedBy: ${state.truncatedBy}`);
  }

  lines.push("");

  if (state.matches.length === 0) {
    lines.push("(no matches)");
    return lines.join("\n");
  }

  for (const match of state.matches) {
    lines.push(`${match.path}:${match.line}:${match.column} | ${clipLine(match.text)}`);
    for (const beforeLine of match.before ?? []) {
      lines.push(`  before | ${clipLine(beforeLine)}`);
    }
    for (const afterLine of match.after ?? []) {
      lines.push(`  after  | ${clipLine(afterLine)}`);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

function clipLine(value: string): string {
  if (value.length <= MAX_LINE_PREVIEW_CHARS) {
    return value;
  }

  return `${value.slice(0, MAX_LINE_PREVIEW_CHARS - 3)}...`;
}

function fail(message: string, details: GrepDetails) {
  return textResult(`Grep failed: ${message}`, {
    ...details,
    message,
  });
}

function normalizeIntegerInRange(
  value: number | undefined,
  defaultValue: number,
  min: number,
  max: number
): number | null {
  if (value === undefined) {
    return defaultValue;
  }

  if (!Number.isInteger(value) || value < min || value > max) {
    return null;
  }

  return value;
}

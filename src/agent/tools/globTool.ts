import { readdir, realpath, stat } from "node:fs/promises";
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
import {
  compileGlobList,
  compileGlobPattern,
  matchAnyGlob,
  matchGlob,
  type GlobMatcher,
} from "./filesystem_shared/globMatcher.js";

const DEFAULT_EXCLUDES = ["**/node_modules/**", "**/.git/**", "**/dist/**"];

interface CreateGlobToolInput {
  workspaceRoot: string;
  restrictToWorkspace: boolean;
}

interface GlobMatchRecord {
  path: string;
  type: "file" | "dir";
}

interface GlobDetails extends FsToolBaseDetails {
  tool: "glob";
  root?: string;
  pattern?: string;
  returnedMatches?: number;
  totalMatchesObserved?: number;
  truncated?: boolean;
  filesVisited?: number;
  dirsVisited?: number;
  filesSkippedHidden?: number;
  dirsSkippedHidden?: number;
  matches?: GlobMatchRecord[];
}

interface GlobContext {
  patternMatcher: GlobMatcher;
  includeMatchers: GlobMatcher[];
  excludeMatchers: GlobMatcher[];
  includeFiles: boolean;
  includeDirectories: boolean;
  includeHidden: boolean;
  followSymlinks: boolean;
  maxResults: number;
}

interface GlobState {
  filesVisited: number;
  dirsVisited: number;
  filesSkippedHidden: number;
  dirsSkippedHidden: number;
  totalMatchesObserved: number;
  truncated: boolean;
  matches: GlobMatchRecord[];
}

export function createGlobTool(input: CreateGlobToolInput): DescribedAgentTool {
  const schema = Type.Object({
    pattern: Type.String({
      minLength: 1,
      description: "Glob pattern used to match paths relative to the search root.",
    }),
    path: Type.Optional(
      Type.String({
        minLength: 1,
        description: "Root directory to search. Relative paths resolve from workspace root.",
      })
    ),
    include: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), {
        description: "Optional include globs for candidate paths relative to the glob root.",
      })
    ),
    exclude: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), {
        description: "Optional exclude globs for candidate paths relative to the glob root.",
      })
    ),
    includeFiles: Type.Optional(
      Type.Boolean({
        description: "When true, include file path matches.",
      })
    ),
    includeDirectories: Type.Optional(
      Type.Boolean({
        description: "When true, include directory path matches.",
      })
    ),
    includeHidden: Type.Optional(
      Type.Boolean({
        description: "Include dot-prefixed files/directories when true.",
      })
    ),
    followSymlinks: Type.Optional(
      Type.Boolean({
        description: "When true, recurse into symlinked directories with cycle detection.",
      })
    ),
    maxResults: Type.Optional(
      Type.Number({
        minimum: 1,
        maximum: 5000,
        description: "Maximum number of matched paths to return.",
      })
    ),
  });

  const tool: DescribedAgentTool = {
    name: "glob",
    label: "Glob",
    description:
      "Use this tool to find files/directories by pathname pattern without shelling out. It performs bounded recursive traversal with glob matching, deterministic ordering, default excludes, and workspace-safe path handling.",
    toolRulePrompt:
      "Use `glob` for pathname pattern matching (for example `**/*.ts`, `src/**`, `*.md`) before falling back to `bash find` or `rg --files`.",
    parameters: schema,
    async execute(_toolCallId, params) {
      const rawPattern = params.pattern.trim();
      const includeFiles = params.includeFiles ?? true;
      const includeDirectories = params.includeDirectories ?? false;
      const includeHidden = params.includeHidden ?? false;
      const followSymlinks = params.followSymlinks ?? false;
      const maxResults = normalizeIntegerInRange(params.maxResults, 200, 1, 5000);

      if (!rawPattern) {
        return fail("Invalid `pattern`: expected a non-empty string.", {
          tool: "glob",
          ok: false,
          errorCode: "invalid_path",
        });
      }

      if (!includeFiles && !includeDirectories) {
        return fail("Invalid parameters: `includeFiles` and `includeDirectories` cannot both be false.", {
          tool: "glob",
          ok: false,
          errorCode: "invalid_path",
          pattern: rawPattern,
        });
      }

      if (maxResults === null) {
        return fail("Invalid `maxResults`: expected an integer in range [1, 5000].", {
          tool: "glob",
          ok: false,
          errorCode: "invalid_path",
          pattern: rawPattern,
        });
      }

      try {
        const patternMatcher = compileGlobPattern(rawPattern, "invalid_glob");
        const includeMatchers = compileGlobList(params.include, "invalid_glob");
        const excludeMatchers = compileGlobList(params.exclude ?? DEFAULT_EXCLUDES, "invalid_glob");

        const { resolvedPath } = await resolvePolicyPath({
          inputPath: params.path ?? ".",
          workspaceRoot: input.workspaceRoot,
          restrictToWorkspace: input.restrictToWorkspace,
        });

        await assertDirectoryPath(resolvedPath);

        const visitedCanonicalDirs = new Set<string>();
        try {
          visitedCanonicalDirs.add(await realpath(resolvedPath));
        } catch {
          visitedCanonicalDirs.add(resolvedPath);
        }

        const context: GlobContext = {
          patternMatcher,
          includeMatchers,
          excludeMatchers,
          includeFiles,
          includeDirectories,
          includeHidden,
          followSymlinks,
          maxResults,
        };

        const state: GlobState = {
          filesVisited: 0,
          dirsVisited: 0,
          filesSkippedHidden: 0,
          dirsSkippedHidden: 0,
          totalMatchesObserved: 0,
          truncated: false,
          matches: [],
        };

        await walkAndCollect(resolvedPath, resolvedPath, context, state, visitedCanonicalDirs);

        return textResult(formatGlobOutput(resolvedPath, context.patternMatcher.pattern, state), {
          tool: "glob",
          ok: true,
          root: resolvedPath,
          resolvedPath,
          pattern: context.patternMatcher.pattern,
          returnedMatches: state.matches.length,
          totalMatchesObserved: state.totalMatchesObserved,
          truncated: state.truncated,
          filesVisited: state.filesVisited,
          dirsVisited: state.dirsVisited,
          filesSkippedHidden: state.filesSkippedHidden,
          dirsSkippedHidden: state.dirsSkippedHidden,
          matches: state.matches,
        } satisfies GlobDetails);
      } catch (error) {
        if (error instanceof FsToolError) {
          return fail(error.message, {
            tool: "glob",
            ok: false,
            errorCode: error.code,
            pattern: rawPattern,
            resolvedPath: error.resolvedPath,
          });
        }

        const message = error instanceof Error ? error.message : "Unknown error.";
        return fail(`Glob failed: ${message}`, {
          tool: "glob",
          ok: false,
          errorCode: "io_error",
          pattern: rawPattern,
        });
      }
    },
  };

  return tool;
}

async function walkAndCollect(
  rootPath: string,
  currentDir: string,
  context: GlobContext,
  state: GlobState,
  visitedCanonicalDirs: Set<string>
): Promise<void> {
  if (state.truncated) {
    return;
  }

  let directoryEntries = await readdir(currentDir, { withFileTypes: true });
  directoryEntries = directoryEntries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of directoryEntries) {
    if (state.truncated) {
      return;
    }

    const absPath = join(currentDir, entry.name);
    const relPath = normalizeRelativePath(relative(rootPath, absPath));

    if (!context.includeHidden && entry.name.startsWith(".")) {
      if (entry.isDirectory()) {
        state.dirsSkippedHidden += 1;
      } else {
        state.filesSkippedHidden += 1;
      }
      continue;
    }

    if (entry.isDirectory()) {
      state.dirsVisited += 1;
      await visitDirectoryEntry(
        rootPath,
        absPath,
        relPath,
        context,
        state,
        visitedCanonicalDirs,
        false
      );
      continue;
    }

    if (entry.isFile()) {
      state.filesVisited += 1;
      maybeAddMatch(relPath, "file", false, context, state);
      continue;
    }

    if (entry.isSymbolicLink()) {
      await visitSymlinkEntry(
        rootPath,
        absPath,
        relPath,
        context,
        state,
        visitedCanonicalDirs
      );
    }
  }
}

async function visitDirectoryEntry(
  rootPath: string,
  absPath: string,
  relPath: string,
  context: GlobContext,
  state: GlobState,
  visitedCanonicalDirs: Set<string>,
  isSymlinkDirectory: boolean
): Promise<void> {
  if (shouldExcludePath(relPath, true, context)) {
    return;
  }

  maybeAddMatch(relPath, "dir", true, context, state);
  if (state.truncated) {
    return;
  }

  if (isSymlinkDirectory && !context.followSymlinks) {
    return;
  }

  if (isSymlinkDirectory && context.followSymlinks) {
    let canonicalDir: string;
    try {
      canonicalDir = await realpath(absPath);
    } catch {
      return;
    }

    if (visitedCanonicalDirs.has(canonicalDir)) {
      return;
    }
    visitedCanonicalDirs.add(canonicalDir);
  }

  await walkAndCollect(rootPath, absPath, context, state, visitedCanonicalDirs);
}

async function visitSymlinkEntry(
  rootPath: string,
  absPath: string,
  relPath: string,
  context: GlobContext,
  state: GlobState,
  visitedCanonicalDirs: Set<string>
): Promise<void> {
  let target;
  try {
    target = await stat(absPath);
  } catch {
    return;
  }

  if (target.isFile()) {
    state.filesVisited += 1;
    maybeAddMatch(relPath, "file", false, context, state);
    return;
  }

  if (target.isDirectory()) {
    state.dirsVisited += 1;
    await visitDirectoryEntry(
      rootPath,
      absPath,
      relPath,
      context,
      state,
      visitedCanonicalDirs,
      true
    );
  }
}

function maybeAddMatch(
  relPath: string,
  type: "file" | "dir",
  isDirectory: boolean,
  context: GlobContext,
  state: GlobState
): void {
  if (shouldExcludePath(relPath, isDirectory, context)) {
    return;
  }

  if (!shouldIncludePath(relPath, isDirectory, context)) {
    return;
  }

  if (!matchGlob(relPath, isDirectory, context.patternMatcher)) {
    return;
  }

  if (type === "file" && !context.includeFiles) {
    return;
  }

  if (type === "dir" && !context.includeDirectories) {
    return;
  }

  state.totalMatchesObserved += 1;

  if (state.matches.length >= context.maxResults) {
    state.truncated = true;
    return;
  }

  state.matches.push({
    path: relPath,
    type,
  });
}

function shouldIncludePath(relPath: string, isDirectory: boolean, context: GlobContext): boolean {
  if (context.includeMatchers.length === 0) {
    return true;
  }

  return matchAnyGlob(relPath, isDirectory, context.includeMatchers);
}

function shouldExcludePath(relPath: string, isDirectory: boolean, context: GlobContext): boolean {
  return matchAnyGlob(relPath, isDirectory, context.excludeMatchers);
}

function formatGlobOutput(rootPath: string, pattern: string, state: GlobState): string {
  const lines = [
    `Glob results: ${rootPath}`,
    `- pattern: ${pattern}`,
    `- returnedMatches: ${state.matches.length}`,
    `- totalMatchesObserved: ${state.totalMatchesObserved}`,
    `- truncated: ${state.truncated}`,
    `- filesVisited: ${state.filesVisited}`,
    `- dirsVisited: ${state.dirsVisited}`,
    "",
  ];

  if (state.matches.length === 0) {
    lines.push("(no matches)");
    return lines.join("\n");
  }

  for (const match of state.matches) {
    lines.push(match.path);
  }

  return lines.join("\n");
}

function fail(message: string, details: GlobDetails) {
  return textResult(`Glob failed: ${message}`, {
    ...details,
    message,
  });
}

function normalizeRelativePath(pathValue: string): string {
  return pathValue.split("\\").join("/");
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

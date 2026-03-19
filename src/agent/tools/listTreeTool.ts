import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";

import { Type } from "@mariozechner/pi-ai";

import type { DescribedAgentTool } from "./registry/types.js";
import { textResult } from "./showcase/shared.js";
import {
  FsToolError,
  assertDirectoryPath,
  renderTree,
  resolvePolicyPath,
  type FsToolBaseDetails,
  type TreeEntry,
} from "./filesystem_shared/core.js";

interface CreateListTreeToolInput {
  workspaceRoot: string;
  restrictToWorkspace: boolean;
}

type SortBy = "name" | "mtime" | "size";

interface ListTreeDetails extends FsToolBaseDetails {
  tool: "list_tree";
  root?: string;
  totalEntries?: number;
  returnedEntries?: number;
  truncated?: boolean;
  maxDepth?: number;
  maxEntries?: number;
  entries?: TreeEntry[];
}

export function createListTreeTool(input: CreateListTreeToolInput): DescribedAgentTool {
  const schema = Type.Object({
    path: Type.String({
      minLength: 1,
      description: "Root directory path to traverse. Relative paths resolve from workspace root.",
    }),
    maxDepth: Type.Optional(
      Type.Number({
        minimum: 0,
        maximum: 8,
        description: "Traversal depth limit from root (0 means root only).",
      })
    ),
    maxEntries: Type.Optional(
      Type.Number({
        minimum: 1,
        maximum: 2000,
        description: "Maximum number of entries returned in the result set.",
      })
    ),
    includeHidden: Type.Optional(
      Type.Boolean({
        description: "Include dot-prefixed files/directories when true.",
      })
    ),
    sortBy: Type.Optional(
      Type.Union([Type.Literal("name"), Type.Literal("mtime"), Type.Literal("size")], {
        description: "Sort key for sibling entries.",
      })
    ),
  });

  const tool: DescribedAgentTool = {
    name: "list_tree",
    label: "List Tree",
    description:
      "Use this tool to explore folder structure before reading, writing, or editing files. It returns a bounded directory tree with controls for depth, entry count, hidden files, and sorting. Output includes a readable tree plus structured metadata (entry list, counts, truncation status, and limits used).",
    parameters: schema,
    async execute(_toolCallId, params) {
      const maxDepth = normalizeIntegerInRange(params.maxDepth, 3, 0, 8);
      const maxEntries = normalizeIntegerInRange(params.maxEntries, 500, 1, 2000);

      if (maxDepth === null || maxEntries === null) {
        return fail("Invalid `maxDepth` or `maxEntries`.", {
          tool: "list_tree",
          ok: false,
          errorCode: "invalid_path",
        });
      }

      const includeHidden = params.includeHidden ?? false;
      const sortBy: SortBy = params.sortBy ?? "name";

      try {
        const { resolvedPath } = await resolvePolicyPath({
          inputPath: params.path,
          workspaceRoot: input.workspaceRoot,
          restrictToWorkspace: input.restrictToWorkspace,
        });

        await assertDirectoryPath(resolvedPath);

        const rootLabel = ".";
        const entries: TreeEntry[] = [];
        let totalEntries = 0;
        let truncated = false;

        const queue: Array<{ dirPath: string; depth: number }> = [{ dirPath: resolvedPath, depth: 0 }];

        while (queue.length > 0) {
          const current = queue.shift();
          if (!current) {
            continue;
          }

          if (current.depth >= maxDepth) {
            continue;
          }

          let directoryEntries = await readdir(current.dirPath, { withFileTypes: true });

          if (!includeHidden) {
            directoryEntries = directoryEntries.filter((entry) => !entry.name.startsWith("."));
          }

          const enriched = await Promise.all(
            directoryEntries.map(async (entry) => {
              const absPath = join(current.dirPath, entry.name);
              const stats = await stat(absPath);
              return {
                dirent: entry,
                absPath,
                size: stats.size,
                mtimeMs: stats.mtimeMs,
              };
            })
          );

          enriched.sort((a, b) => compareEntries(a, b, sortBy));

          for (const entry of enriched) {
            totalEntries += 1;
            if (entries.length >= maxEntries) {
              truncated = true;
              continue;
            }

            const relPath = relative(resolvedPath, entry.absPath);
            const itemDepth = current.depth + 1;
            const treeEntry: TreeEntry = {
              path: relPath.length > 0 ? relPath : rootLabel,
              type: entry.dirent.isDirectory() ? "dir" : "file",
              depth: itemDepth,
              size: entry.dirent.isDirectory() ? undefined : entry.size,
              mtimeMs: entry.mtimeMs,
            };

            entries.push(treeEntry);

            if (entry.dirent.isDirectory() && itemDepth < maxDepth) {
              queue.push({ dirPath: entry.absPath, depth: itemDepth });
            }
          }
        }

        const content = [
          `Directory tree: ${resolvedPath}`,
          `- maxDepth: ${maxDepth}`,
          `- maxEntries: ${maxEntries}`,
          `- totalEntries: ${totalEntries}`,
          `- returnedEntries: ${entries.length}`,
          `- truncated: ${truncated}`,
          "",
          renderTree(entries),
        ].join("\n");

        return textResult(content, {
          tool: "list_tree",
          ok: true,
          root: resolvedPath,
          resolvedPath,
          totalEntries,
          returnedEntries: entries.length,
          truncated,
          maxDepth,
          maxEntries,
          entries,
        } satisfies ListTreeDetails);
      } catch (error) {
        if (error instanceof FsToolError) {
          return fail(error.message, {
            tool: "list_tree",
            ok: false,
            errorCode: error.code,
            resolvedPath: error.resolvedPath,
          });
        }

        const message = error instanceof Error ? error.message : "Unknown error.";
        return fail(`List tree failed: ${message}`, {
          tool: "list_tree",
          ok: false,
          errorCode: "io_error",
        });
      }
    },
  };

  return tool;
}

function fail(message: string, details: ListTreeDetails) {
  return textResult(`List tree failed: ${message}`, {
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

function compareEntries(
  a: { dirent: { name: string }; size: number; mtimeMs: number },
  b: { dirent: { name: string }; size: number; mtimeMs: number },
  sortBy: SortBy
): number {
  if (sortBy === "mtime") {
    if (b.mtimeMs !== a.mtimeMs) {
      return b.mtimeMs - a.mtimeMs;
    }
  }

  if (sortBy === "size") {
    if (b.size !== a.size) {
      return b.size - a.size;
    }
  }

  return a.dirent.name.localeCompare(b.dirent.name);
}

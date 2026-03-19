import { Type } from "@mariozechner/pi-ai";

import type { DescribedAgentTool } from "./registry/types.js";
import { textResult } from "./showcase/shared.js";
import {
  FsToolError,
  assertFilePath,
  buildBestMatchDiff,
  fileSha256,
  readUtf8Text,
  resolvePolicyPath,
  type FsToolBaseDetails,
  writeTextAtomic,
} from "./filesystem_shared/core.js";

interface CreateEditFileToolInput {
  workspaceRoot: string;
  restrictToWorkspace: boolean;
}

interface EditFileDetails extends FsToolBaseDetails {
  tool: "edit_file";
  matches?: number;
  applied?: boolean;
  dryRun?: boolean;
  occurrenceUsed?: number | null;
  previewDiff?: string;
  sha256Before?: string;
  sha256After?: string;
}

export function createEditFileTool(input: CreateEditFileToolInput): DescribedAgentTool {
  const schema = Type.Object({
    path: Type.String({
      minLength: 1,
      description: "Target file path. Relative paths resolve from workspace root.",
    }),
    oldText: Type.String({
      minLength: 1,
      description: "Exact text segment to replace.",
    }),
    newText: Type.String({
      description: "Replacement text for the selected match.",
    }),
    occurrence: Type.Optional(
      Type.Number({
        minimum: 1,
        description: "1-based match index to replace when multiple matches exist.",
      })
    ),
    dryRun: Type.Optional(
      Type.Boolean({
        description: "If true, return preview only and do not write to disk.",
      })
    ),
    expectedSha256: Type.Optional(
      Type.String({
        minLength: 64,
        maxLength: 64,
        description: "Precondition hash of current file content (64-char lowercase hex).",
      })
    ),
  });

  const tool: DescribedAgentTool = {
    name: "edit_file",
    label: "Edit File",
    description:
      "Use this tool when you need a precise in-file text replacement (oldText -> newText) rather than rewriting the whole file. It supports ambiguity control with `occurrence`, safe previews with `dryRun`, and optional hash preconditions. Output includes whether an edit was applied, how many matches were found, which occurrence was used, and a diff-style preview.",
    parameters: schema,
    async execute(_toolCallId, params) {
      const dryRun = params.dryRun ?? false;
      const occurrence = normalizeOccurrence(params.occurrence);

      if (occurrence === null) {
        return fail("Invalid `occurrence`: expected integer >= 1.", {
          tool: "edit_file",
          ok: false,
          errorCode: "invalid_occurrence",
          dryRun,
        });
      }

      if (!isValidSha(params.expectedSha256)) {
        return fail("Invalid `expectedSha256`: expected lowercase 64-hex digest.", {
          tool: "edit_file",
          ok: false,
          errorCode: "precondition_failed",
          dryRun,
        });
      }

      try {
        const { resolvedPath } = await resolvePolicyPath({
          inputPath: params.path,
          workspaceRoot: input.workspaceRoot,
          restrictToWorkspace: input.restrictToWorkspace,
        });

        await assertFilePath(resolvedPath);

        const content = await readUtf8Text(resolvedPath);
        const sha256Before = await fileSha256(resolvedPath);

        if (params.expectedSha256 && sha256Before !== params.expectedSha256) {
          return fail("Hash precondition failed: file content has changed.", {
            tool: "edit_file",
            ok: false,
            errorCode: "precondition_failed",
            resolvedPath,
            dryRun,
            sha256Before: sha256Before ?? undefined,
          });
        }

        const matchIndexes = findAllMatchIndexes(content, params.oldText);
        if (matchIndexes.length === 0) {
          const previewDiff = buildBestMatchDiff(params.oldText, content, resolvedPath) ?? undefined;
          const baseMessage = previewDiff
            ? `oldText not found. Best match preview:\n${previewDiff}`
            : "oldText not found and no close match was detected.";

          return fail(baseMessage, {
            tool: "edit_file",
            ok: false,
            errorCode: "not_found",
            resolvedPath,
            dryRun,
            matches: 0,
            previewDiff,
            sha256Before: sha256Before ?? undefined,
          });
        }

        if (matchIndexes.length > 1 && occurrence === undefined) {
          return fail(
            `oldText matches ${matchIndexes.length} locations. Provide a unique snippet or set occurrence.`,
            {
              tool: "edit_file",
              ok: false,
              errorCode: "ambiguous_match",
              resolvedPath,
              dryRun,
              matches: matchIndexes.length,
              sha256Before: sha256Before ?? undefined,
            }
          );
        }

        const occurrenceUsed = occurrence ?? 1;
        if (occurrenceUsed > matchIndexes.length) {
          return fail(`occurrence ${occurrenceUsed} is out of range; only ${matchIndexes.length} matches found.`, {
            tool: "edit_file",
            ok: false,
            errorCode: "invalid_occurrence",
            resolvedPath,
            dryRun,
            matches: matchIndexes.length,
            sha256Before: sha256Before ?? undefined,
          });
        }

        const targetIndex = matchIndexes[occurrenceUsed - 1];
        const updatedContent =
          content.slice(0, targetIndex) + params.newText + content.slice(targetIndex + params.oldText.length);

        const previewDiff = [
          "--- old_text",
          "+++ new_text",
          ...params.oldText.split("\n").map((line: string) => `-${line}`),
          ...params.newText.split("\n").map((line: string) => `+${line}`),
        ].join("\n");

        if (dryRun) {
          return textResult(
            [
              `Edit preview: ${resolvedPath}`,
              `- matches: ${matchIndexes.length}`,
              `- occurrenceUsed: ${occurrenceUsed}`,
              `- applied: false (dryRun=true)`,
              "",
              previewDiff,
            ].join("\n"),
            {
              tool: "edit_file",
              ok: true,
              resolvedPath,
              matches: matchIndexes.length,
              applied: false,
              dryRun: true,
              occurrenceUsed,
              previewDiff,
              sha256Before: sha256Before ?? undefined,
            } satisfies EditFileDetails
          );
        }

        await writeTextAtomic(resolvedPath, updatedContent);
        const sha256After = await fileSha256(resolvedPath);

        return textResult(
          [
            `Edit successful: ${resolvedPath}`,
            `- matches: ${matchIndexes.length}`,
            `- occurrenceUsed: ${occurrenceUsed}`,
            "",
            previewDiff,
          ].join("\n"),
          {
            tool: "edit_file",
            ok: true,
            resolvedPath,
            matches: matchIndexes.length,
            applied: true,
            dryRun: false,
            occurrenceUsed,
            previewDiff,
            sha256Before: sha256Before ?? undefined,
            sha256After: sha256After ?? undefined,
          } satisfies EditFileDetails
        );
      } catch (error) {
        if (error instanceof FsToolError) {
          return fail(error.message, {
            tool: "edit_file",
            ok: false,
            errorCode: error.code,
            resolvedPath: error.resolvedPath,
            dryRun,
          });
        }

        const message = error instanceof Error ? error.message : "Unknown error.";
        return fail(`Edit file failed: ${message}`, {
          tool: "edit_file",
          ok: false,
          errorCode: "io_error",
          dryRun,
        });
      }
    },
  };

  return tool;
}

function fail(message: string, details: EditFileDetails) {
  return textResult(`Edit file failed: ${message}`, {
    ...details,
    message,
  });
}

function normalizeOccurrence(value: number | undefined): number | undefined | null {
  if (value === undefined) {
    return undefined;
  }

  if (!Number.isInteger(value) || value < 1) {
    return null;
  }

  return value;
}

function findAllMatchIndexes(content: string, target: string): number[] {
  if (target.length === 0) {
    return [];
  }

  const indexes: number[] = [];
  let from = 0;

  while (from <= content.length) {
    const index = content.indexOf(target, from);
    if (index < 0) {
      break;
    }

    indexes.push(index);
    from = index + 1;
  }

  return indexes;
}

function isValidSha(value: string | undefined): boolean {
  if (value === undefined) {
    return true;
  }

  return /^[a-f0-9]{64}$/.test(value);
}

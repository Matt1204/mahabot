import { mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";

import { Type } from "@mariozechner/pi-ai";

import type { DescribedAgentTool } from "./registry/types.js";
import { textResult } from "./showcase/shared.js";
import {
  FsToolError,
  appendUtf8Text,
  fileSha256,
  resolvePolicyPath,
  sha256Of,
  type FsToolBaseDetails,
  writeTextAtomic,
} from "./filesystem_shared/core.js";

interface CreateWriteFileToolInput {
  workspaceRoot: string;
  restrictToWorkspace: boolean;
}

type WriteMode = "overwrite" | "create" | "append";

interface WriteFileDetails extends FsToolBaseDetails {
  tool: "write_file";
  mode?: WriteMode;
  bytesWritten?: number;
  fileSize?: number;
  sha256?: string;
  created?: boolean;
}

export function createWriteFileTool(input: CreateWriteFileToolInput): DescribedAgentTool {
  const schema = Type.Object({
    path: Type.String({
      minLength: 1,
      description: "Target file path. Relative paths resolve from workspace root.",
    }),
    content: Type.String({
      description: "UTF-8 text payload to write.",
    }),
    mode: Type.Optional(
      Type.Union([Type.Literal("overwrite"), Type.Literal("create"), Type.Literal("append")], {
        description:
          "Write strategy: overwrite existing, create only if absent, or append to end of file.",
      })
    ),
    ensureParent: Type.Optional(
      Type.Boolean({
        description: "Create parent directories if missing.",
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
    name: "write_file",
    label: "Write File",
    description:
      "Use this tool when you need to create or modify text files. It supports `overwrite`, `create`, and `append` modes, optional parent-directory creation, and optimistic concurrency via `expectedSha256`. Output reports what happened (created or updated), bytes written, resulting file size, and resulting sha256 hash.",
    parameters: schema,
    async execute(_toolCallId, params) {
      const mode: WriteMode = params.mode ?? "overwrite";
      const ensureParent = params.ensureParent ?? true;

      if (!isValidSha(params.expectedSha256)) {
        return fail("Invalid `expectedSha256`: expected lowercase 64-hex digest.", {
          tool: "write_file",
          ok: false,
          errorCode: "precondition_failed",
          mode,
        });
      }

      try {
        const { resolvedPath } = await resolvePolicyPath({
          inputPath: params.path,
          workspaceRoot: input.workspaceRoot,
          restrictToWorkspace: input.restrictToWorkspace,
        });

        await ensureParentDirectory(resolvedPath, ensureParent);

        const existingInfo = await getExistingEntryInfo(resolvedPath);
        if (existingInfo.exists && existingInfo.type !== "file") {
          return fail(`Target exists but is not a file: ${resolvedPath}`, {
            tool: "write_file",
            ok: false,
            errorCode: "not_file",
            resolvedPath,
            mode,
          });
        }

        if (mode === "create" && existingInfo.exists) {
          return fail(`File already exists: ${resolvedPath}`, {
            tool: "write_file",
            ok: false,
            errorCode: "already_exists",
            resolvedPath,
            mode,
          });
        }

        if (params.expectedSha256) {
          const currentHash = await fileSha256(resolvedPath);
          if (currentHash === null || currentHash !== params.expectedSha256) {
            return fail("Hash precondition failed: file content has changed or does not exist.", {
              tool: "write_file",
              ok: false,
              errorCode: "precondition_failed",
              resolvedPath,
              mode,
            });
          }
        }

        if (mode === "append") {
          await appendUtf8Text(resolvedPath, params.content);
        } else {
          await writeTextAtomic(resolvedPath, params.content);
        }

        const afterStat = await stat(resolvedPath);
        const afterHash = await fileSha256(resolvedPath);

        return textResult(
          [
            `Write successful: ${resolvedPath}`,
            `- mode: ${mode}`,
            `- bytesWritten: ${Buffer.byteLength(params.content, "utf-8")}`,
            `- fileSize: ${afterStat.size}`,
            `- created: ${!existingInfo.exists}`,
          ].join("\n"),
          {
            tool: "write_file",
            ok: true,
            resolvedPath,
            mode,
            bytesWritten: Buffer.byteLength(params.content, "utf-8"),
            fileSize: afterStat.size,
            sha256: afterHash ?? sha256Of(params.content),
            created: !existingInfo.exists,
          } satisfies WriteFileDetails
        );
      } catch (error) {
        if (error instanceof FsToolError) {
          return fail(error.message, {
            tool: "write_file",
            ok: false,
            errorCode: error.code,
            resolvedPath: error.resolvedPath,
            mode,
          });
        }

        const message = error instanceof Error ? error.message : "Unknown error.";
        return fail(`Write file failed: ${message}`, {
          tool: "write_file",
          ok: false,
          errorCode: "io_error",
          mode,
        });
      }
    },
  };

  return tool;
}

function fail(message: string, details: WriteFileDetails) {
  return textResult(`Write file failed: ${message}`, {
    ...details,
    message,
  });
}

function isValidSha(value: string | undefined): boolean {
  if (value === undefined) {
    return true;
  }

  return /^[a-f0-9]{64}$/.test(value);
}

async function ensureParentDirectory(pathValue: string, ensureParent: boolean): Promise<void> {
  const parent = dirname(pathValue);
  if (ensureParent) {
    await mkdir(parent, { recursive: true });
    return;
  }

  try {
    const parentStat = await stat(parent);
    if (!parentStat.isDirectory()) {
      throw new FsToolError("parent_not_found", `Parent path is not a directory: ${parent}`, parent);
    }
  } catch {
    throw new FsToolError("parent_not_found", `Parent directory not found: ${parent}`, parent);
  }
}

async function getExistingEntryInfo(pathValue: string): Promise<
  | { exists: false }
  | {
      exists: true;
      type: "file" | "dir" | "other";
    }
> {
  try {
    const entry = await stat(pathValue);
    if (entry.isFile()) {
      return { exists: true, type: "file" };
    }

    if (entry.isDirectory()) {
      return { exists: true, type: "dir" };
    }

    return { exists: true, type: "other" };
  } catch {
    return { exists: false };
  }
}

import { Type } from "@mariozechner/pi-ai";

import type { DescribedAgentTool } from "./registry/types.js";
import { textResult } from "./showcase/shared.js";
import {
  FsToolError,
  assertFilePath,
  readUtf8Slice,
  resolvePolicyPath,
  type FsToolBaseDetails,
} from "./filesystem_shared/core.js";

const DEFAULT_MAX_BYTES = 8 * 1024;

interface CreateReadFileToolInput {
  workspaceRoot: string;
  restrictToWorkspace: boolean;
}

interface ReadFileDetails extends FsToolBaseDetails {
  tool: "read_file";
  bytesRead?: number;
  fileSize?: number;
  offset?: number;
  nextOffset?: number | null;
  truncated?: boolean;
  encoding?: "utf-8";
}

export function createReadFileTool(input: CreateReadFileToolInput): DescribedAgentTool {
  const schema = Type.Object({
    path: Type.String({
      minLength: 1,
      description: "Target file path. Relative paths resolve from workspace root.",
    }),
    offset: Type.Optional(
      Type.Number({
        minimum: 0,
        description: "Byte offset to start reading from. Use for paginated reads.",
      })
    ),
    maxBytes: Type.Optional(
      Type.Number({
        minimum: 256,
        maximum: 65536,
        description: "Max bytes to read in this call.",
      })
    ),
  });

  const tool: DescribedAgentTool = {
    name: "read_file",
    label: "Read File",
    description:
      "Use this tool when you need to inspect the contents of a text file. It reads UTF-8 text safely with optional pagination (`offset`, `maxBytes`) so large files can be read in chunks. Output includes the text plus metadata such as bytes read, total file size, truncation status, and nextOffset for follow-up reads.",
    parameters: schema,
    async execute(_toolCallId, params) {
      const offset = normalizeNonNegativeInteger(params.offset, 0);
      const maxBytes = normalizeNonNegativeInteger(params.maxBytes, DEFAULT_MAX_BYTES);

      if (offset === null) {
        return fail("Invalid `offset`: expected a non-negative integer.", {
          tool: "read_file",
          ok: false,
          errorCode: "invalid_offset",
        });
      }

      if (maxBytes === null || maxBytes < 256 || maxBytes > 65536) {
        return fail("Invalid `maxBytes`: expected an integer in [256, 65536].", {
          tool: "read_file",
          ok: false,
          errorCode: "invalid_offset",
        });
      }

      try {
        const { resolvedPath } = await resolvePolicyPath({
          inputPath: params.path,
          workspaceRoot: input.workspaceRoot,
          restrictToWorkspace: input.restrictToWorkspace,
        });

        await assertFilePath(resolvedPath);

        const slice = await readUtf8Slice(resolvedPath, offset, maxBytes);

        const header = [
          `Read file: ${resolvedPath}`,
          `- offset: ${offset}`,
          `- bytesRead: ${slice.bytesRead}`,
          `- fileSize: ${slice.fileSize}`,
          `- truncated: ${slice.truncated}`,
          `- nextOffset: ${slice.nextOffset ?? "null"}`,
          "",
          "content:",
        ].join("\n");

        return textResult(`${header}\n${slice.text}`, {
          tool: "read_file",
          ok: true,
          resolvedPath,
          bytesRead: slice.bytesRead,
          fileSize: slice.fileSize,
          offset,
          nextOffset: slice.nextOffset,
          truncated: slice.truncated,
          encoding: "utf-8",
        } satisfies ReadFileDetails);
      } catch (error) {
        if (error instanceof FsToolError) {
          return fail(error.message, {
            tool: "read_file",
            ok: false,
            errorCode: error.code,
            resolvedPath: error.resolvedPath,
          });
        }

        const message = error instanceof Error ? error.message : "Unknown error.";
        return fail(`Read file failed: ${message}`, {
          tool: "read_file",
          ok: false,
          errorCode: "io_error",
        });
      }
    },
  };

  return tool;
}

function fail(message: string, details: ReadFileDetails) {
  return textResult(`Read file failed: ${message}`, {
    ...details,
    message,
  });
}

function normalizeNonNegativeInteger(value: number | undefined, defaultValue: number): number | null {
  if (value === undefined) {
    return defaultValue;
  }

  if (!Number.isInteger(value) || value < 0) {
    return null;
  }

  return value;
}

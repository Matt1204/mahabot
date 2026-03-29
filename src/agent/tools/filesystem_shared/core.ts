import { createHash } from "node:crypto";
import { access, appendFile, open, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { TextDecoder } from "node:util";

export type FsToolName = "read_file" | "write_file" | "edit_file" | "list_tree" | "grep" | "glob";

export type FsErrorCode =
  | "invalid_path"
  | "outside_workspace"
  | "not_found"
  | "not_file"
  | "not_directory"
  | "invalid_regex"
  | "invalid_glob"
  | "encoding_error"
  | "invalid_offset"
  | "invalid_max_bytes"
  | "invalid_occurrence"
  | "ambiguous_match"
  | "precondition_failed"
  | "already_exists"
  | "parent_not_found"
  | "io_error";

export interface FsToolBaseDetails {
  tool: FsToolName;
  ok: boolean;
  errorCode?: FsErrorCode;
  message?: string;
  resolvedPath?: string;
}

export interface TreeEntry {
  path: string;
  type: "file" | "dir";
  depth: number;
  size?: number;
  mtimeMs?: number;
}

export class FsToolError extends Error {
  readonly code: FsErrorCode;
  readonly resolvedPath?: string;

  constructor(code: FsErrorCode, message: string, resolvedPath?: string) {
    super(message);
    this.code = code;
    this.resolvedPath = resolvedPath;
  }
}

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export interface ResolvePolicyPathInput {
  inputPath: string;
  workspaceRoot: string;
  restrictToWorkspace: boolean;
  baseDir?: string;
  additionalAllowedRoots?: string[];
}

export async function resolvePolicyPath(input: ResolvePolicyPathInput): Promise<{ resolvedPath: string }> {
  const cleanedInput = input.inputPath.trim();
  if (!cleanedInput || cleanedInput.includes("\0") || cleanedInput.length > 4096) {
    throw new FsToolError("invalid_path", "Path is empty or invalid.");
  }

  const workspaceRootCanonical = await toPolicyPath(resolve(input.workspaceRoot));
  const baseDir = input.baseDir?.trim() ? input.baseDir : workspaceRootCanonical;
  const absolutePath = isAbsolute(cleanedInput) ? resolve(cleanedInput) : resolve(baseDir, cleanedInput);
  const resolvedPath = await toPolicyPathWithExistingAncestor(absolutePath);

  if (input.restrictToWorkspace && !(await isAllowedPath(workspaceRootCanonical, resolvedPath, input.additionalAllowedRoots))) {
    throw new FsToolError(
      "outside_workspace",
      `Path is outside workspace: ${cleanedInput}`,
      resolvedPath
    );
  }

  return { resolvedPath };
}

async function isAllowedPath(
  workspaceRootCanonical: string,
  resolvedPath: string,
  additionalAllowedRoots: string[] | undefined
): Promise<boolean> {
  if (isWithin(workspaceRootCanonical, resolvedPath)) {
    return true;
  }

  if (!additionalAllowedRoots || additionalAllowedRoots.length === 0) {
    return false;
  }

  for (const root of additionalAllowedRoots) {
    const normalizedRoot = root.trim();
    if (!normalizedRoot) {
      continue;
    }

    const canonicalRoot = await toPolicyPath(resolve(normalizedRoot));
    if (isWithin(canonicalRoot, resolvedPath)) {
      return true;
    }
  }

  return false;
}

export async function assertFilePath(pathValue: string): Promise<void> {
  let entry;
  try {
    entry = await stat(pathValue);
  } catch {
    throw new FsToolError("not_found", `File not found: ${pathValue}`, pathValue);
  }

  if (!entry.isFile()) {
    throw new FsToolError("not_file", `Not a file: ${pathValue}`, pathValue);
  }
}

export async function assertDirectoryPath(pathValue: string): Promise<void> {
  let entry;
  try {
    entry = await stat(pathValue);
  } catch {
    throw new FsToolError("not_found", `Directory not found: ${pathValue}`, pathValue);
  }

  if (!entry.isDirectory()) {
    throw new FsToolError("not_directory", `Not a directory: ${pathValue}`, pathValue);
  }
}

export async function readUtf8Slice(pathValue: string, offset: number, maxBytes: number): Promise<{
  text: string;
  bytesRead: number;
  fileSize: number;
  truncated: boolean;
  nextOffset: number | null;
}> {
  const fileInfo = await stat(pathValue);
  const fileSize = fileInfo.size;

  if (offset > fileSize) {
    throw new FsToolError("invalid_offset", `Offset ${offset} exceeds file size ${fileSize}.`, pathValue);
  }

  const fileHandle = await open(pathValue, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await fileHandle.read(buffer, 0, maxBytes, offset);
    const bytes = buffer.subarray(0, bytesRead);

    let text: string;
    try {
      text = UTF8_DECODER.decode(bytes);
    } catch {
      throw new FsToolError("encoding_error", "File is not valid UTF-8 text.", pathValue);
    }

    const nextOffset = offset + bytesRead;
    const truncated = nextOffset < fileSize;

    return {
      text,
      bytesRead,
      fileSize,
      truncated,
      nextOffset: truncated ? nextOffset : null,
    };
  } finally {
    await fileHandle.close();
  }
}

export async function readUtf8Text(pathValue: string): Promise<string> {
  const bytes = await readFile(pathValue);
  try {
    return UTF8_DECODER.decode(bytes);
  } catch {
    throw new FsToolError("encoding_error", "File is not valid UTF-8 text.", pathValue);
  }
}

export async function fileSha256(pathValue: string): Promise<string | null> {
  try {
    const bytes = await readFile(pathValue);
    return sha256Of(bytes);
  } catch {
    return null;
  }
}

export async function writeTextAtomic(pathValue: string, content: string): Promise<void> {
  const parentDir = dirname(pathValue);
  const tempName = `.${basename(pathValue)}.mahabot-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`;
  const tempPath = join(parentDir, tempName);

  await writeFile(tempPath, content, { encoding: "utf-8" });
  await rename(tempPath, pathValue);
}

export async function appendUtf8Text(pathValue: string, content: string): Promise<void> {
  await appendFile(pathValue, content, { encoding: "utf-8" });
}

export function sha256Of(content: string | Uint8Array): string {
  const hash = createHash("sha256");
  hash.update(content);
  return hash.digest("hex");
}

export function renderTree(entries: TreeEntry[]): string {
  if (entries.length === 0) {
    return "(empty)";
  }

  return entries
    .map((entry) => {
      const indent = "  ".repeat(entry.depth);
      const suffix = entry.type === "dir" ? "/" : "";
      return `${indent}${entry.path}${suffix}`;
    })
    .join("\n");
}

export function buildBestMatchDiff(oldText: string, content: string, pathLabel: string): string | null {
  const oldLines = splitLinesWithNewline(oldText);
  const contentLines = splitLinesWithNewline(content);
  const windowSize = Math.max(1, oldLines.length);

  let bestScore = 0;
  let bestStart = 0;

  const maxStart = Math.max(0, contentLines.length - windowSize);
  for (let index = 0; index <= maxStart; index += 1) {
    const candidateWindow = contentLines.slice(index, index + windowSize);
    const score = lineSimilarity(oldLines, candidateWindow);
    if (score > bestScore) {
      bestScore = score;
      bestStart = index;
    }
  }

  if (bestScore <= 0.5) {
    return null;
  }

  const candidateWindow = contentLines.slice(bestStart, bestStart + windowSize);
  const diffLines = [
    "--- old_text (provided)",
    `+++ ${pathLabel} (actual, line ${bestStart + 1})`,
    ...buildLineDiff(oldLines, candidateWindow),
  ];

  return diffLines.join("\n");
}

function buildLineDiff(expected: string[], actual: string[]): string[] {
  const maxLength = Math.max(expected.length, actual.length);
  const lines: string[] = [];

  for (let index = 0; index < maxLength; index += 1) {
    const expectedLine = expected[index];
    const actualLine = actual[index];

    if (expectedLine === actualLine && expectedLine !== undefined) {
      lines.push(` ${stripTrailingNewline(expectedLine)}`);
      continue;
    }

    if (expectedLine !== undefined) {
      lines.push(`-${stripTrailingNewline(expectedLine)}`);
    }

    if (actualLine !== undefined) {
      lines.push(`+${stripTrailingNewline(actualLine)}`);
    }
  }

  return lines;
}

function splitLinesWithNewline(text: string): string[] {
  const matches = text.match(/.*(?:\r\n|\n|\r|$)/g);
  if (!matches) {
    return [];
  }

  return matches.filter((line) => line.length > 0);
}

function stripTrailingNewline(value: string): string {
  return value.replace(/[\r\n]+$/g, "");
}

function lineSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) {
    return 1;
  }

  const lcsLength = longestCommonSubsequence(a, b);
  return (2 * lcsLength) / (a.length + b.length);
}

function longestCommonSubsequence(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) {
    return 0;
  }

  const prev = new Array<number>(b.length + 1).fill(0);
  const curr = new Array<number>(b.length + 1).fill(0);

  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      if (a[i - 1] === b[j - 1]) {
        curr[j] = prev[j - 1] + 1;
      } else {
        curr[j] = Math.max(prev[j], curr[j - 1]);
      }
    }

    for (let j = 0; j <= b.length; j += 1) {
      prev[j] = curr[j];
      curr[j] = 0;
    }
  }

  return prev[b.length];
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function toPolicyPath(pathValue: string): Promise<string> {
  const absolutePath = resolve(pathValue);
  try {
    return await realpath(absolutePath);
  } catch {
    return absolutePath;
  }
}

async function toPolicyPathWithExistingAncestor(pathValue: string): Promise<string> {
  const absolutePath = resolve(pathValue);

  try {
    return await realpath(absolutePath);
  } catch {
    // Fall through to existing-ancestor canonicalization.
  }

  const { existingAncestor, relativeTail } = await findNearestExistingAncestor(absolutePath);
  const ancestorCanonical = await toPolicyPath(existingAncestor);

  return resolve(ancestorCanonical, relativeTail);
}

async function findNearestExistingAncestor(pathValue: string): Promise<{
  existingAncestor: string;
  relativeTail: string;
}> {
  const absolutePath = resolve(pathValue);
  let cursor = absolutePath;

  while (true) {
    if (await pathExists(cursor)) {
      break;
    }

    const parent = dirname(cursor);
    if (parent === cursor) {
      break;
    }

    cursor = parent;
  }

  return {
    existingAncestor: cursor,
    relativeTail: relative(cursor, absolutePath),
  };
}

async function pathExists(pathValue: string): Promise<boolean> {
  try {
    await access(pathValue);
    return true;
  } catch {
    return false;
  }
}

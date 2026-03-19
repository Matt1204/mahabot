import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

import { Type } from "@mariozechner/pi-ai";

import type { DescribedAgentTool } from "./registry/types.js";
import { textResult } from "./showcase/shared.js";

const BASH_TIMEOUT_MS = 60_000;
const STDOUT_MAX_BYTES = 8 * 1024;
const STDERR_MAX_BYTES = 8 * 1024;
const STDOUT_TAIL_BYTES = 32 * 1024;

// Policy layer 1: always-block destructive system commands.
const GENERAL_COMMAND_BLACKLIST: RegExp[] = [
  /\brm\s+-rf\b/i,
  /\bmkfs(\.|\s|$)/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bhalt\b/i,
  /\bpoweroff\b/i,
  /:\(\)\s*\{\s*:\|:&\s*\};:/,
];

// Policy layer 2: always-block destructive git operations.
const GIT_DESTRUCTIVE_BLACKLIST: RegExp[] = [
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-fd\b/i,
  /\bgit\s+clean\s+-f\s+-d\b/i,
];

// Policy layer 3 (workspace-restricted mode): reject command shapes that are
// hard to statically verify as workspace-safe.
const HIGH_RISK_UNVERIFIABLE_PATTERNS: RegExp[] = [
  /\bcurl\b[\s\S]*\|\s*(sh|bash|zsh)\b/i,
  /\bwget\b[\s\S]*\|\s*(sh|bash|zsh)\b/i,
  /\bsudo\b/i,
  /\b(bash|sh|zsh)\s+-c\b/i,
  /`[^`]+`/,
  /\$\(/,
];

interface CreateBashToolInput {
  workspaceRoot: string;
  restrictToWorkspace: boolean;
}

interface BashToolResult {
  toolDescription: string;
  command: string;
  normalizedCommand: string;
  effectiveWorkingDir: string;
  nextWorkingDir: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  blockedReason?: string;
}

export function createBashTool(input: CreateBashToolInput): DescribedAgentTool {
  const workspaceRoot = resolve(input.workspaceRoot);
  const restrictToWorkspace = input.restrictToWorkspace;

  const bashToolSchema = Type.Object({
    command: Type.String({ minLength: 1 }),
    toolDescription: Type.String({ minLength: 1 }),
    working_dir: Type.Optional(Type.String({ minLength: 1 })),
  });

  let currentWorkingDir = workspaceRoot;

  // The tool is stateless at shell-process level (new shell per call), but we keep
  // the last successful directory to support relative `working_dir` chaining.
  const bashTool: DescribedAgentTool = {
    name: "bash",
    label: "Bash",
    description: "Execute a given bash command and returns its output.",
    toolRulePrompt: buildToolRulePrompt({ workspaceRoot, restrictToWorkspace }),
    parameters: bashToolSchema,
    async execute(toolCallId, params, signal) {
      const command = normalizeInput(params.command);
      const toolDescription = normalizeInput(params.toolDescription);
      const normalizedCommand = command.normalize("NFKC");
      const workspaceRootCanonical = await toPolicyPath(workspaceRoot);

      if (!command) {
        return blockedResult(
          toolDescription,
          command,
          normalizedCommand,
          workspaceRootCanonical,
          workspaceRootCanonical,
          "empty_command"
        );
      }

      const effectiveWorkingDir = await resolveWorkingDir(
        params.working_dir,
        workspaceRoot,
        currentWorkingDir
      );
      const effectiveWorkingDirCanonical = await toPolicyPath(effectiveWorkingDir);

      // Check 1: block blacklisted and high risk commands
      const commandPolicyReason = getCommandPolicyReason(normalizedCommand);
      if (commandPolicyReason) {
        return blockedResult(
          toolDescription,
          command,
          normalizedCommand,
          effectiveWorkingDirCanonical,
          effectiveWorkingDirCanonical,
          commandPolicyReason
        );
      }

      // Check 2: block commands that are outside the workspace if restrictToWorkspace == true
      if (restrictToWorkspace) {
        const workspaceReason = await getWorkspaceRestrictionReason(
          normalizedCommand,
          effectiveWorkingDirCanonical,
          workspaceRootCanonical
        );

        if (workspaceReason) {
          return blockedResult(
            toolDescription,
            command,
            normalizedCommand,
            effectiveWorkingDirCanonical,
            effectiveWorkingDirCanonical,
            workspaceReason
          );
        }
      }

      const execution = await runCommand({
        toolCallId,
        command,
        cwd: effectiveWorkingDirCanonical,
        signal,
      });

      const nextWorkingDir = await resolveNextWorkingDir(
        execution.nextWorkingDir,
        effectiveWorkingDirCanonical
      );

      if (restrictToWorkspace && !isWithin(workspaceRootCanonical, nextWorkingDir)) {
        return blockedResult(
          toolDescription,
          command,
          normalizedCommand,
          effectiveWorkingDirCanonical,
          effectiveWorkingDirCanonical,
          "next_working_dir_outside_workspace"
        );
      }

      currentWorkingDir = nextWorkingDir;

      return textResult(
        formatBashOutput(toolDescription, command, execution.stdout, execution.stderr, {
          effectiveWorkingDir: effectiveWorkingDirCanonical,
          nextWorkingDir,
          exitCode: execution.exitCode,
          timedOut: execution.timedOut,
        }),
        {
          toolDescription,
          command,
          normalizedCommand,
          effectiveWorkingDir: effectiveWorkingDirCanonical,
          nextWorkingDir,
          exitCode: execution.exitCode,
          timedOut: execution.timedOut,
          durationMs: execution.durationMs,
          stdoutBytes: execution.stdout.bytes,
          stderrBytes: execution.stderr.bytes,
          stdoutTruncated: execution.stdout.truncated,
          stderrTruncated: execution.stderr.truncated,
        } satisfies BashToolResult
      );
    },
  };

  return bashTool;
}

function normalizeInput(value: string): string {
  return value.trim();
}

function getBlacklistReason(command: string): string | null {
  if (GENERAL_COMMAND_BLACKLIST.some((pattern) => pattern.test(command))) {
    return "general_blacklist";
  }

  if (GIT_DESTRUCTIVE_BLACKLIST.some((pattern) => pattern.test(command))) {
    return "git_blacklist";
  }

  return null;
}

function getHighRiskReason(command: string): string | null {
  if (HIGH_RISK_UNVERIFIABLE_PATTERNS.some((pattern) => pattern.test(command))) {
    return "high_risk_or_unverifiable_command";
  }

  return null;
}

function getCommandPolicyReason(command: string): string | null {
  const blacklistReason = getBlacklistReason(command);
  if (blacklistReason) {
    return blacklistReason;
  }

  return getHighRiskReason(command);
}

async function getWorkspaceRestrictionReason(
  command: string,
  effectiveWorkingDir: string,
  workspaceRoot: string
): Promise<string | null> {
  // Workspace-restricted mode is fail-closed:
  // 1) working dir boundary check
  // 2) explicit path token boundary check
  if (!isWithin(workspaceRoot, effectiveWorkingDir)) {
    return "working_dir_outside_workspace";
  }

  return getOutsideWorkspacePathReason(command, effectiveWorkingDir, workspaceRoot);
}

// Resolve `working_dir` with this behavior:
// - empty => hard default to workspace root
// - absolute => use directly
// - relative => resolve from last successful cwd
async function resolveWorkingDir(
  requestedWorkingDir: string | undefined,
  workspaceRoot: string,
  currentWorkingDir: string
): Promise<string> {
  const raw = requestedWorkingDir?.trim();
  if (!raw) {
    return workspaceRoot;
  }

  const resolvedWorkingDir = isAbsolute(raw) ? raw : resolve(currentWorkingDir, raw);
  return toPolicyPath(resolvedWorkingDir);
}

async function resolveNextWorkingDir(nextWorkingDirFromShell: string | null, fallback: string): Promise<string> {
  if (!nextWorkingDirFromShell) {
    return fallback;
  }

  return toPolicyPath(nextWorkingDirFromShell);
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

async function getOutsideWorkspacePathReason(
  command: string,
  effectiveWorkingDir: string,
  workspaceRoot: string
): Promise<string | null> {
  const pathCandidates = extractPathCandidates(command);
  for (const candidate of pathCandidates) {
    const policyPath = await toPolicyPath(resolvePathCandidate(candidate, effectiveWorkingDir));
    if (!isWithin(workspaceRoot, policyPath)) {
      return `path_outside_workspace:${candidate}`;
    }
  }

  return null;
}

// Lightweight tokenizer/path detector:
// this intentionally stays conservative so we can fail-closed in restricted mode.
function extractPathCandidates(command: string): string[] {
  const tokens = tokenize(command);
  const candidates: string[] = [];

  for (const token of tokens) {
    if (isConnectorToken(token) || token.startsWith("-")) {
      continue;
    }

    const stripped = stripShellQuotes(token);
    if (!stripped || /^https?:\/\//i.test(stripped) || stripped.startsWith("$")) {
      continue;
    }

    if (
      stripped === "." ||
      stripped === ".." ||
      stripped.startsWith("/") ||
      stripped.startsWith("~/") ||
      stripped.startsWith("./") ||
      stripped.startsWith("../") ||
      stripped.includes("/")
    ) {
      candidates.push(stripped);
    }
  }

  return candidates;
}

function tokenize(command: string): string[] {
  const tokenMatches = command.match(/"([^"\\]|\\.)*"|'[^']*'|\S+/g);
  return tokenMatches ?? [];
}

function isConnectorToken(token: string): boolean {
  return token === "|" || token === "||" || token === "&&" || token === ";";
}

function stripShellQuotes(token: string): string {
  if (token.length >= 2) {
    if (
      (token.startsWith('"') && token.endsWith('"')) ||
      (token.startsWith("'") && token.endsWith("'"))
    ) {
      return token.slice(1, -1);
    }
  }

  return token;
}

function resolvePathCandidate(candidate: string, effectiveWorkingDir: string): string {
  if (candidate.startsWith("~/")) {
    return join(homedir(), candidate.slice(2));
  }

  if (isAbsolute(candidate)) {
    return candidate;
  }

  return resolve(effectiveWorkingDir, candidate);
}

async function runCommand(input: {
  toolCallId: string;
  command: string;
  cwd: string;
  signal?: AbortSignal;
}): Promise<{
  stdout: { text: string; bytes: number; truncated: boolean };
  stderr: { text: string; bytes: number; truncated: boolean };
  durationMs: number;
  exitCode: number | null;
  timedOut: boolean;
  nextWorkingDir: string | null;
}> {
  // Goal of this function:
  // 1) run one shell command in a child process
  // 2) collect bounded stdout/stderr
  // 3) enforce timeout / abort support
  // 4) return metadata (exitCode, timedOut, nextWorkingDir)
  //
  // Why we need a marker:
  // each tool call uses a new shell process, so shell state(pwd) does not persist.
  // Without marker, we cannot reliably know the *final* directory after a command, so the directory will not be persisted for the next Bash tool call.
  // like `cd x && do_something && cd y`, which breaks relative-path continuity in the next tool call.
  //
  // So we append one internal "protocol line": "<marker><PWD>".
  // Later we parse that line and store it as nextWorkingDir.
  const marker = `__MAHABOT_PWD_MARKER_${input.toolCallId}_${Math.random().toString(36).slice(2)}__`;

  // Wrap user command to preserve original exit code while still printing marker.
  // Expected behavior:
  // - user command runs inside "{ ... }"
  // - we capture its exit code in $__mahabot_exit_code
  // - we print marker + current PWD as the internal protocol line
  // - process exits with original command exit code
  const wrappedCommand = [
    "{",
    input.command,
    "}",
    "__mahabot_exit_code=$?",
    `printf '\\n${marker}%s\\n' \"$PWD\"`,
    "exit $__mahabot_exit_code",
  ].join("\n");

  const shellExecutable = process.env.SHELL?.trim() || "/bin/bash";
  const child = spawn(shellExecutable, ["-lc", wrappedCommand], {
    cwd: input.cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Keep the tail buffer bounded.
  // We only need recent bytes to find marker reliably, not full stream history.
  const appendTail = (
    existingTail: Uint8Array<ArrayBufferLike>,
    incoming: Uint8Array<ArrayBufferLike>,
    maxBytes: number
  ): Uint8Array<ArrayBufferLike> => {
    const merged = Buffer.concat([Buffer.from(existingTail), Buffer.from(incoming)]);
    if (merged.length <= maxBytes) {
      return merged;
    }
    return merged.subarray(merged.length - maxBytes);
  };

  let stdoutTotalBytes = 0;
  let stdoutCapturedBytes = 0;
  const stdoutChunks: Uint8Array[] = [];
  let stdoutTail: Uint8Array<ArrayBufferLike> = new Uint8Array(0);

  let stderrTotalBytes = 0;
  let stderrCapturedBytes = 0;
  const stderrChunks: Uint8Array[] = [];
  let stderrTail: Uint8Array<ArrayBufferLike> = new Uint8Array(0);

  // Important async model note:
  // registering `child.stdout.on("data", ...)` happens immediately (synchronous setup),
  // but the callback itself runs later when data is emitted (asynchronous execution).
  //
  // stdout collector behavior:
  // - always track total bytes (for truncation metadata)
  // - only keep first STDOUT_MAX_BYTES for returned text
  // - always keep trailing STDOUT_TAIL_BYTES for marker extraction
  child.stdout.on("data", (newChunk: Uint8Array<ArrayBufferLike>) => {
    stdoutTotalBytes += newChunk.length;
    // if still within max output limit, append.
    if (stdoutCapturedBytes < STDOUT_MAX_BYTES) {
      const remaining = STDOUT_MAX_BYTES - stdoutCapturedBytes;
      const capture = newChunk.subarray(0, remaining);
      stdoutChunks.push(capture);
      stdoutCapturedBytes += capture.length;
    }
    stdoutTail = appendTail(stdoutTail, newChunk, STDOUT_TAIL_BYTES);
  });

  // stderr collector uses the same strategy as stdout:
  // bounded returned text + full total-bytes accounting + bounded tail.
  child.stderr.on("data", (chunk: Uint8Array<ArrayBufferLike>) => {
    stderrTotalBytes += chunk.length;
    if (stderrCapturedBytes < STDERR_MAX_BYTES) {
      const remaining = STDERR_MAX_BYTES - stderrCapturedBytes;
      const capture = chunk.subarray(0, remaining);
      stderrChunks.push(capture);
      stderrCapturedBytes += capture.length;
    }
    stderrTail = appendTail(stderrTail, chunk, STDOUT_TAIL_BYTES);
  });

  let timedOut = false;
  const forceKillHandle = { timer: undefined as NodeJS.Timeout | undefined };

  // `setTimeout(...)` only schedules future callbacks; it does not run inline here.
  //
  // Timeout policy:
  // - after BASH_TIMEOUT_MS, send SIGTERM first (graceful stop)
  // - if process does not exit quickly, escalate to SIGKILL
  // Expected behavior: timedOut=true only when timeout path triggers.
  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    forceKillHandle.timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, 300);
  }, BASH_TIMEOUT_MS);

  const abortHandler = () => {
    child.kill("SIGTERM");
    forceKillHandle.timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, 300);
  };

  // Respect external cancellation (AbortSignal) with the same TERM->KILL sequence.
  if (input.signal) {
    if (input.signal.aborted) {
      abortHandler();
    } else {
      input.signal.addEventListener("abort", abortHandler, { once: true });
    }
  }

  const start = Date.now();

  // Up to this point, we have only set up async event sources:
  // stream listeners, timeout callbacks, and optional abort listener.
  //
  // `await` below pauses this async function until the promise settles.
  // It does NOT block the Node.js event loop, so those callbacks keep running.
  //
  // Wait until child exits or errors.
  // - "error" => reject promise
  // - "close" => resolve with exit code
  // Cleanup (timers + event listener) always runs in finally.
  // After await resolves/rejects, execution continues to the parsing/formatting code below.
  const closeInfo = await new Promise<{ exitCode: number | null }>((resolvePromise, rejectPromise) => {
    child.once("error", (error) => {
      rejectPromise(error);
    });

    child.once("close", (exitCode) => {
      resolvePromise({ exitCode });
    });
  }).finally(() => {
    clearTimeout(timeoutTimer);
    if (forceKillHandle.timer) {
      clearTimeout(forceKillHandle.timer);
    }
    if (input.signal) {
      input.signal.removeEventListener("abort", abortHandler);
    }
  });

  // Parse marker from stdout tail to recover the next working directory.
  // We search only in tail for efficiency and because marker is printed at the end.
  const escapedMarker = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const markerRegex = new RegExp(`${escapedMarker}([^\\n\\r]+)`);
  const markerMatch = Buffer.from(stdoutTail).toString("utf-8").match(markerRegex)?.[1]?.trim() ?? null;

  // Build returned stdout/stderr text:
  // - decode captured chunks
  // - remove marker line from stdout so user does not see internal protocol noise
  // - compute truncated flags from total byte counts
  const stdoutText = Buffer.concat(stdoutChunks.map((chunk) => Buffer.from(chunk))).toString("utf-8");
  const stdoutWithoutMarker = stdoutText
    .replace(new RegExp(`\\n?${escapedMarker}[^\\n\\r]*\\r?\\n?`, "g"), "\n")
    .trimEnd();
  const stderrText = Buffer.concat(stderrChunks.map((chunk) => Buffer.from(chunk))).toString("utf-8");
  const stdoutTruncated = stdoutTotalBytes > STDOUT_MAX_BYTES;
  const stderrTruncated = stderrTotalBytes > STDERR_MAX_BYTES;

  // Final contract:
  // - text fields are normalized by finalizeOutputText(...)
  // - bytes/truncated expose stream size status
  // - durationMs is wall-clock runtime
  // - nextWorkingDir is parsed marker result (or null if marker missing)
  return {
    stdout: {
      text: finalizeOutputText(stdoutWithoutMarker, stdoutTruncated, "stdout"),
      bytes: stdoutTotalBytes,
      truncated: stdoutTruncated,
    },
    stderr: {
      text: finalizeOutputText(stderrText, stderrTruncated, "stderr"),
      bytes: stderrTotalBytes,
      truncated: stderrTruncated,
    },
    durationMs: Date.now() - start,
    exitCode: closeInfo.exitCode,
    timedOut,
    nextWorkingDir: markerMatch,
  };
}

function finalizeOutputText(text: string, truncated: boolean, streamLabel: "stdout" | "stderr"): string {
  const normalized = text.trim();
  if (!truncated) {
    return normalized;
  }

  const base = normalized.length > 0 ? normalized : "(empty)";
  return `${base}\n...[${streamLabel} truncated to ${streamLabel === "stdout" ? STDOUT_MAX_BYTES : STDERR_MAX_BYTES} bytes]`;
}


function formatBashOutput(
  toolDescription: string,
  command: string,
  stdout: { text: string; bytes: number; truncated: boolean },
  stderr: { text: string; bytes: number; truncated: boolean },
  meta: {
    effectiveWorkingDir: string;
    nextWorkingDir: string;
    exitCode: number | null;
    timedOut: boolean;
  }
): string {
  const stdoutText = stdout.text.length > 0 ? stdout.text : "(empty)";
  const stderrText = stderr.text.length > 0 ? stderr.text : "(empty)";

  return [
    "Bash command execution result:",
    `- toolDescription: ${toolDescription || "(empty)"}`,
    `- command: ${command}`,
    `- effectiveWorkingDir: ${meta.effectiveWorkingDir}`,
    `- nextWorkingDir: ${meta.nextWorkingDir}`,
    `- exitCode: ${meta.exitCode === null ? "null" : String(meta.exitCode)}`,
    `- timedOut: ${meta.timedOut}`,
    `- stdoutBytes: ${stdout.bytes}`,
    `- stderrBytes: ${stderr.bytes}`,
    `- stdoutTruncated: ${stdout.truncated}`,
    `- stderrTruncated: ${stderr.truncated}`,
    "",
    "stdout:",
    stdoutText,
    "",
    "stderr:",
    stderrText,
  ].join("\n");
}

function blockedResult(
  toolDescription: string,
  command: string,
  normalizedCommand: string,
  effectiveWorkingDir: string,
  nextWorkingDir: string,
  blockedReason: string
) {
  const result: BashToolResult = {
    toolDescription,
    command,
    normalizedCommand,
    effectiveWorkingDir,
    nextWorkingDir,
    exitCode: null,
    timedOut: false,
    durationMs: 0,
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutTruncated: false,
    stderrTruncated: false,
    blockedReason,
  };

  return textResult(
    [
      "Bash command blocked by policy:",
      `- blockedReason: ${blockedReason}`,
      `- toolDescription: ${toolDescription || "(empty)"}`,
      `- command: ${command || "(empty)"}`,
      `- effectiveWorkingDir: ${effectiveWorkingDir}`,
    ].join("\n"),
    result
  );
}

function buildToolRulePrompt(input: { workspaceRoot: string; restrictToWorkspace: boolean }): string {
  const workspaceSection = input.restrictToWorkspace
    ? [
        "### Workspace Restriction",
        `- Workspace restriction is ON. You must only access files under: ${input.workspaceRoot}`,
        "- Commands that are cannot be verified as workspace-safe will be rejected.",
        "",
      ].join("\n")
    : "";

  return [
    "## Bash",
    "Executes a given bash command and returns its output.",
    "The working directory persists between commands, but shell state does not. The shell environment is initialized from the user's profile (bash or zsh).",
    workspaceSection,
    "### Important: Prefer Dedicated Tools",
    "IMPORTANT: Avoid using Bash tool for tasks covered by dedicated tools unless the user explicitly instructs it, or you have verified that a dedicated tool cannot accomplish the task.",
    "Using dedicated tools provides a better user experience and makes tool-call review/permission flows clearer.",
    "- Read files: use `read_file` (NOT `cat`, `head`, `tail`).",
    "- Edit files: use `edit_file` (NOT `sed`, `awk`).",
    "- Write files: use `write_file` (NOT `echo >`, `cat <<EOF`).",
    "- List directory structure: use `list_tree`.",
    "- Communication: output text directly in assistant response (NOT `echo`/`printf`).",
    "",
    "### Instructions",
    "- If your command will create new directories or files, first use this tool to run `ls` to verify the parent directory exists and is the correct location.",
    "- Always quote file paths that contain spaces with double quotes in your command (e.g., cd \"path with spaces/file.txt\")",
    "- Try to maintain your current working directory throughout the session by using absolute paths and avoiding usage of `cd`. You may use `cd` if the User explicitly requests it.",
    "- The command timeout is fixed at 120000ms (2 minutes).",
    "- Write a clear, concise `toolDescription` of what your command does. For simple commands, keep it brief (5-10 words). For complex commands (piped commands, obscure flags, or anything hard to understand at a glance), include enough context so that the user can understand what your command will do.",
    "- When issuing multiple commands:",
    "    - If the commands are independent and can run in parallel, make multiple Bash tool calls in a single message. Example: if you need to run \"git status\" and \"git diff\", send a single message with two Bash tool calls in parallel.",
    "    - If the commands depend on each other and must run sequentially, use a single Bash call with '&&' to chain them together.",
    "    - Use ';' only when you need to run commands sequentially but don't care if earlier commands fail.",
    "    - DO NOT use newlines to separate commands (newlines are ok in quoted strings).",
    "- For git commands:",
    "    - Prefer to create a new commit rather than amending an existing commit.",
    "    - Before running destructive operations (e.g., git reset --hard, git push --force, git checkout --), consider whether there is a safer alternative that achieves the same goal. Only use destructive operations when they are truly the best approach.",
    "    - Never skip hooks (--no-verify) or bypass signing (--no-gpg-sign, -c commit.gpgsign=false) unless the user has explicitly asked for it. If a hook fails, investigate and fix the underlying issue.",
    "- Avoid unnecessary `sleep` commands:",
    "    - Do not sleep between commands that can run immediately — just run them.",
    "    - Do not retry failing commands in a sleep loop — diagnose the root cause or consider an alternative approach.",
    "    - If you must poll an external process, use a check command (e.g. `gh run view`) rather than sleeping first.",
    "    - If you must sleep, keep the duration short (1-5 seconds) to avoid blocking the user.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

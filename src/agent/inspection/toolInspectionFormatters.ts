export const MAX_TOOL_IO_CHARS = 100;

type UnknownRecord = Record<string, unknown>;

interface ToolFormatter {
  start?: (args: unknown) => string;
  update?: (partialResult: unknown) => string;
  end?: (result: unknown, isError: boolean) => string;
}

const FORMATTERS: Record<string, ToolFormatter> = {
  bash: {
    start: formatBashStart,
    update: (partialResult) => quoteFromTextLike(partialResult, "(running)"),
    end: formatBashEnd,
  },
  read_file: {
    start: formatReadFileStart,
    update: (partialResult) => quoteFromTextLike(partialResult, "(reading)"),
    end: formatReadFileEnd,
  },
  write_file: {
    start: formatWriteFileStart,
    update: (partialResult) => quoteFromTextLike(partialResult, "(writing)"),
    end: formatWriteFileEnd,
  },
  edit_file: {
    start: formatEditFileStart,
    update: (partialResult) => quoteFromTextLike(partialResult, "(editing)"),
    end: formatEditFileEnd,
  },
  grep: {
    start: formatGrepStart,
    update: (partialResult) => quoteFromTextLike(partialResult, "(searching)"),
    end: formatGrepEnd,
  },
  glob: {
    start: formatGlobStart,
    update: (partialResult) => quoteFromTextLike(partialResult, "(matching paths)"),
    end: formatGlobEnd,
  },
  list_tree: {
    start: formatListTreeStart,
    update: (partialResult) => quoteFromTextLike(partialResult, "(traversing tree)"),
    end: formatListTreeEnd,
  },
  show_runtime_info: {
    start: () => "(no input)",
    end: formatShowRuntimeInfoEnd,
  },
  in_flight_update: {
    start: formatInFlightUpdateStart,
    end: formatInFlightUpdateEnd,
  },
  echo_structured_input: {
    start: formatEchoStructuredInputStart,
    end: formatEchoStructuredInputEnd,
  },
  progressive_ticker: {
    start: formatProgressiveTickerStart,
    update: formatProgressiveTickerUpdate,
    end: formatProgressiveTickerEnd,
  },
  render_debug_badge: {
    start: formatRenderDebugBadgeStart,
    end: formatRenderDebugBadgeEnd,
  },
  fail_intentionally: {
    start: formatFailIntentionallyStart,
    end: (result, isError) => formatErrorAwareResult(result, isError, "(failed)"),
  },
};

export function formatToolStart(toolName: string, args: unknown): string {
  const formatter = FORMATTERS[toolName]?.start;
  if (formatter) {
    return safeFormat(() => formatter(args), "(input unavailable)");
  }
  return formatGenericStart(args);
}

export function formatToolUpdate(toolName: string, partialResult: unknown): string {
  const formatter = FORMATTERS[toolName]?.update;
  if (formatter) {
    return safeFormat(() => formatter(partialResult), "(updating)");
  }
  return quoteFromTextLike(partialResult, "(updating)");
}

export function formatToolEnd(toolName: string, result: unknown, isError: boolean): string {
  const formatter = FORMATTERS[toolName]?.end;
  if (formatter) {
    return safeFormat(() => formatter(result, isError), "(output unavailable)");
  }
  return formatErrorAwareResult(result, isError, "(output unavailable)");
}

function formatBashStart(args: unknown): string {
  const record = asRecord(args);
  const command = readString(record, "command");
  if (!command) {
    return "(command unavailable)";
  }
  return quote(clipForToolIo(command));
}

function formatBashEnd(result: unknown, isError: boolean): string {
  const details = readDetails(result);
  const blockedReason = readString(details, "blockedReason");
  if (blockedReason) {
    return quote(`blocked: ${blockedReason}`);
  }

  const text = readTextContent(result) ?? readString(details, "message");
  if (!text) {
    return formatErrorAwareResult(result, isError, "(output unavailable)");
  }

  const parsedStreams = parseBashStreamText(text);
  if (parsedStreams.stdout && parsedStreams.stderr) {
    return quote(`stdout: ${parsedStreams.stdout}; stderr: ${parsedStreams.stderr}`);
  }
  if (parsedStreams.stdout) {
    return quote(parsedStreams.stdout);
  }
  if (parsedStreams.stderr) {
    return quote(`stderr: ${parsedStreams.stderr}`);
  }

  return quote(normalizeSnippet(text));
}

function parseBashStreamText(text: string): { stdout?: string; stderr?: string } {
  const normalized = text.replace(/\r\n/g, "\n");
  const streamMatch = normalized.match(/\nstdout:\n([\s\S]*?)\n\nstderr:\n([\s\S]*)$/);
  if (!streamMatch) {
    return {};
  }

  const stdoutRaw = normalizeText(streamMatch[1] ?? "");
  const stderrRaw = normalizeText(streamMatch[2] ?? "");
  return {
    stdout: stdoutRaw.length > 0 && stdoutRaw !== "(empty)" ? clipForToolIo(stdoutRaw) : undefined,
    stderr: stderrRaw.length > 0 && stderrRaw !== "(empty)" ? clipForToolIo(stderrRaw) : undefined,
  };
}

function formatReadFileStart(args: unknown): string {
  const record = asRecord(args);
  const path = readString(record, "path");
  if (!path) {
    return "(path unavailable)";
  }
  return quote(path);
}

function formatReadFileEnd(result: unknown, isError: boolean): string {
  const details = readDetails(result);
  const ok = readBoolean(details, "ok");
  if (ok === false || isError) {
    return quoteFromErrorMessage(result, "read failed");
  }

  const path = readString(details, "resolvedPath");
  const text = readTextContent(result) ?? "";
  const contentSnippet = extractReadFileContentSnippet(text);
  const truncated = readBoolean(details, "truncated") === true;
  const nextOffset = readNumber(details, "nextOffset");
  const suffixParts: string[] = [];
  if (truncated) {
    suffixParts.push("truncated");
  }
  if (nextOffset !== undefined) {
    suffixParts.push(`nextOffset=${nextOffset}`);
  }

  const base = path ? `${quote(path)} ${quote(contentSnippet)}` : quote(contentSnippet);
  if (suffixParts.length === 0) {
    return base;
  }
  return `${base} (${suffixParts.join(", ")})`;
}

function extractReadFileContentSnippet(text: string): string {
  const marker = "\ncontent:\n";
  const markerIndex = text.indexOf(marker);
  const content = markerIndex >= 0 ? text.slice(markerIndex + marker.length) : text;
  const normalized = normalizeText(content);
  if (!normalized) {
    return "(empty)";
  }
  return clipForToolIo(normalized);
}

function formatWriteFileStart(args: unknown): string {
  const record = asRecord(args);
  const path = readString(record, "path");
  const mode = readString(record, "mode") ?? "overwrite";
  if (!path) {
    return "(path unavailable)";
  }
  return quote(`${mode} ${path}`);
}

function formatWriteFileEnd(result: unknown, isError: boolean): string {
  const details = readDetails(result);
  const ok = readBoolean(details, "ok");
  if (ok === false || isError) {
    return quoteFromErrorMessage(result, "write failed");
  }

  const path = readString(details, "resolvedPath") ?? "(path unavailable)";
  const mode = readString(details, "mode") ?? "overwrite";
  const created = readBoolean(details, "created");
  const bytesWritten = readNumber(details, "bytesWritten");
  const action = mode === "append" ? "appended" : created ? "created" : "updated";
  const bytesPart = bytesWritten !== undefined ? ` (${bytesWritten} bytes)` : "";
  return quote(`${action} ${path}${bytesPart}`);
}

function formatEditFileStart(args: unknown): string {
  const record = asRecord(args);
  const path = readString(record, "path");
  if (!path) {
    return "(path unavailable)";
  }
  const oldText = readString(record, "oldText");
  const newText = readString(record, "newText");
  const changePreview =
    oldText !== undefined && newText !== undefined
      ? ` ${clipForToolIo(`${normalizeText(oldText)} -> ${normalizeText(newText)}`)}`
      : "";
  return quote(`${path}${changePreview}`);
}

function formatEditFileEnd(result: unknown, isError: boolean): string {
  const details = readDetails(result);
  const ok = readBoolean(details, "ok");
  if (ok === false || isError) {
    return quoteFromErrorMessage(result, "edit failed");
  }

  const path = readString(details, "resolvedPath") ?? "(path unavailable)";
  const dryRun = readBoolean(details, "dryRun") === true;
  const matches = readNumber(details, "matches");
  const occurrenceUsed = readNumber(details, "occurrenceUsed");
  const prefix = dryRun ? "preview" : "edited";
  const parts = [`${prefix} ${path}`];
  if (matches !== undefined) {
    parts.push(`matches=${matches}`);
  }
  if (occurrenceUsed !== undefined) {
    parts.push(`occurrence=${occurrenceUsed}`);
  }
  return quote(parts.join(" "));
}

function formatGrepStart(args: unknown): string {
  const record = asRecord(args);
  const pattern = readString(record, "pattern");
  const path = readString(record, "path") ?? ".";
  if (!pattern) {
    return "(pattern unavailable)";
  }
  return quote(`${pattern} in ${path}`);
}

function formatGrepEnd(result: unknown, isError: boolean): string {
  const details = readDetails(result);
  const ok = readBoolean(details, "ok");
  if (ok === false || isError) {
    return quoteFromErrorMessage(result, "grep failed");
  }

  const returnedMatches = readNumber(details, "returnedMatches") ?? 0;
  const filesScanned = readNumber(details, "filesScanned");
  const firstMatch = readFirstMatchLocation(readArray(details, "matches"));
  let summary = `${returnedMatches} matches`;
  if (filesScanned !== undefined) {
    summary += ` in ${filesScanned} files`;
  }
  if (firstMatch) {
    summary += `, first ${firstMatch}`;
  }
  return quote(summary);
}

function formatGlobStart(args: unknown): string {
  const record = asRecord(args);
  const pattern = readString(record, "pattern");
  const path = readString(record, "path") ?? ".";
  if (!pattern) {
    return "(pattern unavailable)";
  }
  return quote(`${pattern} in ${path}`);
}

function formatGlobEnd(result: unknown, isError: boolean): string {
  const details = readDetails(result);
  const ok = readBoolean(details, "ok");
  if (ok === false || isError) {
    return quoteFromErrorMessage(result, "glob failed");
  }

  const returnedMatches = readNumber(details, "returnedMatches") ?? 0;
  const matches = readArray(details, "matches");
  const first = readFirstPath(matches);
  const summary = first ? `${returnedMatches} matches, first ${first}` : `${returnedMatches} matches`;
  return quote(summary);
}

function formatListTreeStart(args: unknown): string {
  const record = asRecord(args);
  const path = readString(record, "path");
  if (!path) {
    return "(path unavailable)";
  }
  const maxDepth = readNumber(record, "maxDepth");
  if (maxDepth === undefined) {
    return quote(path);
  }
  return quote(`${path} (maxDepth=${maxDepth})`);
}

function formatListTreeEnd(result: unknown, isError: boolean): string {
  const details = readDetails(result);
  const ok = readBoolean(details, "ok");
  if (ok === false || isError) {
    return quoteFromErrorMessage(result, "list tree failed");
  }

  const root = readString(details, "resolvedPath") ?? readString(details, "root") ?? ".";
  const returnedEntries = readNumber(details, "returnedEntries") ?? 0;
  const truncated = readBoolean(details, "truncated") === true;
  const truncatedPart = truncated ? " truncated" : "";
  return quote(`${root}: ${returnedEntries} entries${truncatedPart}`);
}

function formatShowRuntimeInfoEnd(result: unknown, isError: boolean): string {
  if (isError) {
    return quoteFromErrorMessage(result, "runtime info failed");
  }
  const details = readDetails(result);
  const isoTime = readString(details, "isoTime");
  const now = readNumber(details, "now");
  if (isoTime) {
    return quote(isoTime);
  }
  if (now !== undefined) {
    return quote(String(now));
  }
  return quoteFromTextLike(result, "(runtime info)");
}

function formatInFlightUpdateStart(args: unknown): string {
  const record = asRecord(args);
  const message = readString(record, "message");
  if (!message) {
    return "(message unavailable)";
  }
  return quote(message);
}

function formatInFlightUpdateEnd(result: unknown, isError: boolean): string {
  const details = readDetails(result);
  const delivered = readBoolean(details, "delivered");
  if (isError || delivered === false) {
    return quoteFromErrorMessage(result, "update not delivered");
  }
  return quote("update delivered");
}

function formatEchoStructuredInputStart(args: unknown): string {
  const record = asRecord(args);
  const title = readString(record, "title");
  const mood = readString(record, "mood");
  if (!title) {
    return "(title unavailable)";
  }
  if (mood) {
    return quote(`${title} (${mood})`);
  }
  return quote(title);
}

function formatEchoStructuredInputEnd(result: unknown, isError: boolean): string {
  if (isError) {
    return quoteFromErrorMessage(result, "echo failed");
  }
  const details = readDetails(result);
  const received = asRecord(readUnknown(details, "received"));
  const title = readString(received, "title");
  const tags = readArray(received, "tags");
  if (!title) {
    return quoteFromTextLike(result, "(echo complete)");
  }
  const tagCount = tags.length;
  return quote(`${title} (${tagCount} tags)`);
}

function formatProgressiveTickerStart(args: unknown): string {
  const record = asRecord(args);
  const steps = readNumber(record, "steps");
  const label = readString(record, "label");
  if (steps === undefined) {
    return label ? quote(label) : "(ticker start)";
  }
  return label ? quote(`${label} (${steps} steps)`) : quote(`${steps} steps`);
}

function formatProgressiveTickerUpdate(partialResult: unknown): string {
  const details = readDetails(partialResult);
  const step = readNumber(details, "step");
  const total = readNumber(details, "total");
  if (step !== undefined && total !== undefined) {
    return quote(`step ${step}/${total}`);
  }
  return quoteFromTextLike(partialResult, "(ticker running)");
}

function formatProgressiveTickerEnd(result: unknown, isError: boolean): string {
  if (isError) {
    return quoteFromErrorMessage(result, "ticker failed");
  }
  const details = readDetails(result);
  const step = readNumber(details, "step");
  const total = readNumber(details, "total");
  if (step !== undefined && total !== undefined) {
    return quote(`finished ${step}/${total}`);
  }
  return quoteFromTextLike(result, "(ticker complete)");
}

function formatRenderDebugBadgeStart(args: unknown): string {
  const record = asRecord(args);
  const label = readString(record, "label");
  const color = readString(record, "color");
  if (!label) {
    return "(badge input unavailable)";
  }
  return color ? quote(`${label} (${color})`) : quote(label);
}

function formatRenderDebugBadgeEnd(result: unknown, isError: boolean): string {
  if (isError) {
    return quoteFromErrorMessage(result, "badge render failed");
  }
  const details = readDetails(result);
  const label = readString(details, "label");
  const color = readString(details, "color");
  if (label && color) {
    return quote(`${label} (${color})`);
  }
  if (label) {
    return quote(label);
  }
  return quoteFromTextLike(result, "(badge generated)");
}

function formatFailIntentionallyStart(args: unknown): string {
  const record = asRecord(args);
  const reason = readString(record, "reason");
  if (!reason) {
    return quote("intentional failure");
  }
  return quote(reason);
}

function formatGenericStart(args: unknown): string {
  const record = asRecord(args);
  if (record) {
    const prioritized = pickFirstNonEmptyString(record, [
      "path",
      "command",
      "pattern",
      "message",
      "title",
      "label",
      "reason",
    ]);
    if (prioritized) {
      return quote(prioritized);
    }
  }
  return "(input unavailable)";
}

function formatErrorAwareResult(result: unknown, isError: boolean, fallback: string): string {
  if (isError) {
    return quoteFromErrorMessage(result, fallback);
  }
  return quoteFromTextLike(result, fallback);
}

function quoteFromTextLike(value: unknown, fallback: string): string {
  const text = readTextContent(value);
  if (!text) {
    return fallback;
  }
  return quote(normalizeSnippet(text));
}

function quoteFromErrorMessage(result: unknown, fallback: string): string {
  const details = readDetails(result);
  const fromDetails = readString(details, "message");
  if (fromDetails) {
    return quote(`error: ${normalizeSnippet(fromDetails)}`);
  }

  const text = readTextContent(result);
  if (text) {
    return quote(`error: ${normalizeSnippet(text)}`);
  }

  const record = asRecord(result);
  const message = readString(record, "message") ?? readString(record, "error");
  if (message) {
    return quote(`error: ${normalizeSnippet(message)}`);
  }

  return quote(`error: ${fallback}`);
}

function readFirstMatchLocation(matches: unknown[]): string | undefined {
  if (matches.length === 0) {
    return undefined;
  }
  const first = asRecord(matches[0]);
  const path = readString(first, "path");
  const line = readNumber(first, "line");
  if (!path || line === undefined) {
    return undefined;
  }
  return clipForToolIo(`${path}:${line}`);
}

function readFirstPath(matches: unknown[]): string | undefined {
  if (matches.length === 0) {
    return undefined;
  }
  const first = asRecord(matches[0]);
  const path = readString(first, "path");
  if (!path) {
    return undefined;
  }
  return clipForToolIo(path);
}

function readTextContent(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  const content = readArray(record, "content");
  for (const block of content) {
    const item = asRecord(block);
    if (!item) {
      continue;
    }
    if (readString(item, "type") !== "text") {
      continue;
    }
    const text = readString(item, "text");
    if (text) {
      return text;
    }
  }

  return readString(record, "message");
}

function readDetails(value: unknown): UnknownRecord | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  return asRecord(record.details);
}

function readUnknown(record: UnknownRecord | undefined, key: string): unknown {
  if (!record) {
    return undefined;
  }
  return record[key];
}

function readString(record: UnknownRecord | undefined, key: string): string | undefined {
  const value = readUnknown(record, key);
  if (typeof value === "string") {
    return value;
  }
  return undefined;
}

function readNumber(record: UnknownRecord | undefined, key: string): number | undefined {
  const value = readUnknown(record, key);
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return undefined;
}

function readBoolean(record: UnknownRecord | undefined, key: string): boolean | undefined {
  const value = readUnknown(record, key);
  if (typeof value === "boolean") {
    return value;
  }
  return undefined;
}

function readArray(record: UnknownRecord | undefined, key: string): unknown[] {
  const value = readUnknown(record, key);
  if (Array.isArray(value)) {
    return value;
  }
  return [];
}

function pickFirstNonEmptyString(record: UnknownRecord, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = readString(record, key);
    if (!value) {
      continue;
    }
    const normalized = normalizeText(value);
    if (!normalized) {
      continue;
    }
    return clipForToolIo(normalized);
  }
  return undefined;
}

function normalizeSnippet(input: string): string {
  const normalized = normalizeText(input);
  if (!normalized) {
    return "(empty)";
  }
  return clipForToolIo(normalized);
}

function normalizeText(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

function quote(input: string): string {
  return `"${input}"`;
}

function clipForToolIo(input: string): string {
  if (input.length <= MAX_TOOL_IO_CHARS) {
    return input;
  }
  return `${input.slice(0, MAX_TOOL_IO_CHARS)}...`;
}

function asRecord(value: unknown): UnknownRecord | undefined {
  if (typeof value === "object" && value !== null) {
    return value as UnknownRecord;
  }
  return undefined;
}

function safeFormat(formatter: () => string, fallback: string): string {
  try {
    const value = formatter();
    const normalized = typeof value === "string" ? value.trim() : "";
    return normalized.length > 0 ? normalized : fallback;
  } catch {
    return fallback;
  }
}

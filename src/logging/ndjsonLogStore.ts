import { mkdir, readFile, rename, writeFile, appendFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { LogEvent, LogStore } from "./types.js";

export interface NdjsonLogStoreOptions {
  path: string;
  maxEntries: number;
  maxAgeMs?: number;
  compactEveryWrites: number;
  compactIntervalMs: number;
  now?: () => number;
  onInternalError?: (error: unknown) => void;
}

export class NdjsonLogStore implements LogStore {
  private readonly now: () => number;
  private readonly onInternalError: (error: unknown) => void;
  private pendingLines: string[] = [];
  private writeChain: Promise<void> = Promise.resolve();
  private writeCountSinceCompact = 0;
  private lastCompactAt = 0;

  constructor(private readonly options: NdjsonLogStoreOptions) {
    this.now = options.now ?? (() => Date.now());
    this.onInternalError = options.onInternalError ?? (() => undefined);
  }

  append(event: LogEvent): void {
    this.pendingLines.push(`${JSON.stringify(event)}\n`);
    this.writeCountSinceCompact += 1;

    this.writeChain = this.writeChain
      .then(() => this.drainPendingLines())
      .then(() => this.compactIfNeeded())
      .catch((error) => {
        this.onInternalError(error);
      });
  }

  async flush(): Promise<void> {
    await this.writeChain;
    await this.drainPendingLines();
    await this.compact(true);
  }

  private async drainPendingLines(): Promise<void> {
    if (this.pendingLines.length === 0) {
      return;
    }

    const lines = this.pendingLines.join("");
    this.pendingLines = [];
    await mkdir(dirname(this.options.path), { recursive: true });
    await appendFile(this.options.path, lines, "utf-8");
  }

  private async compactIfNeeded(): Promise<void> {
    const now = this.now();
    const enoughWrites = this.writeCountSinceCompact >= this.options.compactEveryWrites;
    const enoughTime = now - this.lastCompactAt >= this.options.compactIntervalMs;
    if (!enoughWrites && !enoughTime) {
      return;
    }
    await this.compact(false);
  }

  private async compact(force: boolean): Promise<void> {
    if (!force && this.options.maxEntries < 1 && this.options.maxAgeMs === undefined) {
      return;
    }

    let raw: string;
    try {
      raw = await readFile(this.options.path, "utf-8");
    } catch (error) {
      if (isFileNotFound(error)) {
        return;
      }
      throw error;
    }

    const cutoff = this.options.maxAgeMs === undefined ? undefined : this.now() - this.options.maxAgeMs;
    const kept: string[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      const parsed = parseLogLine(line);
      if (!parsed) {
        continue;
      }
      if (cutoff !== undefined && parsed.ts < cutoff) {
        continue;
      }
      kept.push(line);
    }

    const bounded = kept.slice(-this.options.maxEntries);
    const tmpPath = `${this.options.path}.tmp`;
    await writeFile(tmpPath, bounded.length > 0 ? `${bounded.join("\n")}\n` : "", "utf-8");
    await rename(tmpPath, this.options.path);

    this.writeCountSinceCompact = 0;
    this.lastCompactAt = this.now();
  }
}

function parseLogLine(line: string): { ts: number } | undefined {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      "ts" in parsed &&
      typeof (parsed as { ts?: unknown }).ts === "number"
    ) {
      return { ts: (parsed as { ts: number }).ts };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function isFileNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

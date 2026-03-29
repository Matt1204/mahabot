import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { AgentMessage } from "@mariozechner/pi-agent-core";

export interface PersistedMessageRecord {
  schemaVersion: 1;
  sessionId: string;
  persistedAt: number;
  message: AgentMessage;
}

export interface JsonlMessageStoreConfig {
  sessionId: string;
  sessionJsonlPath: string;
}

export interface JsonlMessageStoreDeps {
  logger?: Pick<Console, "warn">;
  now?: () => number;
}

export class JsonlMessageStore {
  private readonly logger: Pick<Console, "warn">;
  private readonly now: () => number;

  constructor(
    private readonly config: JsonlMessageStoreConfig,
    deps: JsonlMessageStoreDeps = {}
  ) {
    this.logger = deps.logger ?? console;
    this.now = deps.now ?? (() => Date.now());
  }

  async readAll(): Promise<PersistedMessageRecord[]> {
    let raw = "";
    try {
      raw = await readFile(this.config.sessionJsonlPath, "utf-8");
    } catch (error) {
      if (isFileNotFound(error)) {
        return [];
      }
      throw error;
    }

    const lines = raw.split(/\r?\n/);
    const lastNonEmptyLineIndex = findLastNonEmptyLineIndex(lines);
    const records: PersistedMessageRecord[] = [];

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]?.trim();
      if (!line) {
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        if (index === lastNonEmptyLineIndex) {
          this.logger.warn(
            `[message persistence] ignoring malformed trailing JSONL line in '${this.config.sessionJsonlPath}': ${String(
              error
            )}`
          );
          continue;
        }
        this.logger.warn(
          `[message persistence] skipping malformed JSONL line ${index + 1} in '${
            this.config.sessionJsonlPath
          }': ${String(error)}`
        );
        continue;
      }

      const record = normalizeRecord(parsed);
      if (!record) {
        this.logger.warn(
          `[message persistence] skipping invalid JSONL record at line ${index + 1} in '${
            this.config.sessionJsonlPath
          }'`
        );
        continue;
      }

      if (record.sessionId !== this.config.sessionId) {
        this.logger.warn(
          `[message persistence] skipping record for unexpected session '${record.sessionId}' in '${this.config.sessionJsonlPath}'`
        );
        continue;
      }

      records.push(record);
    }

    return records;
  }

  async appendMessages(messages: AgentMessage[]): Promise<number> {
    if (messages.length === 0) {
      return 0;
    }

    const payload = messages
      .map((message) =>
        JSON.stringify({
          schemaVersion: 1,
          sessionId: this.config.sessionId,
          persistedAt: this.now(),
          message,
        } satisfies PersistedMessageRecord)
      )
      .join("\n");

    await mkdir(dirname(this.config.sessionJsonlPath), { recursive: true });
    await appendFile(this.config.sessionJsonlPath, `${payload}\n`, "utf-8");
    return messages.length;
  }
}

function normalizeRecord(value: unknown): PersistedMessageRecord | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  if (value.schemaVersion !== 1) {
    return undefined;
  }

  if (typeof value.sessionId !== "string") {
    return undefined;
  }

  if (typeof value.persistedAt !== "number" || !Number.isFinite(value.persistedAt)) {
    return undefined;
  }

  if (!isRecord(value.message)) {
    return undefined;
  }

  return {
    schemaVersion: 1,
    sessionId: value.sessionId,
    persistedAt: value.persistedAt,
    message: value.message as unknown as AgentMessage,
  };
}

function findLastNonEmptyLineIndex(lines: string[]): number {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index]?.trim()) {
      return index;
    }
  }
  return -1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFileNotFound(error: unknown): boolean {
  if (!isRecord(error)) {
    return false;
  }
  return error.code === "ENOENT";
}

import { mkdir, access } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { AgentMessage } from "@mariozechner/pi-agent-core";

export interface PersistedMessageRecord {
  schemaVersion: 1;
  sessionId: string;
  persistedAt: number;
  message: AgentMessage;
}

export interface SqliteMessageStoreConfig {
  sessionId: string;
  sessionDbPath: string;
}

export interface SqliteMessageStoreDeps {
  logger?: Pick<Console, "warn">;
  now?: () => number;
}

interface MessageRow {
  schema_version: number;
  session_id: string;
  persisted_at: number;
  message_json: string;
}

export class SqliteMessageStore {
  private readonly logger: Pick<Console, "warn">;
  private readonly now: () => number;

  constructor(
    private readonly config: SqliteMessageStoreConfig,
    deps: SqliteMessageStoreDeps = {}
  ) {
    this.logger = deps.logger ?? console;
    this.now = deps.now ?? (() => Date.now());
  }

  async readAll(): Promise<PersistedMessageRecord[]> {
    if (!(await fileExists(this.config.sessionDbPath))) {
      return [];
    }

    const db = this.openDatabase();
    try {
      this.ensureSchema(db);
      const rows = db.prepare(
        [
          "SELECT schema_version, session_id, persisted_at, message_json",
          "FROM messages",
          "WHERE session_id = ?",
          "ORDER BY id ASC",
        ].join(" ")
      ).all(this.config.sessionId) as unknown as MessageRow[];

      const records: PersistedMessageRecord[] = [];
      for (const [index, row] of rows.entries()) {
        const record = this.normalizeRow(row);
        if (!record) {
          this.logger.warn(
            `[message persistence] skipping invalid SQLite message row ${index + 1} in '${this.config.sessionDbPath}'`
          );
          continue;
        }
        records.push(record);
      }
      return records;
    } finally {
      db.close();
    }
  }

  async appendMessages(messages: AgentMessage[]): Promise<number> {
    if (messages.length === 0) {
      return 0;
    }

    await mkdir(dirname(this.config.sessionDbPath), { recursive: true });

    const db = this.openDatabase();
    try {
      this.ensureSchema(db);
      const insert = db.prepare(
        [
          "INSERT INTO messages",
          "(schema_version, session_id, persisted_at, message_json)",
          "VALUES (?, ?, ?, ?)",
        ].join(" ")
      );

      db.exec("BEGIN IMMEDIATE");
      try {
        for (const message of messages) {
          insert.run(
            1,
            this.config.sessionId,
            this.now(),
            JSON.stringify(message)
          );
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }

      return messages.length;
    } finally {
      db.close();
    }
  }

  private openDatabase(): DatabaseSync {
    return new DatabaseSync(this.config.sessionDbPath, {
      enableForeignKeyConstraints: true,
    });
  }

  private ensureSchema(db: DatabaseSync): void {
    db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        schema_version INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        persisted_at INTEGER NOT NULL,
        message_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_session_id_id
        ON messages(session_id, id);
    `);
  }

  private normalizeRow(row: MessageRow): PersistedMessageRecord | undefined {
    if (row.schema_version !== 1) {
      return undefined;
    }
    if (row.session_id !== this.config.sessionId) {
      return undefined;
    }
    if (!Number.isFinite(row.persisted_at)) {
      return undefined;
    }

    let message: unknown;
    try {
      message = JSON.parse(row.message_json);
    } catch {
      return undefined;
    }

    if (!isRecord(message)) {
      return undefined;
    }

    return {
      schemaVersion: 1,
      sessionId: row.session_id,
      persistedAt: row.persisted_at,
      message: message as unknown as AgentMessage,
    };
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (isFileNotFound(error)) {
      return false;
    }
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFileNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

import type { SerializedLogError } from "./types.js";

const SECRET_KEY_PATTERN = /(api[_-]?key|authorization|token|secret|password)/i;

export function serializeLogError(error: unknown, includeStack: boolean): SerializedLogError {
  if (error instanceof Error) {
    const serialized: SerializedLogError = {
      name: error.name,
      message: error.message,
    };
    const code = (error as Error & { code?: unknown }).code;
    if (typeof code === "string") {
      serialized.code = code;
    }
    if (includeStack && error.stack) {
      serialized.stack = error.stack;
    }
    return serialized;
  }

  return {
    message: stringifyUnknown(error),
  };
}

export function sanitizeLogData(value: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!value) {
    return undefined;
  }

  return sanitizeRecord(value);
}

function sanitizeRecord(record: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      sanitized[key] = "[redacted]";
      continue;
    }
    sanitized[key] = sanitizeValue(value);
  }
  return sanitized;
}

function sanitizeValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeValue(entry));
  }
  if (value instanceof Error) {
    return serializeLogError(value, false);
  }
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) {
    return {
      type: "Buffer",
      bytes: value.byteLength,
    };
  }
  if (typeof value === "object") {
    return sanitizeRecord(value as Record<string, unknown>);
  }
  return stringifyUnknown(value);
}

function stringifyUnknown(value: unknown): string {
  try {
    return String(value);
  } catch {
    return "[unprintable]";
  }
}

import { FsToolError, type FsErrorCode } from "./core.js";

export interface GlobMatcher {
  pattern: string;
  regex: RegExp;
}

export function compileGlobList(
  patterns: string[] | undefined,
  errorCode: FsErrorCode
): GlobMatcher[] {
  return (patterns ?? []).map((pattern) => compileGlobPattern(pattern, errorCode));
}

export function compileGlobPattern(pattern: string, errorCode: FsErrorCode): GlobMatcher {
  const trimmed = pattern.trim();
  if (!trimmed) {
    throw new FsToolError(errorCode, "Glob pattern cannot be empty.");
  }

  return {
    pattern: trimmed,
    regex: globToRegExp(trimmed, errorCode),
  };
}

export function matchGlob(relPath: string, isDirectory: boolean, matcher: GlobMatcher): boolean {
  const candidates = isDirectory ? [relPath, `${relPath}/`] : [relPath];
  return candidates.some((candidate) => matcher.regex.test(candidate));
}

export function matchAnyGlob(relPath: string, isDirectory: boolean, matchers: GlobMatcher[]): boolean {
  const candidates = isDirectory ? [relPath, `${relPath}/`] : [relPath];
  return matchers.some((matcher) => candidates.some((candidate) => matcher.regex.test(candidate)));
}

function globToRegExp(pattern: string, errorCode: FsErrorCode): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];
    const afterNext = pattern[index + 2];

    if (char === "\\") {
      if (next !== undefined) {
        source += escapeRegExp(next);
        index += 1;
      } else {
        source += "\\\\";
      }
      continue;
    }

    if (char === "*") {
      if (next === "*") {
        if (afterNext === "/") {
          source += "(?:[^/]+/)*";
          index += 2;
        } else {
          source += ".*";
          index += 1;
        }
      } else {
        source += "[^/]*";
      }
      continue;
    }

    if (char === "?") {
      source += "[^/]";
      continue;
    }

    if (char === "[") {
      const classEnd = findCharClassEnd(pattern, index + 1);
      if (classEnd === -1) {
        throw new FsToolError(errorCode, `Invalid glob pattern: ${pattern}`);
      }

      const rawClass = pattern.slice(index + 1, classEnd);
      source += buildCharClass(rawClass, pattern, errorCode);
      index = classEnd;
      continue;
    }

    source += escapeRegExp(char);
  }

  source += "$";

  try {
    return new RegExp(source);
  } catch {
    throw new FsToolError(errorCode, `Invalid glob pattern: ${pattern}`);
  }
}

function findCharClassEnd(pattern: string, start: number): number {
  for (let index = start; index < pattern.length; index += 1) {
    if (pattern[index] === "]" && pattern[index - 1] !== "\\") {
      return index;
    }
  }

  return -1;
}

function buildCharClass(rawClass: string, pattern: string, errorCode: FsErrorCode): string {
  if (rawClass.length === 0) {
    throw new FsToolError(errorCode, `Invalid glob pattern: ${pattern}`);
  }

  let negate = false;
  let body = rawClass;

  if (body[0] === "!" || body[0] === "^") {
    negate = true;
    body = body.slice(1);
  }

  if (body.length === 0) {
    throw new FsToolError(errorCode, `Invalid glob pattern: ${pattern}`);
  }

  const escaped = body.replace(/\\/g, "\\\\");
  return `[${negate ? "^" : ""}${escaped}]`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");
}

export type RuntimeCommandName =
  | "context"
  | "agent_state"
  | "inspect"
  | "inspect_all_on"
  | "inspect_all_off"
  | "inspect_tool_on"
  | "inspect_tool_off"
  | "inspect_thinking_on"
  | "inspect_thinking_off";

export interface ParsedRuntimeCommand {
  name: RuntimeCommandName;
  raw: string;
  source: "leading" | "trailing";
}

export interface RuntimeCommandParseResult {
  commands: ParsedRuntimeCommand[];
  remainingText: string;
  unknownCommandTexts: string[];
}

const COMMAND_NAMES: ReadonlySet<RuntimeCommandName> = new Set([
  "context",
  "agent_state",
  "inspect",
  "inspect_all_on",
  "inspect_all_off",
  "inspect_tool_on",
  "inspect_tool_off",
  "inspect_thinking_on",
  "inspect_thinking_off",
]);

interface Token {
  text: string;
}

export function parseRuntimeCommands(text: string): RuntimeCommandParseResult {
  const tokens = tokenize(text);
  const commands: ParsedRuntimeCommand[] = [];
  const unknownCommandTexts: string[] = [];
  const recognizedIndexes = new Set<number>();

  const leadingEnd = scanLeadingCommandRegion(tokens);
  for (let index = 0; index < leadingEnd; index += 1) {
    inspectToken(tokens[index], "leading", index);
  }

  const trailingStart = scanTrailingCommandRegion(tokens, leadingEnd);
  for (let index = trailingStart; index < tokens.length; index += 1) {
    inspectToken(tokens[index], "trailing", index);
  }

  return {
    commands,
    remainingText: rebuildRemainingText(text, tokens, recognizedIndexes),
    unknownCommandTexts,
  };

  function inspectToken(token: Token, source: "leading" | "trailing", index: number): void {
    const normalized = normalizeCommandToken(token.text);
    if (normalized && COMMAND_NAMES.has(normalized)) {
      commands.push({ name: normalized, raw: token.text, source });
      recognizedIndexes.add(index);
      return;
    }

    if (isSlashCommandToken(token.text)) {
      unknownCommandTexts.push(token.text);
    }
  }
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const tokenPattern = /\S+/g;
  let match: RegExpExecArray | null;
  while ((match = tokenPattern.exec(text)) !== null) {
    tokens.push({
      text: match[0],
    });
  }
  return tokens;
}

function scanLeadingCommandRegion(tokens: Token[]): number {
  let index = 0;
  while (index < tokens.length && isSlashCommandToken(tokens[index].text)) {
    index += 1;
  }
  return index;
}

function scanTrailingCommandRegion(tokens: Token[], leadingEnd: number): number {
  let index = tokens.length - 1;
  while (index >= leadingEnd && isSlashCommandToken(tokens[index].text)) {
    index -= 1;
  }
  return index + 1;
}

function rebuildRemainingText(
  original: string,
  tokens: Token[],
  recognizedIndexes: ReadonlySet<number>
): string {
  const parts: string[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    if (!recognizedIndexes.has(index)) {
      parts.push(tokens[index].text);
    }
  }

  if (parts.length === tokens.length) {
    return original.trim();
  }
  return parts.join(" ").trim();
}

function normalizeCommandToken(token: string): RuntimeCommandName | null {
  if (!isSlashCommandToken(token)) {
    return null;
  }

  const commandBody = token.slice(1).split("@", 1)[0];
  if (COMMAND_NAMES.has(commandBody as RuntimeCommandName)) {
    return commandBody as RuntimeCommandName;
  }
  return null;
}

function isSlashCommandToken(token: string): boolean {
  return /^\/[A-Za-z0-9_]+(?:@[A-Za-z0-9_]+)?$/.test(token);
}

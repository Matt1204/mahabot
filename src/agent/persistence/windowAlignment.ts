import type { AgentMessage } from "@mariozechner/pi-agent-core";

/**
 * A turn end is an assistant message followed by either:
 * - no next message, or
 * - a user message (next user turn starts).
 */
export function findLastAssistantTurnEndIndex(
  messages: AgentMessage[],
  beforeExclusive = messages.length
): number {
  const maxIndex = Math.min(beforeExclusive, messages.length) - 1;
  for (let index = maxIndex; index >= 0; index -= 1) {
    if (isAssistantTurnEndAt(messages, index)) {
      return index;
    }
  }
  return -1;
}

export function buildStartupRestoreWindow(
  messages: AgentMessage[],
  startupRestoreMessageCount: number
): AgentMessage[] {
  return buildAlignedTailWindow(messages, startupRestoreMessageCount);
}

export function buildAlignedTailWindow(messages: AgentMessage[], softTargetCount: number): AgentMessage[] {
  if (messages.length === 0) {
    return [];
  }

  const end = findLastAssistantTurnEndIndex(messages);
  if (end < 0) {
    return [];
  }

  const boundedTargetCount = Math.max(1, Math.floor(softTargetCount));
  const targetStart = Math.max(0, end - boundedTargetCount + 1);
  const start = alignStartToTurnBoundary(messages, targetStart, end);

  if (start < 0 || start > end) {
    return [];
  }

  return messages.slice(start, end + 1);
}

function alignStartToTurnBoundary(messages: AgentMessage[], targetStart: number, end: number): number {
  const boundedTargetStart = clamp(targetStart, 0, end);
  let previousTurnEnd = -1;

  for (let index = 0; index <= end; index += 1) {
    if (!isAssistantTurnEndAt(messages, index)) {
      continue;
    }

    const turnStart = previousTurnEnd + 1;
    if (index >= boundedTargetStart) {
      return preferUserStart(messages, turnStart, index);
    }

    previousTurnEnd = index;
  }

  return -1;
}

function preferUserStart(messages: AgentMessage[], start: number, end: number): number {
  if (getRole(messages[start]) === "user") {
    return start;
  }

  for (let index = start; index <= end; index += 1) {
    if (getRole(messages[index]) === "user") {
      return index;
    }
  }

  return start;
}

// if message itself is assistant message, and next message is empty or user message => it's a turn end
function isAssistantTurnEndAt(messages: AgentMessage[], index: number): boolean {
  if (index < 0 || index >= messages.length) {
    return false;
  }

  if (getRole(messages[index]) !== "assistant") {
    return false;
  }

  const nextMessage = messages[index + 1];
  return !nextMessage || getRole(nextMessage) === "user";
}

function getRole(message: AgentMessage | undefined): string | undefined {
  return (message as { role?: string } | undefined)?.role;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

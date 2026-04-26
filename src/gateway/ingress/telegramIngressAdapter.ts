import { createBusMessageId } from "../../messageBus/id.js";
import type { MessageBus, UserToAgentPart } from "../../messageBus/types.js";

export interface PublishTelegramUserMessageInput {
  bus: MessageBus;
  sessionId: string;
  text: string;
  chatId: string;
  userId: string;
  username?: string;
  firstName?: string;
  lastName?: string;
  now?: () => number;
}

export interface PublishTelegramUserPartsInput {
  bus: MessageBus;
  sessionId: string;
  parts: UserToAgentPart[];
  chatId: string;
  userId: string;
  username?: string;
  firstName?: string;
  lastName?: string;
  voice?: {
    transcriptModel: string;
    duration?: number;
    mimeType?: string;
    fileSize?: number;
  };
  now?: () => number;
}

/**
 * Converts Telegram text input into a normalized user_to_agent envelope.
 * Returns true when one envelope was published; false when input is empty after trim.
 */
export function publishTelegramUserMessage(input: PublishTelegramUserMessageInput): boolean {
  const trimmed = input.text.trim();
  if (!trimmed) {
    return false;
  }

  return publishTelegramUserParts({
    ...input,
    parts: [{ type: "text", text: trimmed, origin: "telegram_text" }],
  });
}

export function publishTelegramUserParts(input: PublishTelegramUserPartsInput): boolean {
  const now = input.now ?? (() => Date.now());
  const parts = normalizeParts(input.parts);
  if (parts.length === 0) {
    return false;
  }

  input.bus.publish({
    id: createBusMessageId(now),
    sessionId: input.sessionId,
    ts: now(),
    direction: "user_to_agent",
    source: "telegram",
    kind: "ui.user_message",
    priority: "high",
    payload: {
      parts,
    },
    renderHints: {
      style: "primary",
      prefix: "you",
    },
    meta: buildTelegramMeta(input),
  });

  return true;
}

function buildTelegramMeta(input: PublishTelegramUserPartsInput): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    telegram: {
      chatId: input.chatId,
      userId: input.userId,
      username: input.username,
      firstName: input.firstName,
      lastName: input.lastName,
    },
  };

  if (input.voice) {
    meta.voice = input.voice;
  }

  return meta;
}

function normalizeParts(parts: UserToAgentPart[]): UserToAgentPart[] {
  const normalized: UserToAgentPart[] = [];

  for (const part of parts) {
    if (part.type === "text") {
      const text = part.text.trim();
      if (text) {
        normalized.push({ ...part, text });
      }
      continue;
    }

    normalized.push(part);
  }

  return normalized;
}

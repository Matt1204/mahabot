import { createBusMessageId } from "../../messageBus/id.js";
import type { MessageBus } from "../../messageBus/types.js";

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

/**
 * Converts Telegram text input into a normalized user_to_agent envelope.
 * Returns true when one envelope was published; false when input is empty after trim.
 */
export function publishTelegramUserMessage(input: PublishTelegramUserMessageInput): boolean {
  const now = input.now ?? (() => Date.now());
  const trimmed = input.text.trim();
  if (!trimmed) {
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
      parts: [{ type: "text", text: trimmed }],
    },
    renderHints: {
      style: "primary",
      prefix: "you",
    },
    meta: {
      telegram: {
        chatId: input.chatId,
        userId: input.userId,
        username: input.username,
        firstName: input.firstName,
        lastName: input.lastName,
      },
    },
  });

  return true;
}

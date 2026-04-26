import { createBusMessageId } from "../../messageBus/id.js";
import type { MessageBus } from "../../messageBus/types.js";

export interface PublishCliUserMessageInput {
  bus: MessageBus;
  sessionId: string;
  text: string;
  now?: () => number;
}

/**
 * Converts raw CLI text input into a normalized user_to_agent envelope.
 */
export function publishCliUserMessage(input: PublishCliUserMessageInput): void {
  const now = input.now ?? (() => Date.now());
  const trimmed = input.text.trim();
  if (!trimmed) {
    return;
  }

  input.bus.publish({
    id: createBusMessageId(now),
    sessionId: input.sessionId,
    ts: now(),
    direction: "user_to_agent",
    source: "cli",
    kind: "ui.user_message",
    priority: "high",
    payload: {
      parts: [{ type: "text", text: trimmed }],
    },
    renderHints: {
      style: "primary",
      prefix: "you",
    },
  });
}

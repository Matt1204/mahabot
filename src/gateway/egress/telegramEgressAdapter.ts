import type { AgentToUserPayload, MessageBus } from "../../messageBus/types.js";
import { formatMarkdownForTelegram } from "./telegramTextFormatter.js";

const TELEGRAM_MAX_MESSAGE_CHARS = 4096;
const TELEGRAM_SAFE_MESSAGE_CHARS = 3900;

export interface TelegramSendOptions {
  parse_mode?: "HTML";
  link_preview_options?: {
    is_disabled: boolean;
  };
}

export interface TelegramSendClient {
  sendMessage: (chatId: string, text: string, options?: TelegramSendOptions) => Promise<unknown>;
}

export interface CreateTelegramEgressRelayInput {
  bus: MessageBus;
  sessionId: string;
  chatId: string;
  client: TelegramSendClient;
  logger?: Pick<Console, "warn">;
}

/**
 * Relays agent_to_user envelopes for one session into Telegram chat messages.
 */
export function createTelegramEgressRelay(input: CreateTelegramEgressRelayInput): () => void {
  const logger = input.logger ?? console;

  return input.bus.subscribe(
    (envelope) => {
      if (envelope.direction !== "agent_to_user") {
        return;
      }

      const payload = envelope.payload as AgentToUserPayload;
      const text = payload.text;
      if (!text) {
        return;
      }

      const formatted = formatMarkdownForTelegram(text);
      void sendFormattedWithPlainTextFallback(input.client, input.chatId, text, formatted)
        .catch((error) => {
          logger.warn?.(`[telegram-egress] sendMessage failed: ${String(error)}`);
        });
    },
    {
      direction: "agent_to_user",
      sessionId: input.sessionId,
    }
  );
}

async function sendFormattedWithPlainTextFallback(
  client: TelegramSendClient,
  chatId: string,
  originalText: string,
  formatted: ReturnType<typeof formatMarkdownForTelegram>
): Promise<void> {
  try {
    for (const chunk of splitTelegramMessage(formatted.text)) {
      await client.sendMessage(chatId, chunk, {
        parse_mode: formatted.parseMode,
        link_preview_options: {
          is_disabled: true,
        },
      });
    }
  } catch {
    for (const chunk of splitTelegramMessage(originalText)) {
      await client.sendMessage(chatId, chunk);
    }
  }
}

export function splitTelegramMessage(
  text: string,
  maxChars = TELEGRAM_SAFE_MESSAGE_CHARS
): string[] {
  const normalizedMaxChars = Math.min(
    Math.max(1, maxChars),
    TELEGRAM_MAX_MESSAGE_CHARS
  );
  if (text.length <= normalizedMaxChars) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > normalizedMaxChars) {
    const splitAt = findSplitIndex(remaining, normalizedMaxChars);
    const chunk = remaining.slice(0, splitAt).trimEnd();
    if (chunk) {
      chunks.push(chunk);
    }
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}

function findSplitIndex(text: string, maxChars: number): number {
  const searchWindow = text.slice(0, maxChars + 1);
  const paragraphBreak = searchWindow.lastIndexOf("\n\n");
  if (paragraphBreak > 0) {
    return paragraphBreak + 2;
  }

  const lineBreak = searchWindow.lastIndexOf("\n");
  if (lineBreak > 0) {
    return lineBreak + 1;
  }

  const sentenceBreak = Math.max(
    searchWindow.lastIndexOf("。"),
    searchWindow.lastIndexOf(". "),
    searchWindow.lastIndexOf("! "),
    searchWindow.lastIndexOf("? ")
  );
  if (sentenceBreak > 0) {
    return sentenceBreak + 1;
  }

  const space = searchWindow.lastIndexOf(" ");
  if (space > 0) {
    return space + 1;
  }

  return maxChars;
}

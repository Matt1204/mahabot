import type { AgentToUserPayload, MessageBus } from "../../messageBus/types.js";
import { formatMarkdownForTelegram } from "./telegramTextFormatter.js";

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
    await client.sendMessage(chatId, formatted.text, {
      parse_mode: formatted.parseMode,
      link_preview_options: {
        is_disabled: true,
      },
    });
  } catch {
    await client.sendMessage(chatId, originalText);
  }
}

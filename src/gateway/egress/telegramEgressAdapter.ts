import type { AgentToUserPayload, MessageBus } from "../../messageBus/types.js";

export interface TelegramSendClient {
  sendMessage: (chatId: string, text: string) => Promise<unknown>;
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

      void input.client.sendMessage(input.chatId, text).catch((error) => {
        logger.warn?.(`[telegram-egress] sendMessage failed: ${String(error)}`);
      });
    },
    {
      direction: "agent_to_user",
      sessionId: input.sessionId,
    }
  );
}

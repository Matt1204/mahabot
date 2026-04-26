export interface EvaluateTelegramIngressInput {
  activeChatId: string | null;
  chatId: string;
  userId: string;
  allowedUserIds: ReadonlySet<string>;
}

export type TelegramIngressDecision =
  | { type: "reject_not_whitelisted" }
  | { type: "reject_other_chat"; activeChatId: string }
  | { type: "accept_activate" }
  | { type: "accept_existing" };

/**
 * V1 policy:
 * - whitelist by user id
 * - one active chat per process run
 */
export function evaluateTelegramIngress(input: EvaluateTelegramIngressInput): TelegramIngressDecision {
  const normalizedUserId = input.userId.trim();
  if (!input.allowedUserIds.has(normalizedUserId)) {
    return { type: "reject_not_whitelisted" };
  }

  if (!input.activeChatId) {
    return { type: "accept_activate" };
  }

  if (input.activeChatId === input.chatId) {
    return { type: "accept_existing" };
  }

  return {
    type: "reject_other_chat",
    activeChatId: input.activeChatId,
  };
}

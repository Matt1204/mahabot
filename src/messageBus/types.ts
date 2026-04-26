export type MessageDirection = "user_to_agent" | "agent_to_user";
export type MessagePriority = "high" | "normal" | "low";

export type UserToAgentPart =
  | {
      type: "text";
      text: string;
      origin?: "cli" | "telegram_text" | "telegram_voice_transcript";
    }
  | {
      type: "image";
      source: "local_file";
      path: string;
      mimeType: string;
      caption?: string;
      width?: number;
      height?: number;
      telegram?: {
        fileId: string;
        fileUniqueId: string;
        messageId: number;
        mediaGroupId?: string;
      };
    };

export interface UserToAgentPayload {
  parts: UserToAgentPart[];
}

export interface AgentToUserPayload {
  text: string;
  format?: "plain" | "markdown";
  raw?: Record<string, unknown>;
}

export type MessageKind =
  | "ui.user_message"
  | "agent.assistant_message"
  | "agent.runtime.event"
  | "agent.runtime.token_usage"
  | "agent.runtime.inflight_update"
  | "agent.runtime.thinking";

export interface BusEnvelope<TPayload> {
  id: string;
  sessionId: string;
  ts: number;
  direction: MessageDirection;
  source: string;
  kind: MessageKind;
  priority: MessagePriority;
  payload: TPayload;
  renderHints?: {
    style?: "primary" | "secondary" | "dim";
    prefix?: string;
  };
  meta?: Record<string, unknown>;
}

export type AnyBusEnvelope = BusEnvelope<UserToAgentPayload | AgentToUserPayload>;

export interface MessageBusSubscriptionFilter {
  direction?: MessageDirection;
  kinds?: MessageKind[];
  sessionId?: string;
}

export type MessageBusSubscriptionHandler = (envelope: AnyBusEnvelope) => void;

export interface MessageBus {
  publish(envelope: AnyBusEnvelope): void;
  getUserMsgFromBus(
    sessionId: string,
    signal?: AbortSignal
  ): Promise<BusEnvelope<UserToAgentPayload>>;
  subscribe(
    handler: MessageBusSubscriptionHandler,
    filter?: MessageBusSubscriptionFilter
  ): () => void;
  getQueues(): {
    ingressQueue: ReadonlyArray<BusEnvelope<UserToAgentPayload>>;
    assistantEgressQueue: ReadonlyArray<BusEnvelope<AgentToUserPayload>>;
    statusEgressQueue: ReadonlyArray<BusEnvelope<AgentToUserPayload>>;
  };
}

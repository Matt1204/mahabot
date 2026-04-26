export type AgentRuntimeStatusKind =
  | "agent.runtime.event"
  | "agent.runtime.token_usage"
  | "agent.runtime.inflight_update"
  | "agent.runtime.thinking";

export type AgentRuntimeStatusPriority = "high" | "normal" | "low";

export interface AgentRuntimeStatusMessage {
  kind: AgentRuntimeStatusKind;
  text: string;
  source?: string;
  priority?: AgentRuntimeStatusPriority;
  raw?: Record<string, unknown>;
  renderHints?: {
    style?: "primary" | "secondary" | "dim";
    prefix?: string;
  };
  meta?: Record<string, unknown>;
}

export type AgentRuntimeStatusPublisher = (message: AgentRuntimeStatusMessage) => void;

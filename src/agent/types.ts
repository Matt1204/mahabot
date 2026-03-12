import type { AgentMessage, AgentTool, ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { Model } from "@mariozechner/pi-ai";

export type Channel = "cli" | "telegram" | "unknown";

export interface InboundMessageTemp {
  id: string;
  channel: Channel;
  chatId: string;
  userId: string;
  text: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export interface OutboundMessageTemp {
  id: string;
  channel: Channel;
  chatId: string;
  text: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export interface MemoryBundle {
  shortTermMessages: AgentMessage[];
  longTermSummary?: string;
  systemPromptAddendum?: string;
}

export interface AgentRuntimeConfig {
  model: Model<any>;
  systemPrompt: string;
  thinkingLevel: ThinkingLevel;
  tools: AgentTool<any>[];
  sessionId?: string;
  transport?: "sse" | "websocket" | "auto";
  maxRetryDelayMs?: number;
  thinkingBudgets?: Record<string, number>;
  convertToLlm?: (messages: AgentMessage[]) => Promise<any[]> | any[];
  transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
  onPayload?: (payload: unknown) => unknown;
}

export interface AgentDependencies {
  inboundSource?: (signal?: AbortSignal) => Promise<InboundMessageTemp | null>;
  outboundSink?: (message: OutboundMessageTemp) => Promise<void> | void;
  memoryAssembler?: (input: InboundMessageTemp) => Promise<MemoryBundle>;
  logger?: Pick<Console, "debug" | "info" | "warn" | "error">;
  now?: () => number;
  onAgentEvent?: (event: unknown) => void;
}

export interface CliTurnResult {
  inbound: InboundMessageTemp;
  outbound: OutboundMessageTemp | null;
  cliMessage: string;
}

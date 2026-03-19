import type { AgentEvent, AgentMessage, AgentTool, ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { Model } from "@mariozechner/pi-ai";
import type { AppConfig } from "../config/types.js";
import { ToolRegistry } from "./tools/registry/toolRegistry.js";

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
  // tools: AgentTool<any>[];
  toolRegistry: ToolRegistry;
  sessionId?: string;
  transport?: "sse" | "websocket" | "auto";
  maxRetryDelayMs?: number;
  thinkingBudgets?: Record<string, number>;
  convertToLlm?: (messages: AgentMessage[]) => Promise<any[]> | any[];
  transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
  onPayload?: (payload: unknown) => unknown;
}

export interface AgentFromAppConfigInput {
  appConfig: AppConfig;
  providerName: string;
  modelName: string;
  systemPrompt: string;
  thinkingLevel: ThinkingLevel;
  toolRegistry?: ToolRegistry;
  ensureProviderCredentials?: (providerName: string) => void;
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
}

export interface AgentDependencies {
  inboundSource?: (signal?: AbortSignal) => Promise<InboundMessageTemp | null>;
  outboundSink?: (message: OutboundMessageTemp) => Promise<void> | void;
  memoryAssembler?: (input: InboundMessageTemp) => Promise<MemoryBundle>;
  logger?: Pick<Console, "debug" | "info" | "warn" | "error">;
  now?: () => number;
  onAgentEvent?: (event: AgentEvent) => void;
}

export interface CliTurnResult {
  inbound: InboundMessageTemp;
  outbound: OutboundMessageTemp | null;
  cliMessage: string;
}

export type IngressProvider = "telegram";

export interface TelegramIngressConfig {
  enabled: boolean;
  botTokenEnvVar: string;
  allowedChatIds: string[];
}

export interface IngressConfig {
  telegram: TelegramIngressConfig;
}

export interface LlmProviderConfig {
  provider: string;
  models: string[];
  enabled: boolean;
  apiKeyEnvVar?: string;
  baseUrl?: string;
  organization?: string;
  category?: "openai" | "anthropic" | "google" | "openrouter";
}

export interface AgentConfig {
  defaultProvider: string;
  defaultModel: string;
  systemPromptFile: string;
  workspaceRoot: string;
  memoryWindow: number;
  maxTokens: number;
  thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  llmProviders: LlmProviderConfig[];
}

export interface McpServerConfig {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  enabled: boolean;
}

export interface ToolsConfig {
  restrictToWorkspace: boolean;
  mcpServers: McpServerConfig[];
}

export interface EventInspectionIncludeConfig {
  agent_start: boolean;
  agent_end: boolean;
  turn_start: boolean;
  turn_end: boolean;
  message_start: boolean;
  message_update: boolean;
  message_end: boolean;
  tool_execution_start: boolean;
  tool_execution_update: boolean;
  tool_execution_end: boolean;
}

export interface EventInspectionConfig {
  useEventInspection: boolean;
  showTokenUsage: boolean;
  include: EventInspectionIncludeConfig;
}

export interface AppConfig {
  schemaVersion: number;
  ingress: IngressConfig;
  agent: AgentConfig;
  tools: ToolsConfig;
  eventInspection: EventInspectionConfig;
}

export const DEFAULT_CONFIG: AppConfig = {
  schemaVersion: 1,
  ingress: {
    telegram: {
      enabled: false,
      botTokenEnvVar: "TELEGRAM_BOT_TOKEN",
      allowedChatIds: [],
    },
  },
  agent: {
    defaultProvider: "openai",
    defaultModel: "gpt-4o-mini",
    systemPromptFile: "AGENTS.md",
    workspaceRoot: ".",
    memoryWindow: 50,
    maxTokens: 4096,
    thinkingLevel: "off",
    llmProviders: [
      {
        provider: "openai",
        models: ["gpt-4o-mini"],
        enabled: true,
        apiKeyEnvVar: "OPENAI_API_KEY",
      },
    ],
  },
  tools: {
    restrictToWorkspace: true,
    mcpServers: [],
  },
  eventInspection: {
    useEventInspection: false,
    showTokenUsage: false,
    include: {
      agent_start: false,
      agent_end: false,
      turn_start: false,
      turn_end: false,
      message_start: false,
      message_update: false,
      message_end: false,
      tool_execution_start: false,
      tool_execution_update: false,
      tool_execution_end: false,
    },
  },
};

import type { AgentMessage } from "@mariozechner/pi-agent-core";

import type { Channel, InboundMessageTemp, MemoryBundle, OutboundMessageTemp } from "../types.js";

export function wrapToInboundMessageTemp(
  cliMessage: string,
  now: () => number,
  channel: Channel = "cli",
  chatId = "local",
  userId = "cli-user"
): InboundMessageTemp {
  return {
    id: `in_${now()}`,
    channel,
    chatId,
    userId,
    text: cliMessage,
    timestamp: now(),
    metadata: { source: "cli_temp" },
  };
}

export function toAgentMessages(input: InboundMessageTemp, memory: MemoryBundle): AgentMessage[] {
  const messages: AgentMessage[] = [...memory.shortTermMessages];

  if (memory.longTermSummary) {
    messages.push({
      role: "user",
      content: [
        {
          type: "text",
          text: `Long-term memory summary:\n${memory.longTermSummary}`,
        },
      ],
      timestamp: input.timestamp,
    } as AgentMessage);
  }

  messages.push({
    role: "user",
    content: [{ type: "text", text: input.text }],
    timestamp: input.timestamp,
  } as AgentMessage);

  return messages;
}

export function parseAgentResponseToOutboundTemp(
  assistantMessage: AgentMessage,
  sourceInbound: InboundMessageTemp,
  now: () => number
): OutboundMessageTemp {
  return {
    id: `out_${now()}`,
    channel: sourceInbound.channel,
    chatId: sourceInbound.chatId,
    text: extractTextForHuman(assistantMessage),
    timestamp: now(),
    metadata: {
      sourceInboundId: sourceInbound.id,
      source: "agent_loop",
    },
  };
}

export function parseToMsgForCliTemp(outbound: OutboundMessageTemp | null): string {
  if (!outbound) {
    return "[agent] No outbound message produced.";
  }
  return outbound.text;
}

export function extractTextForHuman(message: AgentMessage): string {
  const anyMessage = message as any;
  const content = anyMessage?.content;

  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    const textParts = content
      .filter((block) => block && block.type === "text" && typeof block.text === "string")
      .map((block) => block.text.trim())
      .filter((part) => part.length > 0);

    if (textParts.length > 0) {
      return textParts.join("\n");
    }

    const toolCalls = content.filter((block) => block && block.type === "toolCall");
    if (toolCalls.length > 0) {
      return `[agent] Assistant requested ${toolCalls.length} tool call(s).`;
    }

    // Thinking blocks are internal reasoning content and should not be shown
    // as user-facing assistant output in CLI.
  }

  return "[agent] Assistant returned no text.";
}

import { readFile } from "node:fs/promises";
import type { AgentMessage } from "@mariozechner/pi-agent-core";

import type { Channel, InboundMessageTemp, MemoryBundle, OutboundMessageTemp } from "../types.js";
import type { UserToAgentPart } from "../../messageBus/types.js";

interface AgentMessageMappingOptions {
  supportsImageInput?: boolean;
  readFileBytes?: (path: string) => Promise<Uint8Array>;
}

export function wrapToInboundMessageTemp(
  cliMessage: string,
  now: () => number,
  channel: Channel = "cli",
  chatId = "local",
  userId = "cli-user"
): InboundMessageTemp {
  const timestamp = now();
  return {
    id: `in_${timestamp}`,
    channel,
    chatId,
    userId,
    text: cliMessage,
    parts: [{ type: "text", text: cliMessage, origin: channel === "telegram" ? "telegram_text" : "cli" }],
    timestamp,
    metadata: { source: "cli_temp" },
  };
}

export function wrapPartsToInboundMessageTemp(
  parts: UserToAgentPart[],
  now: () => number,
  channel: Channel = "cli",
  chatId = "local",
  userId = "cli-user",
  metadata?: Record<string, unknown>
): InboundMessageTemp {
  const timestamp = now();
  return {
    id: `in_${timestamp}`,
    channel,
    chatId,
    userId,
    text: partsToTextSummary(parts),
    parts,
    timestamp,
    metadata: {
      source: "structured_turn",
      ...metadata,
    },
  };
}

export async function toAgentMessages(
  input: InboundMessageTemp,
  memory: MemoryBundle,
  options: AgentMessageMappingOptions = {}
): Promise<AgentMessage[]> {
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

  const content = await toUserContentBlocks(input.parts, options);

  messages.push({
    role: "user",
    content,
    timestamp: input.timestamp,
  } as unknown as AgentMessage);

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

async function toUserContentBlocks(
  parts: UserToAgentPart[],
  options: AgentMessageMappingOptions
): Promise<Array<Record<string, unknown>>> {
  const content: Array<Record<string, unknown>> = [];
  const readFileBytes = options.readFileBytes ?? ((path: string) => readFile(path));
  const hasImage = parts.some((part) => part.type === "image");

  if (hasImage && options.supportsImageInput === false) {
    throw new Error("Current model does not support image input. Configure a vision-capable model first.");
  }

  for (const part of parts) {
    if (part.type === "text") {
      const text = part.text.trim();
      if (text) {
        content.push({ type: "text", text });
      }
      continue;
    }

    const caption = part.caption?.trim();
    if (caption) {
      content.push({ type: "text", text: `Image caption: ${caption}` });
    }

    const bytes = await readFileBytes(part.path);
    const data = Buffer.from(bytes).toString("base64");
    content.push({
      type: "image",
      data,
      mimeType: part.mimeType,
      sourcePath: part.path,
    });
  }

  if (content.length === 0) {
    content.push({ type: "text", text: inputFallbackText(parts) });
  }

  return content;
}

function partsToTextSummary(parts: UserToAgentPart[]): string {
  const lines: string[] = [];

  for (const part of parts) {
    if (part.type === "text") {
      lines.push(part.text);
      continue;
    }
    lines.push(`[image] ${part.path}`);
  }

  return lines.join("\n").trim();
}

function inputFallbackText(parts: UserToAgentPart[]): string {
  return parts.length === 0 ? "" : "[user sent an empty structured message]";
}

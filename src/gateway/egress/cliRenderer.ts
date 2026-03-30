import { stdout } from "node:process";

import type { AgentToUserPayload, AnyBusEnvelope, MessageBus } from "../../messageBus/types.js";

export interface CreateCliRendererInput {
  bus: MessageBus;
  sessionId: string;
  output: { write: (chunk: string) => unknown };
}

/**
 * Subscribes CLI output to agent_to_user envelopes for one session.
 * The renderer is intentionally minimal in this iteration: it prints payload.text directly.
 */
export function createCliRenderer(input: CreateCliRendererInput): () => void {
  const { bus, sessionId, output } = input;
  const ansi = shouldUseAnsi();

  return bus.subscribe(
    (envelope) => {
      if (envelope.direction !== "agent_to_user") {
        return;
      }

      const payload = envelope.payload as AgentToUserPayload;
      const text = payload.text;
      if (envelope.kind === "agent.assistant_message") {
        output.write(renderAssistantLine(text, ansi));
        return;
      }

      output.write(renderRuntimeStatusLine(envelope, text, ansi));
    },
    {
      direction: "agent_to_user",
      sessionId,
    }
  );
}

function shouldUseAnsi(): boolean {
  if (process.env.NO_COLOR !== undefined) {
    return false;
  }
  if (process.env.FORCE_COLOR === "0") {
    return false;
  }
  return stdout.isTTY === true;
}

function renderAssistantLine(text: string, ansi: boolean): string {
  if (!ansi) {
    return `bot> ${text}\n\n`;
  }
  return `\x1b[1;94mbot> ${text}\x1b[0m\n\n`;
}

function renderRuntimeStatusLine(envelope: AnyBusEnvelope, text: string, ansi: boolean): string {
  if (!ansi) {
    return `${text}\n`;
  }

  if (envelope.kind === "agent.runtime.thinking") {
    // Keep thinking in the same blue family as assistant output, but visually softer.
    return `\x1b[2;34m${text}\x1b[0m\n`;
  }

  const style = envelope.renderHints?.style;
  if (style === "primary") {
    return `\x1b[1m${text}\x1b[0m\n`;
  }
  if (style === "secondary") {
    return `\x1b[2;36m${text}\x1b[0m\n`;
  }
  // dim/default runtime status (event/token/inflight_update)
  return `\x1b[2;90m${text}\x1b[0m\n`;
}

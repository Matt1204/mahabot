import { stdin as input, stdout as output } from "node:process";
import readline from "node:readline/promises";

import { Agent } from "../agent/index.js";
import { ConfigManager, createModelFromConfig } from "../config/index.js";
import type { LlmProviderConfig } from "../config/types.js";
import type { Model } from "@mariozechner/pi-ai";
/**
 * Future gateway/external manager entrypoint.
 *
 * Current implementation:
 * - `mahabot cli` interactive mode
 * Future scope:
 * - message bus ingestion
 * - telegram/webhook ingress
 * - external transport orchestration
 */
export class MahabotGatewayManager {
  constructor(
    private readonly configManager: ConfigManager = new ConfigManager(),
    private readonly io = { input, output },
  ) {}

  async runInCliMode(llmProvider?: string, modelId?: string): Promise<void> {
    await this.configManager.load();

    // Create model with optional override parameters (falls back to defaults if not provided)
    const model: Model<any> = createModelFromConfig(
      this.configManager.get(),
      llmProvider,
      modelId,
    );
    // Validate credentials exist for the resolved provider (does not expose API key to memory)
    this.configManager.ensureProviderCredentials(model.provider);

    const systemPrompt = "You are mahabot CLI assistant. Be concise and practical.";

    const agent = new Agent(
      {
        model,
        systemPrompt,
        thinkingLevel: this.configManager.getThinkingLevel(),
        tools: [],
        getApiKey: (p) =>
          this.configManager.getApiKeyForProvider(
            this.configManager.getTargetProviderConfig(p) as any,
          ),
        sessionId: "cli-session",
        transport: "sse",
        maxRetryDelayMs: 15000,
      },
      {
        // CLI prints final assistant text itself; suppress noisy event logs.
        logger: {
          debug: () => {},
          info: () => {},
          warn: console.warn,
          error: console.error,
        },
        outboundSink: async () => {
          // keep outbound in-process for CLI mode
        },
      },
    );

    const rl = readline.createInterface({
      input: this.io.input,
      output: this.io.output,
      terminal: true,
    });

    this.io.output.write("mahabot CLI mode started. Type /exit to quit.\n\n");

    try {
      while (true) {
        const line = (await rl.question("you> ")).trim();

        if (!line) {
          continue;
        }

        if (isExitCommand(line)) {
          this.io.output.write("Bye.\n");
          break;
        }

        if (line === "/help") {
          this.io.output.write(helpText());
          continue;
        }

        if (line === "/clear") {
          // reset keeps model/tools/system prompt, but clears message history and queues.
          agent.reset();
          this.io.output.write("Conversation context cleared.\n\n");
          continue;
        }

        try {
          const result = await agent.runCliTurn(line);
          this.io.output.write(`bot> ${result.cliMessage}\n\n`);
        } catch (error) {
          this.io.output.write(`bot> [error] ${String(error)}\n\n`);
        }
      }
    } finally {
      rl.close();
      await agent.waitForIdle();
    }
  }
}

function isExitCommand(line: string): boolean {
  const normalized = line.toLowerCase();
  return (
    normalized === "exit" ||
    normalized === "quit" ||
    normalized === "/exit" ||
    normalized === ":q"
  );
}

function helpText(): string {
  return [
    "Commands:",
    "  /help  Show this help",
    "  /clear Clear conversation context",
    "  /exit  Exit CLI mode",
    "",
  ].join("\n");
}

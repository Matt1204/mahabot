import { stdin as input, stdout as output } from "node:process";
import readline from "node:readline/promises";

import { Agent } from "../agent/index.js";
import { ConfigManager } from "../config/index.js";
import { ContextManager } from "../context/index.js";

const DEMO_SESSION_ID = "cli-stable-session";
const DEMO_PROVIDER_NAME = "microsoft-foundry";
const DEMO_MODEL_NAME = "gpt-5.3-chat";
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
  private readonly contextManager: ContextManager;

  constructor(
    private readonly configManager: ConfigManager = new ConfigManager(),
    private readonly io = { input, output },
  ) {
    this.contextManager = new ContextManager(this.configManager, {
      debug: () => {},
      warn: console.warn,
      error: console.error,
    });
  }

  async runInCliMode(): Promise<void> {
    const bootstrap = await this.configManager.initializeSessionWorkspace(DEMO_SESSION_ID);

    if (bootstrap.isFirstConfigCreated) {
      this.io.output.write(
        [
          "Created session config for mahabot.",
          `Config path: ${bootstrap.configPath}`,
          "Please fill in required values in the config file, then re-run `mahabot cli`.",
          "",
        ].join("\n"),
      );
      return;
    }

    await this.configManager.load();

    let agent = await this.buildAgentFromSession(
      bootstrap.workspaceSessionId,
      bootstrap.sessionRoot,
      bootstrap.workspaceRoot,
      bootstrap.persistenceRoot
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
          try {
            await agent.waitForIdle();
            agent = await this.buildAgentFromSession(
              bootstrap.workspaceSessionId,
              bootstrap.sessionRoot,
              bootstrap.workspaceRoot,
              bootstrap.persistenceRoot
            );
            this.io.output.write("Conversation context cleared and system prompt reloaded.\n\n");
          } catch (error) {
            this.io.output.write(`bot> [error] ${String(error)}\n\n`);
          }
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

  private async buildAgentFromSession(
    workspaceSessionId: string,
    sessionRoot: string,
    workspaceRoot: string,
    persistenceRoot: string
  ): Promise<Agent> {
    const systemPromptAssembly = await this.contextManager.assembleSystemPrompt(
      workspaceSessionId,
      sessionRoot,
      workspaceRoot,
      persistenceRoot
    );

    return Agent.fromAppConfig(
      {
        appConfig: this.configManager.get(),
        providerName: DEMO_PROVIDER_NAME,
        modelName: DEMO_MODEL_NAME,
        systemPrompt: systemPromptAssembly.systemPrompt,
        thinkingLevel: this.configManager.getThinkingLevel(),
        tools: [],
        ensureProviderCredentials: (providerName) =>
          this.configManager.ensureProviderCredentials(providerName),
        getApiKey: (providerName) =>
          this.configManager.getApiKeyForProviderName(providerName),
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
      }
    );
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

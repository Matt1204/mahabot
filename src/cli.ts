#!/usr/bin/env node
import dotenv from "dotenv";

import { MahabotGatewayManager } from "./gateway/index.js";

dotenv.config();

function parseCommandArgs(args: string[]): { command: string; llmProvider?: string; model?: string } {
  let command = "";
  let llmProvider: string | undefined;
  let model: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg.startsWith("-")) {
      // Handle flags
      const flag = arg.replace(/^-+/, ""); // Remove leading dashes
      const nextArg = args[i + 1];

      if (flag === "llmprovider" || flag === "p") {
        if (nextArg && !nextArg.startsWith("-")) {
          llmProvider = nextArg;
          i++; // Skip next arg as it's consumed
        }
      } else if (flag === "model" || flag === "m") {
        if (nextArg && !nextArg.startsWith("-")) {
          model = nextArg;
          i++; // Skip next arg as it's consumed
        }
      } else if (flag === "help" || flag === "h") {
        command = "help";
      }
    } else if (!command) {
      // First non-flag argument is the command
      command = arg;
    }
  }

  return { command, llmProvider, model };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const { command,} = parseCommandArgs(args);

  if (!command || command === "help") {
    printHelp();
    return;
  }

  if (command === "cli") {
    const manager = new MahabotGatewayManager();
    await manager.runInCliMode("microsoft-foundry", "gpt-5.3-chat");
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

function printHelp(): void {
  console.log([
    "Usage:",
    "  mahabot cli [--llmprovider <provider>] [--model <model>]",
    "  mahabot help",
    "",
    "Options:",
    "  -p, --llmprovider <provider>  LLM provider (e.g., openai, anthropic, microsoft-foundry)",
    "  -m, --model <model>           Model name (e.g., gpt-4o-mini, gpt-5-mini)",
    "  -h, --help                    Show this help",
    "",
    "Examples:",
    "  mahabot cli",
    "  mahabot cli --llmprovider openai --model gpt-4o-mini",
    "  mahabot cli -p microsoft-foundry -m gpt-5-mini",
  ].join("\n"));
}

main().catch((error) => {
  console.error("mahabot failed:", error);
  process.exitCode = 1;
});

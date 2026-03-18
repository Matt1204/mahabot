#!/usr/bin/env node
import dotenv from "dotenv";

import { MahabotGatewayManager } from "./gateway/index.js";

dotenv.config();

function parseCommandArgs(args: string[]): { command: string } {
  let command = "";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg.startsWith("-")) {
      // Handle flags
      const flag = arg.replace(/^-+/, ""); // Remove leading dashes

      if (flag === "help" || flag === "h") {
        command = "help";
      }
    } else if (!command) {
      // First non-flag argument is the command
      command = arg;
    }
  }

  return { command };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const { command } = parseCommandArgs(args);

  if (!command || command === "help") {
    printHelp();
    return;
  }

  if (command === "cli") {
    const manager = new MahabotGatewayManager();
    await manager.runInCliMode();
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

function printHelp(): void {
  console.log([
    "Usage:",
    "  mahabot cli",
    "  mahabot help",
    "",
    "Options:",
    "  -h, --help                    Show this help",
    "",
    "Examples:",
    "  mahabot cli",
  ].join("\n"));
}

main().catch((error) => {
  console.error("mahabot failed:", error);
  process.exitCode = 1;
});

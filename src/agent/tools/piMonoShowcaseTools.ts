import type { AgentTool } from "@mariozechner/pi-agent-core";
import { createEchoStructuredInputTool } from "./showcase/echoStructuredInputTool.js";
import { createFailIntentionallyTool } from "./showcase/failIntentionallyTool.js";
import { createProgressiveTickerTool } from "./showcase/progressiveTickerTool.js";
import { createRenderDebugBadgeTool } from "./showcase/renderDebugBadgeTool.js";
import { createShowRuntimeInfoTool } from "./showcase/showRuntimeInfoTool.js";

/**
 * Showcase tools for pi-agent-core best practices:
 * - strong TypeBox parameter schemas
 * - structured details payloads
 * - progressive updates via onUpdate callback
 * - AbortSignal cancellation checks
 * - text + image tool result blocks
 * - explicit thrown-error path
 */
export function createPiMonoShowcaseTools(): AgentTool<any>[] {
  return [
    createShowRuntimeInfoTool(),
    createEchoStructuredInputTool(),
    createProgressiveTickerTool(),
    createRenderDebugBadgeTool(),
    createFailIntentionallyTool(),
  ];
}

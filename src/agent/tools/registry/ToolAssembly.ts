import type { AppConfig } from "../../../config/types.js";
import { resolve } from "node:path";
import type { InFlightUpdateQuotaRef, ProgressUpdateSink } from "../../progress/types.js";
import { createBashTool } from "../bashTool.js";
import { createInFlightUpdateTool } from "../inFlightUpdateTool.js";
import { createEditFileTool } from "../editFileTool.js";
import { createGrepTool } from "../grepTool.js";
import { createGlobTool } from "../globTool.js";
import { createListTreeTool } from "../listTreeTool.js";
import { createReadFileTool } from "../readFileTool.js";
import { createWebSearchTool } from "../webSearchTool.js";
import { createWriteFileTool } from "../writeFileTool.js";
import { createEchoStructuredInputTool } from "../showcase/echoStructuredInputTool.js";
import { createFailIntentionallyTool } from "../showcase/failIntentionallyTool.js";
import { createProgressiveTickerTool } from "../showcase/progressiveTickerTool.js";
import { createRenderDebugBadgeTool } from "../showcase/renderDebugBadgeTool.js";
import { createShowRuntimeInfoTool } from "../showcase/showRuntimeInfoTool.js";

import type { ToolRegistry } from "./toolRegistry.js";

export interface ToolRuntimeContext {
  workspaceRoot?: string;
  /**
   * When set, registers `in_flight_update` with this sink and quota ref (gateway must pass the same
   * quotaRef to Agent.createFromAppConfig deps so invokeAgentLoop resets `used` each turn).
   * Omit in environments that should not expose user-visible progress lines.
   */
  progressUpdate?: {
    sink: ProgressUpdateSink;
    quotaRef: InFlightUpdateQuotaRef;
  };
}

/**
 * Central tool assembly entrypoint.
 *
 * Why this exists:
 * - callers should not care about internal phases (standard/addon/future packs).
 * - we keep one business-assembly seam for all tool availability decisions.
 */
export function registerTools(
  toolRegistry: ToolRegistry,
  appConfig: AppConfig,
  toolRuntimeContext: ToolRuntimeContext = {}
): void {
  registerStandardTools(toolRegistry, appConfig, toolRuntimeContext);
  registerAddonTools(toolRegistry, appConfig, toolRuntimeContext);
}

function resolveBuiltinSkillsRoot(): string {
  return resolve(process.cwd(), "src", "agent", "skills");
}

function registerStandardTools(
  registry: ToolRegistry,
  appConfig: AppConfig,
  toolRuntimeContext: ToolRuntimeContext
): void {
  registry.registerStandard(createShowRuntimeInfoTool());
  registry.registerStandard(
    createWebSearchTool({
      tavilyApiKeyEnvVar: appConfig.tools.webSearch.tavilyApiKeyEnvVar,
      linkupApiKeyEnvVar: appConfig.tools.webSearch.linkupApiKeyEnvVar,
    })
  );
  if (toolRuntimeContext.progressUpdate) {
    registry.registerStandard(
      createInFlightUpdateTool({
        sink: toolRuntimeContext.progressUpdate.sink,
        quotaRef: toolRuntimeContext.progressUpdate.quotaRef,
      })
    );
  }
  // Bash needs an explicit workspace root to enforce path-boundary checks.
  // In fallback construction paths without this context, we intentionally skip Bash.
  if (toolRuntimeContext.workspaceRoot) {
    const builtinSkillsRoot = resolveBuiltinSkillsRoot();
    registry.registerStandard(
      createBashTool({
        workspaceRoot: toolRuntimeContext.workspaceRoot,
        restrictToWorkspace: appConfig.tools.restrictToWorkspace,
      })
    );
    registry.registerStandard(
      createReadFileTool({
        workspaceRoot: toolRuntimeContext.workspaceRoot,
        restrictToWorkspace: appConfig.tools.restrictToWorkspace,
        builtinSkillsRoot,
      })
    );
    registry.registerStandard(
      createGrepTool({
        workspaceRoot: toolRuntimeContext.workspaceRoot,
        restrictToWorkspace: appConfig.tools.restrictToWorkspace,
      })
    );
    registry.registerStandard(
      createGlobTool({
        workspaceRoot: toolRuntimeContext.workspaceRoot,
        restrictToWorkspace: appConfig.tools.restrictToWorkspace,
      })
    );
    registry.registerStandard(
      createWriteFileTool({
        workspaceRoot: toolRuntimeContext.workspaceRoot,
        restrictToWorkspace: appConfig.tools.restrictToWorkspace,
      })
    );
    registry.registerStandard(
      createEditFileTool({
        workspaceRoot: toolRuntimeContext.workspaceRoot,
        restrictToWorkspace: appConfig.tools.restrictToWorkspace,
      })
    );
    registry.registerStandard(
      createListTreeTool({
        workspaceRoot: toolRuntimeContext.workspaceRoot,
        restrictToWorkspace: appConfig.tools.restrictToWorkspace,
      })
    );
  }
}

function registerAddonTools(
  _registry: ToolRegistry,
  _appConfig: AppConfig,
  _toolRuntimeContext: ToolRuntimeContext
): void {
  // Reserved phase: add-on tool policy is intentionally disabled in this stage.
}

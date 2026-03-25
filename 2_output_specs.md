# Mahabot Architecture Specification (v1 Baseline for v2 Engineering)

This specification describes the `mahabot` repository as implemented in `src/` at the time of analysis, and is intended for an engineering team implementing/refactoring a v2 while preserving critical behavior and contracts.

Interpretation rule used throughout:

- **Implemented**: directly verified in executable code under `src/` (plus behavior validated by tests under `tests/`).
- **Inferred**: derived from naming, docs, extension seams, and surrounding architecture intent, but not fully implemented end-to-end.

Verification snapshot:

- Analysis date: 2026-03-23 (America/Toronto).
- Runtime validation used: `npm test` (23/23 passing).
- This document is a point-in-time architectural baseline and should be revalidated after dependency or gateway wiring changes.

## 1. System Boundary and Context Analysis

`mahabot` is a CLI-first, single-process TypeScript agent runtime wrapper around `@mariozechner/pi-agent-core` and `@mariozechner/pi-ai`. Its objective is to provide a controllable local agent loop with explicit session bootstrap, provider/model resolution, tool governance, and user-visible observability.

The operating ecosystem is a local developer machine plus remote LLM provider APIs. The runtime depends on: local filesystem (`~/.mahabot/<sessionId>/...` and current workspace), environment variables for credentials, and network calls made by provider adapters in `pi-ai`.

External actors are:

- A human operator using `mahabot cli`.
- External LLM providers (OpenAI-compatible and non-OpenAI providers through `pi-ai`).
- The host operating system and filesystem.

Upstream dependencies entering the system are user input lines, config files, prompt scaffold files (`AGENTS.md`, `SOUL.md`, `USER.md`), and provider API keys from env vars. Downstream dependencies are provider inference APIs and local disk side effects for workspace bootstrapping and file-tool operations.

Inside the boundary are command parsing, gateway orchestration, config normalization/validation, context assembly, tool registration/execution, event inspection rendering, and turn serialization. Outside the boundary are provider-side model behavior, OS permission enforcement, and any distributed message transport (Telegram/webhook ingestion remains configured but not implemented).

Data crossing boundaries and direction:

- User -> System: CLI commands and chat turns.
- Filesystem -> System: config and prompt scaffold files.
- Env -> System: provider credentials.
- System -> LLM provider: prompt/messages/tools serialized by `pi-agent-core`.
- LLM provider -> System: assistant content/tool calls/usage metadata.
- System -> User: final `bot>` response plus optional `[agent-update]` and `[inspection]` lines.
- System -> Filesystem: session scaffolding, config writes, and tool-driven file edits.

Trust/security boundaries are explicit at three layers: (1) untrusted user prompt/tool args, (2) mutable local config and prompt files, and (3) external provider responses. Ownership is split cleanly: `ConfigManager` owns workspace/config lifecycle, `ContextManager` owns system-prompt assembly, `MahabotGatewayManager` owns CLI orchestration wiring, `Agent` owns turn execution semantics, and tool modules own capability-specific safety policies.

## 2. Overall Architecture Design

The architecture is an **implemented modular monolith** with a gateway orchestration layer and dependency-injected seams for future transports. It is not a microservice system and not event-sourced; all orchestration is in-process.

The style is justified by current goals: deterministic local behavior, easy debugging, low operational overhead, and fast iteration on tool/runtime contracts.

High-level structure (text diagram):

```text
CLI (src/cli.ts)
  -> Gateway Manager (src/gateway/manager.ts)
      -> ConfigManager (bootstrap/load/credentials)
      -> ToolRegistry + ToolAssembly (runtime capabilities)
      -> ContextManager (system prompt composition)
      -> Agent facade (turn execution + serialization)
           -> modelFactory + runtimeFactory
           -> PiAgent runtime (@mariozechner/pi-agent-core)
           -> external LLM provider via @mariozechner/pi-ai
      -> EventInspection + CLI sinks (parallel observability path)
```

Runtime topology is one Node.js process, one interactive readline loop, one in-memory agent runtime instance per active CLI session. Scalability is intentionally constrained: one `Agent` instance serializes turns via an internal promise queue.

Fault tolerance is “continue-the-session” at gateway level and “contain-failure” at observer/tool boundaries. For example, inspection sink failures are caught and logged, inbound polling failures are retried with delay, and per-turn runtime errors are surfaced to user without killing CLI loop.

Deployment model is local CLI execution (`tsx` in dev or compiled `dist/cli.js`). Multi-region considerations are currently **not applicable** (implemented) because no distributed deployment fabric exists.

Trade-off profile:

- Gains: predictable flow, low complexity, easy local diagnosis.
- Costs: no horizontal scale, no server-grade HA, no formal queue-based backpressure, and no independent scaling of ingress/runtime/sink workers.

Alternative architectures such as split ingress workers + persistent orchestration store are **inferred future options** but not implemented.

## 3. Complete Module Breakdown

### 3.1 CLI Entrypoint (`src/cli.ts`)

Responsibility is parsing top-level command intent (`cli`/`help`) and launching gateway mode. It owns process-level failure handling and `dotenv` initialization, but does not own runtime policy or model selection. Input is `process.argv`; output is help text or delegated execution.

Its state is effectively stateless beyond local variables. Error handling is fail-fast for unknown commands. Concurrency is not relevant at this layer.

### 3.2 Gateway Orchestrator (`src/gateway/manager.ts` + `src/gateway/progress/cliProgressSink.ts`)

This module owns interactive CLI lifecycle, session bootstrap invocation, tool/runtime assembly, slash commands (`/help`, `/clear`, `/exit`), and terminal output behavior. It hardcodes current demo runtime selector values (`microsoft-foundry`, `gpt-5-mini`, stable session id) and rebuilds agent on `/clear`.

Important implemented nuance: in CLI mode, these hardcoded selector values take precedence over config defaults (`agent.defaultProvider`, `agent.defaultModel`) for runtime instantiation.

Owned state includes active `Agent` reference and readline loop state. Non-owned concerns include config schema rules and low-level provider calls.

Public interface is `runInCliMode()`. Inputs are user lines plus bootstrap/config artifacts. Outputs are final assistant lines and optional progress/inspection streams.

Error handling is resilient per turn (catch and print), with session continuity preserved. Concurrency is single-loop plus async turn calls.

### 3.3 Config Lifecycle (`src/config/configManager.ts`, `src/config/types.ts`, `src/config/index.ts`)

`ConfigManager` owns session workspace bootstrapping, template discovery, idempotent scaffold creation, deep-merge normalization, validation, and provider credential lookup.

Owned data: in-memory `AppConfig` snapshot and active config path pointer. Owned persistence: `~/.mahabot/<sessionId>/config.json`, prompt scaffold files, and placeholder persistence files.

Public interfaces include `initializeSessionWorkspace`, `load`, `save`, `update`, `resetToDefault`, credential helpers, and prompt scaffold recovery.

Validation rules (implemented) enforce config shape and critical invariants, including `memoryWindow >= 1`, `maxTokens >= 1`, non-empty `agent.workspaceRoot`, explicit rejection of legacy `tools.workspaceRoot`, and full boolean validation for `eventInspection` toggles.

Declared-vs-wired nuance (implemented): several config fields are structurally validated but not currently consumed by the active CLI execution path, including `ingress.telegram.*`, `tools.mcpServers`, and `agent.systemPromptFile`. Workspace paths used by runtime tools/context come from session bootstrap output, not `agent.workspaceRoot`.

Concurrency model is call-level async without file locks. Security posture is env-var indirection (keys not persisted by manager).

### 3.4 Model Resolution (`src/config/modelFactory.ts`)

This module resolves provider/model pair to a concrete `Model` object. It supports fallback to default provider/model and custom OpenAI-compatible endpoints when `category === "openai"` with `baseUrl`.

It owns model selection and custom adapter shaping, but not credential verification. Errors are explicit when no enabled provider/model match exists.

### 3.5 Context Assembly (`src/context/contextManager.ts`, `src/context/types.ts`)

`ContextManager` assembles the system prompt from required and optional sections: `AGENTS.md`, runtime metadata, tool-rule prompts, `SOUL.md`, `USER.md`. It can auto-create missing optional prompt files via `ConfigManager` template fallback.

Owned logic includes section ordering, runtime context string composition, and diagnostics (`promptCharCount`, `usedTemplateFallback`). It does not yet own memory compaction or transcript summarization.

### 3.6 Agent Facade and Turn Runtime (`src/agent/agent.ts`, `src/agent/types.ts`, `src/agent/runtime/agentRuntimeFactory.ts`, `src/agent/mappers/message.mapper.ts`)

`Agent` is the core application runtime facade. It builds `PiAgent` from app config, serializes turn execution (`runExclusive`), wraps CLI inputs into inbound contracts, invokes runtime prompts, parses outputs, and exposes lifecycle controls (`continue`, `abort`, `waitForIdle`, `reset`).

Owned state includes runtime handle, serial queue, running flags, optional IO/memory adapters, and shared in-flight-update quota ref.

Message mappers own conversion contracts between local envelope types and `AgentMessage[]` payloads. `runtimeFactory` owns translation from local runtime config to `PiAgent` constructor options.

Error handling pattern is mixed: strict throw for missing assistant message, soft fallback for non-text assistant content extraction, warning-only behavior for observer failures.

Concurrency model is explicit single-turn FIFO per agent instance.

### 3.7 Inspection Pipeline (`src/agent/inspection/*`)

`EventInspection` consumes runtime `AgentEvent`s, applies config gating, summarizes and redacts payload fragments, optionally emits token-usage lines, and publishes rendered events to channel-specific `InspectionSink`s.

Implemented non-blocking behavior uses microtask deferral in two layers: event processing and sink publish scheduling. Sink errors are swallowed with warnings, preventing observability path from breaking primary turn completion.

### 3.8 Progress Update Model (`src/agent/progress/types.ts`, `src/agent/tools/inFlightUpdateTool.ts`, gateway wiring)

Progress updates are a separate channel from inspection events. The `in_flight_update` tool validates payload fields, enforces per-turn quota (`IN_FLIGHT_UPDATE_LIMIT = 3`), sends via synchronous `ProgressUpdateSink`, and returns structured quota status in tool details.

Quota reset is done by `Agent.invokeAgentLoop()` before each prompt call, using shared mutable `quotaRef` passed from gateway/tool assembly.

### 3.9 Tool Registry and Assembly (`src/agent/tools/registry/*`, `src/agent/tools/index.ts`)

`ToolRegistry` owns ordered registration and duplicate-name prevention. `ToolAssembly` centrally registers standard tools and conditionally includes workspace-bound tools only when runtime context includes `workspaceRoot`.

Add-on registration is intentionally disabled (implemented as throw) to preserve future seam without active extension policy.

### 3.10 Tool Modules (`src/agent/tools/*`)

Implemented production-path tools include `bash`, `read_file`, `write_file`, `edit_file`, `list_tree`, `glob`, `grep`, `show_runtime_info`, and conditional `in_flight_update`.

Filesystem tools share common policy primitives (`resolvePolicyPath`, UTF-8 guards, hash checks, atomic write helper, structured error taxonomy). `bash` includes layered policy checks (destructive command blacklist, high-risk command rejection, workspace-boundary verification when enabled), bounded stdout/stderr capture, timeout kill strategy, and preserved working-directory continuity using marker protocol.

Showcase tools (`echo_structured_input`, `progressive_ticker`, `render_debug_badge`, `fail_intentionally`) exist for demonstration and testing patterns but are not currently registered by default standard assembly.

### 3.11 Test Modules (`tests/*.test.ts`)

Current tests validate contract-critical behaviors for `glob`, `grep`, and `in_flight_update` (default excludes, hidden file handling, truncation boundaries, regex/literal behavior, binary skipping, quota/validation/sink-failure handling). Coverage for gateway lifecycle and config migrations is limited (implemented gap).

## 4. Inter-Module Relationships and Communication

Inter-module communication is implemented as in-process function calls with async `Promise` boundaries. No internal HTTP/gRPC/message broker is used.

Communication characteristics by pair:

- `CLI -> Gateway`: sync command parsing + async mode execution.
- `Gateway -> ConfigManager`: async filesystem-backed calls; fail-fast on bootstrap/load errors.
- `Gateway -> ToolAssembly/Registry`: sync registration and schema metadata extraction.
- `Gateway -> ContextManager`: async prompt assembly with file I/O.
- `Gateway -> Agent`: async turn invocation (`runCliTurn`).
- `Agent -> PiAgent runtime`: async prompt/continue operations plus subscription callback.
- `Agent -> EventInspection` (through injected callback): sync callback entry, async deferred processing inside inspection module.
- `in_flight_update tool -> Progress sink`: synchronous best-effort write path.
- `EventInspection -> Inspection sink`: asynchronous microtask-published path.

Protocol and schema form:

- External-facing command protocol is CLI text commands and slash commands.
- Internal turn protocol uses `InboundMessageTemp`, `OutboundMessageTemp`, and `AgentMessage` arrays.
- Tool communication uses typed parameter schemas (`TypeBox`) and `AgentToolResult` (`content` + `details`).
- Inspection events use `InspectionRenderedEvent` with channel, event type, line, and optional metadata.

Timeout/retry/circuit breaking:

- `bash` has fixed 120s timeout and TERM->KILL escalation (implemented).
- Inbound polling mode retries with 250ms delay on source errors (implemented).
- No general circuit breaker exists across provider or sink failures (implemented absence).
- No automatic replay for failed user turns (implemented absence).

Failure propagation and ordering:

- Turn execution ordering is strictly serialized by `runExclusive` queue.
- Gateway catches turn failures and continues loop.
- Observer/sink failures are swallowed and logged.
- Filesystem tool failures are returned as structured details, not thrown uncaught into runtime.

Normal execution flow:

1. User enters line in readline prompt.
2. Gateway handles slash-command shortcuts or dispatches to `Agent.runCliTurn`.
3. Agent wraps inbound, assembles memory, maps to `AgentMessage[]`.
4. Agent resets progress quota ref and calls runtime prompt.
5. Runtime may emit events and request tool calls; events flow into `EventInspection` in parallel.
6. Assistant final message is extracted and mapped to outbound envelope.
7. Gateway prints final `bot>` line.

Failure and partial-outage flows:

- Config/template failure at startup halts CLI entry into chat mode.
- Missing provider key fails agent construction with explicit env-var hint.
- Provider/tool turn failure yields `[error]` output but loop remains active.
- Inspection sink error causes warning only; final response still proceeds.
- Progress sink failure returns tool-level `sink_failed` result; does not terminate turn.

Communication rationale:

The architecture intentionally keeps control flow synchronous and local to make behavior auditable. Observability paths are explicitly decoupled (progress vs inspection) so user-facing status output and runtime diagnostics do not create hidden coupling in main turn completion logic.

## 5. Domain Model and Behavior Design

Core domain entities and value objects:

- **WorkspaceSession**: sanitized `workspaceSessionId` plus canonical session/workspace/persistence paths.
- **AppConfig aggregate**: root configuration for ingress, agent runtime, tools, and inspection.
- **LlmProviderConfig**: provider identity, enabled flag, models, and credential locator.
- **ToolRegistry aggregate**: ordered tool catalog with uniqueness invariant.
- **InboundMessageTemp / OutboundMessageTemp**: transport-neutral turn envelope model.
- **MemoryBundle**: optional short-term context + long-term summary injection surface.
- **InspectionRenderedEvent**: channel-bound rendered diagnostic event.
- **InFlightUpdateQuotaRef**: per-turn mutable quota counter.

Relationships and ownership rules:

- Gateway owns session-scoped assembly of config + tools + context + agent.
- Agent owns turn semantics but not persistent storage.
- Tool modules own capability contracts and structured error outputs.
- ConfigManager owns filesystem bootstrap/validation rules.

Domain invariants (implemented):

- Each agent turn executes one-at-a-time per instance.
- Tool names in registry are globally unique.
- Workspace-restricted tools reject out-of-bound paths.
- `in_flight_update` successful sends per turn cannot exceed quota.
- Event inspection processing must not throw into primary turn path.

State machines:

- **Gateway session machine**: `Bootstrapping -> Ready -> ChatLoop -> Terminated`, with `FirstConfigCreated` short-circuit branch requiring user intervention.
- **Agent turn machine**: `Idle -> TurnQueued -> TurnExecuting -> TurnFinalized -> Idle`; abort transitions can cut execution and wait for idle.
- **Progress quota machine**: `used=0` at turn start, increment on successful sink delivery, cap at limit.

Allowed and forbidden transitions:

- Allowed: `/clear` rebuilds a fresh Agent instance after waiting for idle.
- Forbidden by validation: invalid config shape, provider missing key, malformed tool params, out-of-range progress values.

Business/validation rules:

- Config schema merge and normalization including legacy `model -> models` migration.
- Filesystem tool parameter constraints (`maxBytes`, hash length, occurrence index, etc.).
- Grep/glob regex/glob validity checks and bounded traversal limits.

Derived data and side effects:

- Runtime section in system prompt derives from process/platform/path info.
- Tool-rule prompt section derives from registered tools.
- CLI progress/inspection lines derive from structured event/tool payloads.

Consistency boundaries and transaction scoping:

- Turn-level runtime execution is the primary consistency boundary.
- File-tool operations are per-call transactional at OS-operation granularity (atomic rename used for overwrite writes).
- No multi-tool transactional rollback exists (implemented absence).

## 6. Data Architecture

There is no relational/NoSQL database in v1. The data architecture is filesystem-centric with in-memory runtime state.

Storage technologies and rationale:

- Local filesystem stores config and prompt scaffolds for developer-controlled inspectability.
- In-memory `PiAgent` state stores conversation messages for active process lifetime.

Implemented file schema layout under `~/.mahabot/<sessionId>/`:

- `config.json` (session-scoped app config)
- `AGENTS.md` (required system instructions)
- `workspace/SOUL.md`, `workspace/USER.md` (optional profile layers)
- `workspace/persistence/history.md` (reserved)
- `workspace/persistence/session.jsonl` (reserved)

Partitioning/indexing strategy:

- Partitioning is by `workspaceSessionId` directory (implemented).
- No indexing layer exists (implemented absence).

Migration strategy:

- Config load performs deep-merge over defaults and validates shape.
- Legacy `model` field is normalized to `models[]` when present.
- No automated multi-file schema migrator exists for persistence files (implemented absence).

Backward compatibility rules:

- Missing optional config fields are backfilled from defaults.
- Explicitly removed field `tools.workspaceRoot` is rejected to avoid silent drift.

Lifecycle, retention, archival:

- Files are created if missing and preserved thereafter.
- No automatic retention pruning or archival for history/session JSONL files is implemented.

Caching and read/write separation:

- Config is loaded into memory and cloned on getters.
- No cache invalidation protocol or read replica concept exists.

Consistency model:

- Strong consistency within a single process turn.
- Filesystem consistency is immediate per operation but not coordinated across concurrent external processes (inferred risk).

## 7. API and Contract Design

v1 exposes a CLI contract rather than HTTP endpoints.

Public API structure (implemented):

- CLI top-level commands: `mahabot cli`, `mahabot help`.
- Interactive slash commands in chat loop: `/help`, `/clear`, `/exit`.

Request/response schemas:

- Turn request is raw text line converted into `InboundMessageTemp` `{ id, channel, chatId, userId, text, timestamp, metadata }`.
- Turn response is `CliTurnResult` containing inbound, outbound, and user-printable `cliMessage`.
- Tool call contracts are TypeBox schemas per tool with typed `details` result payloads.

Error model:

- CLI command errors: thrown and caught at top level with process exit code.
- Turn errors: printed as `[error]` without killing loop.
- Tool errors: returned as structured `details` with `ok=false` and domain-specific `errorCode`.
- Inspection/progress sink failures: warning or structured drop reason, not hard crash.

Versioning and deprecation policy:

- Package version is `0.1.0` private; compatibility is source-controlled rather than externally versioned API governance (implemented).
- Deprecation process is currently ad hoc (inferred from codebase state).

AuthN/AuthZ integration:

- Provider authentication via environment variable configured per provider (`apiKeyEnvVar`).
- No user identity auth layer in CLI runtime.

Rate limiting:

- No request rate limiter at gateway/provider wrapper level.
- `in_flight_update` has explicit per-turn quota (3 successful updates).

Internal contracts/events:

- Runtime events follow `AgentEvent` taxonomy (`turn_start`, `message_update`, `tool_execution_*`, etc.).
- Inspection sink contract: `publish(event): void` immediate-return expectation.
- Progress sink contract: `(payload) => void` immediate-return expectation.

Schema evolution rules:

- Tool outputs include stable `details` shapes but without formal schema registry.
- Inspection metadata format is extensible and best-effort.

Consumer isolation guarantees:

- Inspection/progress consumers are isolated via try/catch and asynchronous scheduling so consumer failures do not propagate into core runtime loop.

## 8. Security Architecture

Authentication mechanism:

- Provider API access is authenticated via API key lookup from env vars, selected by enabled provider config.
- No first-party token issuance or session JWT exists.

Token/session model:

- Session identity is local workspace session id, not an auth token.
- Runtime conversation session is in-memory agent state keyed by process lifetime.

Authorization model:

- Authorization is capability-oriented at tool level, especially filesystem path policy and command policy in `bash`.
- Role hierarchy is effectively absent (single local operator model).

Permission granularity:

- `restrictToWorkspace` governs path-boundary checks for file tools and bash path analysis.
- Bash applies always-on destructive/high-risk command blocklists before execution.

Multi-tenant isolation:

- Session-level directory partitioning exists.
- True multi-tenant runtime isolation is not implemented; process assumes trusted local user context.

Encryption in transit/at rest:

- In transit: delegated to provider client transport (TLS is inferred standard behavior).
- At rest: local files are plaintext by default; no built-in encryption/key wrapping.

Key management:

- Keys are sourced via environment variables and checked for presence; keys are not persisted in config manager state files.

Audit logging:

- Runtime supports human-readable inspection lines and warning logs.
- No immutable audit log pipeline exists.

Threat model and mitigations:

- Prompt/tool input misuse is mitigated by parameter schemas and defensive path validation.
- Filesystem escape attempts are mitigated by canonical path checks and workspace boundary enforcement.
- Sensitive event fields are partially redacted in inspection summaries via key-name heuristics.
- Residual risk remains for local process compromise or malicious workspace content (inferred).

## 9. Non-Functional Design

Performance-related implemented constraints:

- Bash command timeout: 120,000 ms.
- Bash captured stdout/stderr payload limits: 8 KiB each for returned body (with larger tail buffering for marker parsing).
- Read file default chunk: 8 KiB, bounded [256, 65536].
- Tree/glob/grep traversal limits enforced by max-depth/max-results/max-files style parameters.

Scalability strategy:

- Serial per-agent turn execution for determinism.
- No parallel turn processing and no distributed workers.

Load behavior and backpressure:

- Backpressure is implicit through serialized queue and bounded tool outputs.
- No explicit queue length cap or shed policy exists.

Resilience mechanisms:

- Observer isolation and sink failure containment.
- Structured non-throw error results for tools.
- Graceful per-turn CLI error handling.

Availability targets:

- No formal SLA/SLO published (implemented absence).
- Practical objective is local interactive continuity despite single-turn failures.

Observability architecture:

- Two distinct channels: progress (`[agent-update]`) and inspection (`[inspection]`).
- Token usage emission is configurable and deduplicated by fingerprint per turn.

Logging, metrics, tracing, alerting:

- Logging is plain text (console and sink lines).
- No built-in metrics exporter, distributed trace context, or alerting backend.

Bottlenecks and scaling limits:

- External provider latency dominates response time.
- Single-process turn serialization limits throughput.
- Filesystem scanning tools can be expensive on very large trees despite limits.

## 10. Configuration and Environment Design

Environment separation:

- Dev path: `tsx` scripts.
- Build/runtime path: compiled `dist` with copied config templates.
- No explicit multi-env profile system (dev/stage/prod) beyond file/env differences.

Configuration injection model:

- Static JSON config loaded from session path.
- Dynamic secrets injected via env vars.
- Template root can be overridden by `MAHABOT_TEMPLATE_ROOT`.

Feature-flag-like controls:

- `eventInspection.useEventInspection`, `showTokenUsage`, and event include toggles.
- `tools.restrictToWorkspace` influences tool policy behavior.

Declared but not wired in active CLI runtime path:

- `ingress.telegram.*` is defined in config but Telegram ingress transport is not implemented.
- `tools.mcpServers` is defined in config but no MCP process orchestration is currently wired.
- `agent.systemPromptFile` is defined in config types/template but prompt assembly currently reads fixed scaffold paths (`AGENTS.md`, `SOUL.md`, `USER.md`) from session/workspace roots.
- `agent.workspaceRoot` is validated but runtime tool/context roots are derived from `initializeSessionWorkspace(...)` outputs in gateway wiring.

Rollout strategy:

- Manual code release and local startup; no managed rollout controller.

CI/CD and IaC:

- No CI pipeline or IaC definitions are present in repository (implemented absence).

Blue/green or canary strategy:

- Not implemented. Changes are adopted by local rebuild/restart.

## 11. Dependency Graph and Technology Stack

Programming languages and runtime:

- TypeScript (strict mode), Node.js >= 20, ESM (`type: module`).

Primary frameworks/libraries:

- `@mariozechner/pi-agent-core` (agent runtime loop/events/tool orchestration).
- `@mariozechner/pi-ai` (model/provider abstraction and TypeBox exports).
- `dotenv` (env bootstrap).
- Tooling: `tsx`, `typescript`, Node built-in test runner.

External services:

- Any provider supported via `pi-ai`; current gateway defaults target `microsoft-foundry` + `gpt-5-mini`.

Version constraints:

- `@mariozechner/pi-agent-core` `^0.57.1`
- `@mariozechner/pi-ai` `^0.57.1`
- `dotenv` `^16.6.1`
- TypeScript `^5.9.2`

Script-surface drift note (implemented):

- `package.json` includes `npm run playground` (`tsx src/cli.ts playground`), while CLI command parsing currently supports `cli` and `help` only; `playground` currently fails as unknown command.

Upgrade strategy and breaking-change policy:

- Semver ranges and lockfile govern dependency drift.
- No formal compatibility gate beyond local tests and runtime validation (implemented gap).

Internal dependency layering (implemented):

```text
cli
  -> gateway
      -> config
      -> context
      -> agent (facade)
          -> runtimeFactory + message mapper + inspection + tools
              -> tool registry/assembly + tool implementations
```

Layering rule observed: higher layers orchestrate; lower layers avoid CLI-specific assumptions except sink adapters.

## 12. Failure Analysis

Critical component analysis:

- **Config bootstrap/load** is a startup SPOF: failure blocks chat mode entirely.
- **Provider API availability** is a runtime SPOF for response generation.
- **Filesystem access** is an SPOF for context assembly and file tools.
- **Single process runtime** is an SPOF for all in-memory state.

Failure cascades:

- Provider failure cascades to current turn failure but not necessarily process termination.
- Sink failure does not cascade to turn failure due to containment logic.
- Invalid config cascades to startup abort.

Partial degradation behavior:

- Inspection disabled or failing -> core replies still work.
- Progress sink unavailable -> progress tool reports failure, core reply still possible.
- Individual tool failures -> model can continue with tool error context.

Disaster recovery and backup/restore:

- No automated backup or restore workflow is implemented.
- Recovery is manual: restore session files from local backups/VCS where applicable.

RTO/RPO (inferred, since no formal SRE targets):

- **Inferred RTO**: minutes, bounded by local restart + config correction.
- **Inferred RPO**: best-effort near-zero for persisted files, but in-memory conversation state is lost on process crash unless mirrored externally.

## 13. Versioning and Evolution Strategy

Semantic versioning posture:

- Project currently at `0.1.0` private; rapid iteration phase with limited external compatibility guarantees.

API evolution strategy:

- CLI command surface is small and stable.
- Tool contracts evolve via TypeBox schema and details payload adjustments.
- Config evolution uses deep-merge defaults and validation-time migration for known legacy field shape.

Database/file migration governance:

- Filesystem schema evolution is currently handled ad hoc in code paths (`validateAndNormalizeConfig` and bootstrap helpers).
- No centralized migration manifest exists.

Backward compatibility validation:

- Partial contract tests exist for key tools.
- No comprehensive compatibility suite for gateway/config/context lifecycle.

Contract testing model:

- Tool-level behavior tests validate success/failure/truncation/validation semantics.
- Event and sink contracts rely primarily on code-level assertions and runtime guards.

Deprecation timelines:

- Not formally codified. Deprecated config fields may be rejected immediately (example: `tools.workspaceRoot`).

Compatibility enforcement:

- Enforced at runtime by validation guards, explicit throws, and schema constraints.

## 14. Formal Consistency and Invariants

System-wide invariants (implemented):

- One active turn per agent instance (`runExclusive` queueing).
- Required session config and prompt files must exist or be recoverable via template rules before runtime creation.
- Tool registry cannot contain duplicate names.

Data invariants:

- Config object remains normalized post-load/set/update.
- File-tool paths are canonicalized before policy checks.
- Hash precondition fields require lowercase 64-hex format when provided.

Transaction invariants:

- Progress quota increments only after successful sink delivery.
- Bash working-directory continuity is updated only from parsed end-of-command marker.
- Atomic overwrite writes use temp-file + rename pattern.

Security invariants:

- In workspace-restricted mode, out-of-bound path access is rejected.
- Certain destructive/high-risk command shapes are blocked regardless of workspace mode.
- Inspection summary redacts suspicious sensitive keys by heuristic.

Operational invariants:

- Inspection/progress sink failures must not crash agent turn loop.
- CLI loop continues after per-turn runtime errors.
- `/clear` rebuilds agent context from disk rather than mutating prompt in-place.

Verification mechanisms:

- Compile-time type checking (`strict` TypeScript).
- Runtime validation and guard clauses.
- Focused tests for grep/glob/progress tool semantics.
- Defensive error wrapping and bounded IO behavior in tool implementations.

---

### Closing Note for v2 Teams

The current system is intentionally conservative: deterministic single-process orchestration, explicit boundaries, and strongly typed tool contracts. The safest v2 evolution path is to preserve these invariants first (turn serialization, path safety, contracted tool error shapes, observer isolation), then layer distributed ingress/persistence concerns behind the existing seams (`Gateway`, `ContextManager`, `InspectionSink`, and tool assembly context).

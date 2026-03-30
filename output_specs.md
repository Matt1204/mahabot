# Mahabot Architecture Specification (v1 Baseline for v2 Engineering)

This specification describes the current `mahabot` codebase as implemented in `src/` and validated by `tests/`. It is written for an engineering team that needs to implement, refactor, or extend a v2 system without rediscovering behavior from source.

Conventions used in this document:
- **Code-verified** means directly confirmed from current source and tests.
- **Inferred** means derived from architecture intent where code does not enforce it explicitly.

## 1. System Boundary and Context Analysis

`mahabot` is a local-first, single-process Node.js agent runtime that wraps `@mariozechner/pi-agent-core` with project-specific orchestration: session bootstrap, prompt assembly, tool governance, event inspection, message routing, and CLI rendering. The primary objective is to provide a stable command-line assistant workflow where user input is transformed into structured bus envelopes, executed by an agent worker, and rendered back as assistant output and runtime status.

Inside the system boundary:
- CLI command handling (`src/cli.ts`, `src/gateway/manager.ts`)
- Session workspace bootstrap and config lifecycle (`src/config/configManager.ts`)
- Prompt/context assembly (`src/context/contextManager.ts`)
- Agent orchestration and persistence coordination (`src/agent/agent.ts`, `src/agent/persistence/*`)
- In-process message bus and worker loop (`src/messageBus/*`, `src/agent/worker/agentWorker.ts`)
- Tool registry and tool implementations (`src/agent/tools/*`)
- Runtime event inspection and status publishing (`src/agent/inspection/*`)

Outside the system boundary:
- LLM provider execution internals (`@mariozechner/pi-ai`, upstream provider APIs)
- Core agent streaming/state machine internals (`@mariozechner/pi-agent-core`)
- External web search providers (Tavily, Linkup)
- OS process model and filesystem permissions beyond app policy constraints

External actors and dependencies:
- Human CLI user as primary actor.
- LLM providers selected by config (`agent.llmProviders`).
- Tavily/Linkup APIs via `web_search` tool.
- Local filesystem for workspace files and persistence (`session.jsonl`, `history.md`).

Boundary-crossing data flows:
- User input crosses into the bus as `user_to_agent` envelope payload (`parts[]`).
- Agent output crosses back as `agent_to_user` text payload with typed runtime kinds.
- Tool calls cross trust boundary to filesystem, shell, and web APIs.
- API keys cross via environment variables read at runtime; keys are validated but never intentionally persisted by app logic.

Trust/security boundaries:
- Boundary A: user input -> internal orchestration (validated envelope contract).
- Boundary B: agent/tool intent -> privileged operations (filesystem/shell/network), constrained by tool-level policy.
- Boundary C: local app -> external providers (LLM + search APIs), governed by config + env credentials.

Ownership model by boundary:
- `gateway` owns process lifecycle and session runtime assembly.
- `agent` owns turn execution, event subscription, and context compaction hooks.
- `messageBus` owns inter-module transport contract and dispatch isolation.
- `tools` own execution policy and structured result contracts.
- `config/context` own runtime configuration validity and prompt materialization.

## 2. Overall Architecture Design

Architecture style is a **modular monolith in a single Node.js process**, with event-driven internal messaging and explicit boundaries between ingress, orchestration, runtime, tools, and egress.

Justification for this style:
- Current use case is local CLI operation with low deployment complexity.
- In-process message passing avoids distributed consistency and transport overhead.
- Module-level contracts (`MessageBus`, `ToolRegistry`, `ContextManager`) preserve future extraction seams.

High-level structural diagram (text form):
- CLI (`src/cli.ts`) -> `MahabotGatewayManager`
- Gateway bootstraps config/workspace and constructs:
  - `InMemoryMessageBus`
  - `ToolRegistry` + assembled tools
  - `ContextManager`-generated system prompt
  - `EventInspection` runtime observer
  - `Agent` runtime wrapper
  - `AgentWorker` consumer loop
- User line -> ingress adapter -> bus queue
- Worker dequeues -> `agent.runCliTurn()` -> tool/LLM loop
- Worker publishes assistant message envelope
- Event inspection and in-flight tool publish runtime status envelopes
- CLI renderer subscribes to bus and writes styled lines to stdout

Runtime topology:
- Single OS process (`node`), single-threaded event loop semantics for JS execution.
- Child shell subprocesses are spawned per `bash` tool call.
- No separate service/container decomposition in current implementation.

Scalability model:
- Horizontal scalability is not implemented in-process; sessions are isolated by `sessionId` in memory maps.
- Vertical scalability relies on event-loop throughput and bounded tool output sizes.
- Session concurrency is architecturally possible (per-session queues), though current gateway launches one session id (`cli-stable-session`).

Fault tolerance strategy:
- Subscriber errors are isolated in bus dispatch.
- Event inspection errors are swallowed and logged; they do not break agent turns.
- Persistence restore and append failures degrade gracefully with warnings/errors and continue runtime.
- Worker catches per-turn failures and converts them into `[error] ...` assistant messages.

Deployment model:
- Local Node package with CLI bin (`mahabot -> dist/cli.js`).
- Build uses TypeScript compilation + template copy script.
- Runtime configured through session-local `~/.mahabot/<session>/config.json` + environment variables.

Multi-region considerations:
- **Code-verified:** none. Current design is single-node local runtime.
- **Inferred v2 consideration:** region concerns only matter if externalized to server mode.

Trade-offs and alternatives:
- Chosen monolith simplifies reasoning, debugging, and testability.
- It trades off multi-tenant isolation and independent scaling of components.
- A microservice/event-bus external architecture would improve distributed scaling but introduce significant operational complexity not required by current use case.

## 3. Complete Module Breakdown

### 3.1 CLI Entrypoint Module (`src/cli.ts`)

Responsibility and scope:
- Parses command args and dispatches supported command (`cli`) into gateway manager.

Owned logic/state:
- Minimal command parsing (`help`, first non-flag command).
- Process-level error handling (`main().catch`).

Non-owned concerns:
- No session orchestration, no agent lifecycle details.

Interfaces:
- Input: `process.argv`.
- Output: stdout/stderr and process exit code.

Error handling:
- Throws on unknown command; top-level catch logs `mahabot failed`.

Concurrency and performance:
- None beyond single startup path.

### 3.2 Gateway Manager Module (`src/gateway/manager.ts`)

Responsibility and scope:
- End-to-end session bootstrap and runtime wiring for CLI mode.
- Lifecycle owner for bus, renderer subscription, worker start/stop, and `/clear` rebuild.

Owned data/logic/state:
- Session-scoped runtime bundle `{ agent, worker }`.
- Runtime status publisher mapping to bus envelope format.

Non-owned concerns:
- Does not execute turns directly; delegates to `AgentWorker`.

Public interface:
- `runInCliMode(): Promise<void>`.

Inputs/outputs:
- Inputs: user CLI lines, loaded app config, workspace paths.
- Outputs: bus publications, rendered terminal output.

State management:
- Replaces runtime on `/clear` by stopping old components and rebuilding fresh instances.

Persistence strategy:
- Delegated to `Agent` via message persistence config.

Error handling:
- Bootstrap first-run creates config and exits with guidance.
- `/clear` failures are printed as `bot> [error] ...`.

Concurrency model:
- User input loop is sequential; worker runs async consume loop.

Security model:
- Passes workspace root and restriction flags into tool assembly to enforce policy at tool layer.

Performance constraints:
- Depends on bus responsiveness and agent turn latency.

Separation rationale:
- Keeps orchestration concerns separate from agent logic, enabling ingress/egress variants later.

### 3.3 Message Bus Module (`src/messageBus/*`)

Responsibility and scope:
- Provide contract-validated, session-aware in-memory transport between user ingress, worker, and UI subscribers.

Owned data:
- Per-session ingress queue map.
- Pending waiter map for event-driven awaiters.
- Egress snapshots (assistant/status).

Public interface:
- `publish`, `getUserMsgFromBus`, `subscribe`, `getQueues`.

Data transformations:
- Direction/kind validation via `kindRegistry`.
- Routing user envelopes into both global ingress log and session queue.

State/persistence:
- In-memory only; no durable queue backing.

Error handling:
- Rejects invalid envelopes synchronously.
- Isolates subscriber handler errors via per-handler try/catch.

Concurrency:
- FIFO per session via array shift.
- Waiters resolved one-at-a-time, oldest-first per session.

Security model:
- Contract enforcement prevents illegal kind-direction mixes and malformed payloads.

Performance constraints:
- Unbounded arrays (known risk); dispatch deferred to microtask.

Separation rationale:
- Decouples producer/consumer modules and allows future transport replacement.

### 3.4 Agent Worker Module (`src/agent/worker/agentWorker.ts`)

Responsibility:
- Bridge message bus ingress to agent turn execution and publish assistant responses.

Owned logic:
- Long-running consume-execute-publish loop with abort support.
- Conversion from structured user parts to plain CLI text (`[image] url` placeholder).

Non-owned:
- Does not manage agent internals or system prompt.

Interfaces:
- Consumes `MessageBus` and `Agent`.
- Publishes `agent.assistant_message` envelopes.

Error handling:
- Turn-level errors converted to user-visible `[error] ...` assistant messages.

Concurrency:
- One running loop per worker instance.

Security:
- No direct external side effects except bus publication.

### 3.5 Agent Runtime Wrapper (`src/agent/agent.ts` + runtime factory + mapper)

Responsibility:
- Wrap `pi-agent-core` with app-specific behaviors: startup restore, serial turn exclusivity, event observation, context compaction, and message persistence.

Owned state:
- `running` flags, abort controllers, serial promise queue, persistence coordinator.

Public interfaces:
- `createFromAppConfig`, `start/stop`, `runCliTurn`, `continue`, `abort`, `waitForIdle`, `reset`, steering/follow-up injection helpers.

Inputs/outputs:
- Input: inbound text and assembled memory bundle.
- Output: outbound text generated from assistant message mapping.

Data transformation:
- `InboundMessageTemp` + memory -> `AgentMessage[]`.
- assistant `AgentMessage` -> human text extraction that suppresses thinking-only content.

State management:
- First queued task waits for startup context restore promise.
- `runExclusive` ensures one turn-at-a-time semantics even if callers race.

Persistence strategy:
- On startup: load aligned tail window from `session.jsonl`.
- On turn-end: track token usage and compact context if high watermark exceeded.
- On stop/compaction: persist pending message tail.

Error handling:
- Event observer errors are isolated.
- Restore/persist failures do not crash agent; warnings logged.

Concurrency model:
- Serial queue for all turn-invoking operations.

Security:
- Relies on tool policy and config credential checks.

Performance constraints:
- Context compaction ratio based on watermark target and message count.

### 3.6 Persistence Subsystem (`src/agent/persistence/*`)

Responsibility:
- Durable append-only JSONL storage and bounded context reconstruction.

Components:
- `JsonlMessageStore`: append/read, tolerant parse for malformed trailing line and session mismatch filtering.
- `windowAlignment`: turn-boundary-safe tail slicing.
- `MessagePersistenceCoordinator`: cursor tracking, restore/persist/compact orchestration.

Consistency behavior:
- Compaction persists before dropping messages to avoid data loss.
- Cursor is adjusted when compaction drops head messages.

Failure behavior:
- Append errors reported; cursor not advanced.
- Restore errors return empty/default runtime messages.

### 3.7 Context Assembly Module (`src/context/contextManager.ts`)

Responsibility:
- Compose system prompt from scaffold files, runtime metadata, tool prompts, and skill catalog summary.

Owned logic:
- Required `AGENTS.md` read.
- Optional `SOUL.md` / `USER.md` auto-scaffold if missing.
- Skills metadata scan from builtin and workspace roots.

Interfaces:
- `assembleSystemPrompt(sessionId, sessionRoot, workspaceRoot, persistenceRoot, toolRegistry)`.

Security/trust:
- Includes paths and runtime metadata in prompt; does not include skill body by default, only metadata summary.

### 3.8 Skills Catalog Module (`src/agent/skills/*`)

Responsibility:
- Discover skill directories, parse YAML frontmatter, generate metadata XML summary.

Behavior:
- Workspace skills override builtin by skill name.
- Parse failures are warnings and skip loading.
- Description guideline violations are warned but accepted.

### 3.9 Configuration Module (`src/config/*`)

Responsibility:
- Manage schema-validated app config, workspace bootstrap, provider/model resolution, and credential access.

Owned logic:
- Deep-merge defaults with user config.
- Strict rejection of removed/unsupported schema keys.
- Active/default provider-model pair validation.
- Template lookup fallback chain and session directory initialization.

Security model:
- API keys fetched from env vars; explicit `ensureProviderCredentials` validation before runtime creation.

### 3.10 Tooling Subsystem (`src/agent/tools/*`)

Responsibility:
- Register and execute capability tools with typed schemas and policy-bound side effects.

Registered standard tools in context-aware mode:
- `show_runtime_info`, `web_search`, optional `in_flight_update`, plus filesystem/shell tools when workspace root exists: `bash`, `read_file`, `grep`, `glob`, `write_file`, `edit_file`, `list_tree`.

Registry behavior:
- Ordered registration with duplicate-name rejection.
- Add-on registration intentionally disabled.

Security/performance highlights:
- Filesystem tools enforce workspace boundary (with `read_file` special allowance for builtin skills root).
- `bash` has blacklist/high-risk/workspace policy gates and fixed timeout.
- Tool outputs are bounded and structured with details payloads.

### 3.11 Event Inspection Module (`src/agent/inspection/*`)

Responsibility:
- Convert low-level `AgentEvent` stream into user-visible runtime status lines and token-usage/thinking summaries.

Behavior:
- Two-stage microtask deferral to minimize runtime callback blocking.
- Deduplicates token usage emissions by fingerprint.
- Tracks thinking stream fragments and emits finalized thinking text on `thinking_end` only.

### 3.12 CLI Egress/Ingress Adapters (`src/gateway/egress`, `src/gateway/ingress`)

Responsibility:
- Transform raw CLI input into bus envelope and render agent/status envelopes to terminal with optional ANSI styling.

Contract:
- `ui.user_message` carries text-only parts from CLI.
- `agent.assistant_message` rendered as `bot>`.
- Runtime status rendered dim/secondary/blue based on kind/style.

## 4. Inter-Module Relationships and Communication

Primary synchronous/async chain for normal execution:
1. User types line in gateway readline loop.
2. `publishCliUserMessage` emits `user_to_agent/ui.user_message` to bus.
3. `AgentWorker` awaits `getUserMsgFromBus(sessionId)` and receives envelope FIFO.
4. Worker calls `agent.runCliTurn(...)`.
5. Agent maps message, prompts runtime, may execute tools, parses assistant output.
6. Worker publishes `agent.assistant_message` envelope.
7. CLI renderer subscriber prints assistant line.
8. In parallel, event inspection may publish `agent.runtime.*` envelopes for tool/activity/thinking/token status.

Communication protocol by module pair:

Gateway -> MessageBus:
- Direction: producer only.
- Protocol: in-memory method call `publish`.
- Sync vs async: synchronous publish + async microtask dispatch to subscribers.
- Retry/timeout: none; failures are thrown for invalid payloads.
- Ordering: publish order preserved per event-loop execution.

MessageBus -> AgentWorker:
- Direction: consumer pull (`getUserMsgFromBus`).
- Sync vs async: promise-based; immediate dequeue or parked waiter.
- Timeout: none; cancellation via `AbortSignal`.
- Retry: worker loop continues after non-abort errors.
- Ordering: FIFO per session queue.
- Consistency: at-most-once dequeue from in-memory queue (no persistence).

AgentWorker -> Agent:
- Direction: direct call.
- Protocol: in-process function invocation.
- Timeout: none at wrapper layer; downstream tool-level timeouts apply (`bash` 120s).
- Idempotency: not guaranteed; repeated invocation repeats turn execution.
- Transaction boundary: one `runCliTurn` is logical transaction unit.

Agent/EventInspection -> MessageBus:
- Direction: status publication callback.
- Protocol: runtime status converted to `agent_to_user` envelopes.
- Failure propagation: publish errors are not expected in normal flow; inspection publish wrapper catches and logs failures.

MessageBus -> CLI Renderer:
- Direction: pub-sub callback.
- Async semantics: dispatch via microtask.
- Failure isolation: renderer exceptions do not poison other subscribers.

Normal flow rationale:
- Decoupling rendering from execution prevents output concerns from blocking worker execution.

Failure scenarios:
- Invalid envelope publish throws immediately at producer.
- Worker turn error yields user-visible assistant error envelope; loop continues.
- Persistence append failure logs error and continues with in-memory state.
- Event inspection failure is swallowed and does not interrupt agent runtime.

Retry scenarios:
- `web_search` internal fallback only from Tavily insufficient-credits to Linkup; other failures do not trigger fallback.
- No generic cross-module retry middleware exists.

Partial outage behavior:
- If status publication fails, assistant messages can still flow.
- If persistence fails, chat remains functional but durability guarantees degrade.
- If external providers fail (LLM/web search), user receives failure text; process remains alive.

Circuit breaking and transactional scope:
- No explicit circuit breaker implementation.
- Transaction boundaries are coarse-grained per turn and per tool execution.

Consistency guarantees:
- Strong ordering per session for ingress dequeue.
- Eventual rendering for published envelopes (microtask scheduling).
- Durable history only for successfully appended JSONL records.

## 5. Domain Model and Behavior Design

Core entities and value objects:
- `BusEnvelope<TPayload>`: canonical transport envelope with identity, session scope, direction, kind, priority, payload.
- `InboundMessageTemp` / `OutboundMessageTemp`: agent-facing temporary conversational structures for CLI flow.
- `AgentMessage` (from upstream runtime): canonical LLM/tool/assistant history objects.
- `PersistedMessageRecord`: append-only JSONL record containing schema version, session id, timestamp, message.
- `ContextBudgetSnapshot`: token usage watermark state for compaction policy.
- `SkillMetadata`: name/description/location extracted from skill frontmatter.
- Tool-specific `details` objects (filesystem/search/bash/web_search/inflight) as machine-consumable execution contracts.

Aggregate ownership:
- Gateway owns session runtime aggregate (agent + worker + bus + renderer subscription).
- Agent owns runtime message history and compaction/persistence cursor behavior.
- MessageBus owns ingress/egress queue states and waiter lifecycle.

Key invariants (code-verified):
- `MessageKind` must match `direction` category.
- `user_to_agent` payload must contain non-empty `parts`.
- `agent_to_user` payload must contain non-empty `text`.
- Tool names are globally unique in registry.
- Compaction low watermark must be strictly less than high watermark.
- Provider-model pair selected as active/default must exist among enabled providers.
- `eventInspection.thinking.emitMode` must be `on_end`.

State machines:

Session runtime lifecycle:
- Bootstrapped -> Running worker -> Stopped/Disposed -> Rebuilt on `/clear`.
- Forbidden transition: concurrent `start` duplicates are ignored by idempotent checks.

Worker loop lifecycle:
- Idle waiting on bus -> Consuming envelope -> Executing turn -> Publishing output -> back to waiting.
- Abort transitions waiting/executing loop to stopped state.

Agent turn lifecycle:
- inbound mapped -> runtime prompt -> zero or more tool calls/events -> assistant message located -> parsed outbound.
- Post-turn hook updates token usage and optionally compacts context.

Business rules and validation:
- Thinking-only assistant content is intentionally not surfaced as user answer text.
- `edit_file` rejects ambiguous replacements unless `occurrence` provided.
- `write_file` supports optimistic precondition (`expectedSha256`) to reduce lost update risk.
- `read_file` enforces UTF-8 decoding with explicit encoding error path.

Workflow orchestration logic:
- Gateway orchestrates session bootstrap and user loop; worker orchestrates message consumption and publishing; agent orchestrates runtime loop and history management.

Domain isolation from infrastructure:
- Domain-level envelope/message contracts are separated from CLI rendering details.
- Tool details objects abstract execution metadata from direct UI formatting.

Consistency boundaries and transaction scoping:
- Each `runCliTurn` is the principal business transaction unit.
- Persistence append is eventual and decoupled from immediate user response.

## 6. Data Architecture

Database technology:
- No RDBMS/NoSQL database in current version.
- Durable storage uses newline-delimited JSON file (`session.jsonl`) in workspace persistence directory.

Schema structure:
- `PersistedMessageRecord` schema v1:
  - `schemaVersion: 1`
  - `sessionId: string`
  - `persistedAt: number`
  - `message: AgentMessage`

Partitioning/indexing strategy:
- Physical partitioning by session path (`~/.mahabot/<session>/workspace/persistence/session.jsonl`).
- No index files; sequential append/read scan.

Migration strategy:
- Schema version is explicit per record; unknown versions are skipped on read.
- **Inferred:** future migrations can be additive by introducing new `schemaVersion` handling branch.

Backward compatibility rules:
- Store tolerates malformed trailing line and skips invalid or mismatched-session records.
- Config layer rejects removed legacy fields rather than silently mapping them.

Data lifecycle management:
- Startup restore reads tail window only (bounded by configured count and turn alignment).
- Runtime compaction trims in-memory message history based on token watermarks.
- Full historical records remain in JSONL after compaction (compaction is memory-only after persistence).

Archival and retention:
- **Code-verified:** no retention pruning or archive rollover policy.
- **Inferred operational policy needed for v2:** periodic compaction/rotation of large `session.jsonl` files.

Caching layers and invalidation:
- In-memory caches are implicit: bus queues, runtime message state, skill scan result per prompt assembly call.
- No cross-process cache coherence concerns in current design.

Read/write separation:
- Append-only writes and full-file reads; no read replicas.

Consistency model:
- Hybrid:
  - Strong in-memory consistency within process event loop for active session.
  - Eventual durability to JSONL based on persist timings.

## 7. API and Contract Design

Public API surface (user-facing):
- CLI commands:
  - `mahabot cli`
  - `mahabot help`
- In-session commands:
  - `/help`
  - `/clear`
  - `/exit` (and aliases `exit`, `quit`, `:q`)

Internal bus contract:
- Envelope fields: `id, sessionId, ts, direction, source, kind, priority, payload, renderHints?, meta?`
- `direction` enum: `user_to_agent | agent_to_user`
- `kind` enum:
  - user: `ui.user_message`
  - agent: `agent.assistant_message`, `agent.runtime.event`, `agent.runtime.token_usage`, `agent.runtime.inflight_update`, `agent.runtime.thinking`

Tool contract model:
- Each tool has typed parameters schema (`@mariozechner/pi-ai Type.*`), `content` blocks for model consumption, and structured `details` for app/test logic.

Key internal tool/event schemas:
- `in_flight_update` payload includes `message`, optional `nextStep/progressPercent/stage/dedupeKey`, and published runtime text format: `message | next: ... | N%`.
- `web_search` details include provider attempts, provider used, fallback reason, normalized results (always `url` + `description`), and typed error codes.
- Filesystem tools emit typed `errorCode` values from shared `FsErrorCode` taxonomy.

Error model:
- Tool errors are text + structured details with `ok: false` and `errorCode`.
- Worker-level runtime failure returns assistant text prefix `[error]`.
- Config validation throws explicit errors with field path hints.

Versioning policy:
- No explicit API version header; internal schema versioning appears in config (`schemaVersion`) and JSONL records.

Deprecation policy:
- Implemented as strict rejection for removed config fields (e.g., `agent.runtimeStatus`, deprecated model params).

AuthN/AuthZ integration:
- API keys loaded via env vars configured per provider/search tool.
- No user authentication/authorization layer for local CLI actor.

Rate limiting:
- No in-app rate limiter; external API responses (e.g., Tavily 429/432/433) are surfaced and mapped.

Internal events naming strategy:
- Dot-scoped kind namespace (`agent.runtime.*`, `agent.assistant_message`, `ui.user_message`).

Schema evolution rules (inferred):
- Prefer additive envelope/meta fields while preserving existing required fields and kind semantics.
- Maintain compatibility by tolerant readers and strict validators at publish boundaries.

Consumer isolation guarantees:
- Bus subscriber isolation via try/catch ensures one faulty consumer does not break others.

## 8. Security Architecture

Authentication mechanism:
- External provider auth via API keys from environment variables:
  - LLM provider keys from `agent.llmProviders[].apiKeyEnvVar`
  - Search provider keys from `tools.webSearch.*ApiKeyEnvVar`

Token/session model:
- No user login session tokens.
- Session identity is local workspace session id used for isolation of runtime state and persistence paths.

Authorization model:
- Capability-based authorization by tool registration + per-tool validation.
- Filesystem/shell authorization enforced by workspace boundary policy when `restrictToWorkspace=true`.

Permission granularity:
- Path-level checks in filesystem and bash tools.
- `read_file` allows additional root for builtin skills to support skill workflow discovery.

Role hierarchy:
- **Code-verified:** none (single local actor).

Multi-tenant isolation:
- Session-id scoped queue partitioning and per-session persistence files.
- **Inferred limitation:** isolation is cooperative in-process, not OS/container hardened.

Encryption in transit/at rest:
- Transit encryption delegated to HTTPS endpoints (LLM/search provider URLs).
- At rest encryption is not implemented for local files.

Key management:
- Keys are sourced from environment at runtime; no secrets persisted by config manager logic.

Audit logging:
- No formal audit trail subsystem; available observability is via runtime status messages and optional debug logs.

Threat model and mitigations:
- Prompt/content injection risk from tool outputs is acknowledged in system prompt templates, not programmatically enforced.
- Destructive shell command risk reduced by blacklist and high-risk pattern blocking.
- Workspace exfiltration risk reduced by path-policy checks in tools and shell path token analysis.
- Config schema hardening prevents unsupported legacy settings from silently changing behavior.

Attack surface:
- Shell execution (`bash`) is highest-risk surface; mitigated by deny rules, timeout, and workspace checks.
- Filesystem mutation tools (`write_file`, `edit_file`) rely on explicit params and optional hash preconditions.
- Network egress via `web_search` and upstream LLM runtime.

## 9. Non-Functional Design

Performance targets (code-derived practical envelope):
- Shell command timeout fixed at 120,000 ms.
- `read_file` default max read 8KB, bounded 256..65536 bytes.
- `bash` captured stdout/stderr each bounded to 8KB with truncation indicators.
- `glob` default max results 200 (schema up to 5000).
- `grep` defaults are effectively high (`maxMatches` 200, `maxFiles` 5000) with truncation tracking.

Scalability strategy:
- Session queue partitioning enables independent per-session FIFO behavior.
- Microtask dispatch avoids synchronous publish-path blocking by subscribers.

Load behavior and backpressure:
- No explicit queue backpressure; unbounded in-memory arrays can grow under sustained load.
- Tool-level result bounding limits single-call payload size.

Resilience mechanisms:
- Error isolation in bus dispatch and event inspection.
- Graceful degradation when persistence or status publication fails.

Availability targets:
- **Inferred:** best-effort local availability; no HA deployment semantics.

Observability architecture:
- Runtime status events (`agent.runtime.event/token_usage/inflight_update/thinking`) as first-class telemetry channel.
- Optional bash debug env (`MAHABOT_BASH_TOOL_DEBUG`) for detailed shell tool diagnostics.

Logging format:
- Predominantly plain text warnings/errors with module prefixes.

Metrics/tracing model:
- No dedicated metrics backend.
- Token usage snapshots embedded into runtime status via event inspection.

Alerting model:
- No automatic alerting pipeline.

Known bottlenecks/scaling limits:
- Single process/event loop.
- Unbounded in-memory queue growth.
- Full-file read for JSONL restore.
- External API latency dominates turn duration.

## 10. Configuration and Environment Design

Environment separation:
- Session bootstrap creates isolated workspace under `~/.mahabot/<sanitizedSessionId>/`.
- Per-session config file at `<sessionRoot>/config.json`.

Configuration injection:
- Startup `dotenv.config()` loads env vars.
- Config manager loads and validates JSON config, then runtime resolves provider/model and keys.

Feature-flag style controls:
- `eventInspection.useEventInspection`
- `eventInspection.showTokenUsage`
- `eventInspection.include.*`
- `eventInspection.thinking.enabled/maxChars`
- `tools.restrictToWorkspace`

Rollout strategy:
- Local config file edits plus rerun CLI.
- `/clear` command rebuilds runtime and reloads prompt/config in active session loop.

CI/CD structure:
- Build: `tsc` + template copy script.
- Test: Node test runner via `tsx --test` across unit tests.
- No deployment pipeline code in repo.

Infrastructure as Code:
- None.

Blue/green or canary:
- None.

## 11. Dependency Graph and Technology Stack

Programming language and runtime:
- TypeScript (ESM), Node.js >= 20.

Core frameworks/libraries:
- `@mariozechner/pi-agent-core` for agent runtime and event model.
- `@mariozechner/pi-ai` for model abstraction and tool schema type builders.
- `dotenv` for env loading.
- `yaml` for skill frontmatter parsing (`parseDocument`).
- `tsx` for dev/test execution.

External services:
- Configured LLM providers (OpenAI category and compatible endpoints supported).
- Tavily and Linkup search APIs.

Version constraints:
- Package versions pinned by `package-lock.json`; semver ranges in `package.json`.

Internal dependency layering:
- CLI -> Gateway -> (Config + Context + Bus + Agent + Worker + Renderer)
- Agent -> Runtime factory + Mapper + Persistence + Inspection + Tools registry
- Tools -> shared filesystem utilities / network fetch

Layering rules observed:
- High-level orchestration modules depend on lower-level modules, not vice versa.
- Tool registry depends on tool implementations; tools do not depend on gateway.

Upgrade strategy (inferred):
- Maintain compatibility via strict config validation and test suite coverage before dependency bumps.

Breaking change policy:
- Current code practices explicit rejection of removed config fields, signaling hard breaks early.

## 12. Failure Analysis

Critical component: MessageBus
- SPOF risk: single in-memory instance; process crash loses queued messages.
- Cascade risk: invalid publish throws to caller; if uncaught in caller path it can abort local flow.
- Partial degradation: subscriber failures are isolated, so rendering failure does not block queueing.
- Recovery: restart process; no queue replay.

Critical component: Agent runtime wrapper
- SPOF risk: single runtime instance per session; corruption of state can stall turn execution.
- Cascade risk: runtime/provider errors bubble into worker error messages but process continues.
- Partial degradation: event inspection can fail independently without stopping turns.
- Recovery: `/clear` rebuild or process restart.

Critical component: Persistence subsystem
- SPOF risk: filesystem write/read failures degrade durability.
- Cascade risk: append failure does not stop responding but risks history gaps.
- Partial degradation: startup restore can fail and still run empty-history mode.
- Recovery: restore file permissions/paths; keep app running.

Critical component: Bash tool
- SPOF risk: abusive or pathological commands can consume runtime budget.
- Cascade risk: subprocess hangs mitigated by timeout + SIGTERM/SIGKILL.
- Partial degradation: blocked commands return structured blocked result instead of executing.
- Recovery: subsequent calls continue; no global shell state retained beyond working directory path.

Critical component: Web search tool
- SPOF risk: external API downtime/credit exhaustion blocks search feature only.
- Cascade risk: no retries storm; fallback only on specific Tavily credit conditions.
- Partial degradation: explicit error details still returned to model/user.
- Recovery: restore API keys/credits or provider availability.

Disaster recovery model:
- Manual recovery via process restart, workspace inspection, and config/env fixes.
- No automated failover orchestration.

Backup and restore:
- Primary recoverable artifact is `session.jsonl` and workspace files.
- No automated backup process in code.

RTO and RPO:
- **Inferred RTO:** minutes (manual restart and rerun `mahabot cli`).
- **Inferred RPO:** up to last successful `appendMessages`; in-memory turns not yet flushed may be lost on crash.

## 13. Versioning and Evolution Strategy

Semantic versioning policy:
- Package declares `0.1.0`; practical policy is pre-1.0 evolving API with conservative internal validation.

API evolution strategy:
- Keep bus kind/direction contract stable.
- Extend payloads with optional fields instead of mutating required ones.
- Preserve tool names and base parameter semantics where possible.

Database/persistence migration governance:
- JSONL records include `schemaVersion`; readers should remain tolerant of older/newer records.
- Introduce migration adapters when bumping record schema.

Backward compatibility validation:
- Unit tests already enforce key behaviors (message bus FIFO, persistence alignment, tool error modes, config slimming).
- v2 should add compatibility tests for existing envelope and tool detail contracts.

Contract testing model:
- Existing tests are contract-style for tools and orchestration modules.
- v2 should formalize snapshot or schema assertions for `details` payloads and runtime status lines.

Deprecation timelines:
- Current pattern is immediate rejection of removed config keys.
- **Inferred v2 recommendation:** one release cycle warning phase before hard reject for user-facing config fields.

Compatibility enforcement:
- Config manager is strict gatekeeper.
- Tool registry duplicate checks prevent accidental contract collisions.

## 14. Formal Consistency and Invariants

System-wide invariants:
- Every published envelope must pass structural validation and direction-kind compatibility checks.
- Worker consumes only messages for its configured `sessionId`.
- Agent turn execution is serialized by `runExclusive` queue.

Data invariants:
- Persisted JSONL records for this session must have `schemaVersion=1` and matching `sessionId` to be loaded.
- Compacted in-memory history must end on an assistant turn boundary when produced by alignment logic.

Transaction invariants:
- A single bus user envelope maps to at most one worker turn execution.
- Compaction must not drop unpersisted messages (persist-before-drop rule in coordinator).

Security invariants:
- In restricted mode, filesystem and bash operations must remain within allowed workspace roots unless explicitly allowed (`read_file` builtin skills root).
- Blacklisted/high-risk bash command patterns must be blocked before execution.
- Provider credentials must be present in env before model use when required.

Operational invariants:
- Subscriber exceptions must not abort message dispatch loop.
- Event inspection exceptions must not break agent runtime callback path.
- CLI renderer must remain best-effort and side-effect-only (output writing).

Verification/enforcement mechanisms:
- Runtime checks in `kindRegistry`, `configManager`, tool validators, and path policy resolvers.
- Unit tests validating critical invariants across bus, persistence, tools, skills parsing, and config behavior.

---

## Appendix: Explicit Inferred Items for v2 Planning

The following are intentionally marked inferred because code does not fully enforce them yet:
- Formal SLO/SLA targets, RTO/RPO numbers, and retention windows.
- Multi-region and distributed deployment strategy.
- Automated backup, alerting, and circuit-breaker controls.
- Explicit deprecation schedule policy beyond current hard-reject behavior.

These should be resolved into concrete engineering decisions during v2 design kickoff.

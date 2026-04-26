# Mahabot Project Specification (v1 Baseline for v2 Engineering)

This document describes the current `mahabot` repository as implemented in `src/`, supported by `tests/`, and contextualized by `docs/` and `specs/`. It is written for a coding agent or engineering team that should be able to read this file first, understand the project shape, and then read the right code paths intentionally instead of rediscovering everything from scratch.

Conventions:
- Code-verified: directly confirmed from the current repository source or tests.
- Inferred: not fully enforced in code, but reasonably derived from the implemented design.
- File references are repo-relative unless otherwise noted.

## 1. System Boundary and Context Analysis

`mahabot` is a local-first, single-process TypeScript/Node.js assistant runtime. Its core job is to take user messages from supported ingress channels, normalize them into an internal message bus contract, run an LLM agent with configured tools and prompts, persist/compact conversation context, and send assistant output plus runtime status back to the user.

The system purpose is not to be a hosted multi-tenant service. It is a personal agent shell with two runtime modes: CLI and Telegram. CLI mode is optimized for local terminal interaction. Telegram mode is optimized for private text chat through a Telegram bot using long polling. Both modes reuse the same internal runtime chain: `Gateway -> MessageBus -> AgentWorker -> Agent -> pi-agent-core -> MessageBus -> Renderer/Relay`.

The operating ecosystem is Node.js >= 20, TypeScript ESM (`moduleResolution: NodeNext`), local filesystem state under `~/.mahabot/<session>/`, environment variables for secrets, Telegraf for Telegram integration, `@mariozechner/pi-agent-core` for agent runtime mechanics, and `@mariozechner/pi-ai` for model/tool schema support. The project is distributed as an npm package with a `mahabot` binary pointing to `dist/cli.js`.

External actors are:
- Human user in CLI mode, represented as `source: "cli"` and session `cli-stable-session`.
- Human Telegram user in Telegram mode, represented as `source: "telegram"` and session `tg:<chatId>`.
- Telegram Bot API, accessed through Telegraf long polling and `sendMessage`.
- LLM providers configured in `agent.llmProviders`, with credentials read from environment variables.
- Tavily and Linkup search APIs, accessed by the `web_search` tool.
- Local operating system, filesystem, and shell subprocesses used by filesystem and bash tools.

Inside the system boundary are:
- Command parsing and process entrypoint: `src/cli.ts`.
- Runtime orchestration: `src/gateway/manager.ts`.
- CLI and Telegram ingress adapters: `src/gateway/ingress/*`.
- CLI and Telegram egress: `src/gateway/egress/*`.
- In-memory internal transport: `src/messageBus/*`.
- Agent worker loop: `src/agent/worker/agentWorker.ts`.
- Agent wrapper, runtime factory, mapper, persistence, inspection, skills, and tools under `src/agent/*`.
- Configuration and prompt/context assembly under `src/config/*` and `src/context/*`.
- Tests under `tests/` that define behavioral contracts.

Outside the system boundary are:
- LLM provider implementation details and model transport behavior from upstream libraries.
- Telegram infrastructure availability, rate limits, and bot account management.
- Tavily/Linkup provider availability, billing, and response evolution.
- Operating-system-level filesystem permissions beyond checks enforced in app code.
- Any production deployment, external queue, database, webhook server, or multi-region topology.

Boundary-crossing data and direction:
- CLI input flows from stdin into `publishCliUserMessage`, then into the bus as `user_to_agent/ui.user_message`.
- Telegram private text flows from Telegraf middleware into `publishTelegramUserMessage`, then into the same bus contract with Telegram metadata.
- Agent output flows out as `agent_to_user/agent.assistant_message`.
- Runtime status flows out as `agent_to_user` kinds: `agent.runtime.event`, `agent.runtime.token_usage`, `agent.runtime.inflight_update`, and `agent.runtime.thinking`.
- Tool calls cross from agent runtime into local filesystem, shell subprocesses, or web search APIs.
- Config and prompt files cross from disk into runtime prompt/context assembly.
- Persisted messages cross from runtime memory to `session.jsonl` and back at startup.

Trust and security boundaries:
- User text is untrusted until normalized into an envelope and still remains semantically untrusted for agent/tool behavior.
- MessageBus enforces structural validity, but it does not perform semantic authorization.
- Telegram ingress applies a user-id whitelist before messages reach the agent.
- Tool execution is the privileged boundary. Filesystem tools and bash enforce workspace policy when `tools.restrictToWorkspace=true`.
- Secrets are read from environment variables and config names; the app validates presence but should not persist secret values.
- The LLM boundary is high risk: prompt, tool outputs, and user text are sent to provider APIs by upstream runtime/model code.

Ownership at each boundary:
- `gateway` owns process lifecycle, mode selection, session bootstrap, and runtime wiring.
- `messageBus` owns envelope validation, queueing, waiter wakeup, and subscriber dispatch isolation.
- `agent/worker` owns bus consumption and assistant envelope publication.
- `agent/agent` owns serial turn execution, runtime event subscription, persistence hooks, and context compaction.
- `config` owns config defaults, validation, workspace bootstrap, provider/model resolution support, and secret env-var naming.
- `context` owns system prompt assembly from session files, runtime metadata, tools, and skills.
- `tools` own execution policy, parameter schemas, and structured tool result contracts.
- `inspection` owns conversion of agent events into user-visible runtime status.

## 2. Overall Architecture Design

The architecture style is a modular monolith with event-driven internal communication. The process is monolithic because one Node.js process owns ingress, runtime, tools, persistence, and egress. It is modular because source boundaries are explicit: gateway, bus, worker, agent wrapper, config/context, tools, skills, persistence, and inspection each have narrow responsibilities.

This style is appropriate for the current product stage because the runtime is personal/local, latency is dominated by LLM/tool calls rather than internal IPC, and a separate service or external queue would add complexity without solving a current requirement. The in-memory bus still gives the project an extraction point: if a future v2 needs a durable queue or multi-process workers, `MessageBus` is the contract to preserve first.

High-level structural diagram:

```text
src/cli.ts
  -> MahabotGatewayManager
      -> ConfigManager.initializeSessionWorkspace/load
      -> InMemoryMessageBus
      -> CLI renderer or Telegram egress relay
      -> ToolRegistry + assembleTools
      -> ContextManager.assembleSystemPrompt
      -> EventInspection
      -> Agent.createFromAppConfig
      -> AgentWorker.start

Ingress:
  CLI readline or Telegraf message
    -> ingress adapter
    -> MessageBus user_to_agent queue
    -> AgentWorker
    -> Agent.runCliTurn
    -> pi-agent-core runtime + tools + model
    -> AgentWorker publishes assistant envelope
    -> renderer/relay subscriber

Runtime status:
  pi-agent-core AgentEvent or in_flight_update tool
    -> EventInspection/status publisher
    -> MessageBus agent_to_user status queue
    -> renderer/relay subscriber
```

Runtime topology is one Node.js process. In CLI mode it owns stdin/stdout and a readline loop. In Telegram mode it owns a Telegraf polling client, one active Telegram runtime, and signal handlers for graceful shutdown. Bash tool calls create child shell subprocesses with timeout and abort handling. No containers, HTTP server, webhook listener, database server, or background daemon are implemented.

The scalability model is intentionally small. Per-session FIFO ingress queues are implemented in memory and could support multiple sessions at the bus level, but gateway policy currently creates one CLI session or one active Telegram chat per process run. There is no queue backpressure, no queue size limit, and no horizontal scale story. v2 should treat unbounded arrays in `InMemoryMessageBus` as a known scaling limit.

Fault tolerance is local and defensive:
- Bus subscriber failures are caught and logged so one renderer does not break others.
- Bus dispatch is deferred with `queueMicrotask`, keeping `publish` lightweight.
- Worker turn failures become user-visible `[error] ...` assistant messages.
- Event inspection failures are caught and never allowed to break the agent loop.
- Persistence restore failures start without history; append failures log and keep running.
- Telegram send failures are caught and logged; they do not crash the process.
- Shutdown aborts workers and agent runtime, stops Telegraf, and unsubscribes relays.

Deployment model:
- Development commands are `npm run dev`, `npm run cli`, and `npm run telegram`.
- Build command is `npm run build`, which runs `tsc -p tsconfig.json` and copies config templates.
- Runtime command after build is `mahabot cli`, `mahabot telegram`, or `node dist/cli.js`.
- Session runtime files are created under `~/.mahabot/<sanitized-session-id>/`.

Multi-region considerations are not applicable to the current implementation. Any future hosted v2 would need to redesign session persistence, ingress identity, secret management, queueing, and model/tool execution isolation before multi-region deployment could be meaningful.

Primary trade-offs:
- The monolith is easy to read, test, and run locally, but it does not isolate failures across processes.
- In-memory queues avoid infrastructure, but messages are lost on process exit and can grow without bound.
- Telegram long polling is simple for personal use, but webhook mode would be better for hosted production.
- Workspace-local tool restriction reduces accidental damage, but bash static policy cannot prove all command safety.

## 3. Complete Module Breakdown

### CLI Entrypoint (`src/cli.ts`)

The CLI entrypoint owns command parsing and top-level process error handling. It recognizes `cli`, `telegram`, and help flags. It constructs `MahabotGatewayManager` and delegates to `runInCliMode()` or `runInTelegramMode()`. It does not own session state, config validation, prompt assembly, or agent behavior.

Inputs are `process.argv` and environment already loaded through `dotenv.config()`. Outputs are help text, top-level error text, and `process.exitCode=1` on failure. Its error model is intentionally simple: unknown commands throw, and `main().catch` reports `mahabot failed:`.

### Gateway Manager (`src/gateway/manager.ts`)

The gateway manager is the process lifecycle orchestrator. In both modes it initializes a session workspace, loads config, creates an `InMemoryMessageBus`, assembles tools, assembles the system prompt, creates an `EventInspection`, creates an `Agent`, creates an `AgentWorker`, starts the worker, and tears everything down during exit.

In CLI mode it owns a readline loop and handles local commands:
- `/help` prints static command help.
- `/clear` stops the current worker and agent, rebuilds runtime with the same bus/session paths, and reloads system prompt.
- `/exit`, `exit`, `quit`, or `:q` ends the loop.

In Telegram mode it owns:
- Telegraf bot construction from resolved runtime config.
- Private-text-only handling.
- User-id whitelist enforcement.
- One-active-chat-per-process policy.
- Lazy runtime activation on the first accepted chat.
- Relay subscription from bus to Telegram `sendMessage`.
- SIGINT/SIGTERM cleanup.

State is mostly runtime-local: active runtime, active chat id, shutdown flag, and activation promise. Persistence is delegated to the `Agent` through `messagePersistence` config. Errors during first config creation are not failures; the gateway prints the config path and exits so the user can fill required values.

### CLI Ingress Adapter (`src/gateway/ingress/cliIngressAdapter.ts`)

The CLI ingress adapter converts non-empty trimmed terminal text into a `BusEnvelope<UserToAgentPayload>`. It publishes `direction: "user_to_agent"`, `kind: "ui.user_message"`, `source: "cli"`, `priority: "high"`, and one text part. It owns no state. Empty messages are ignored before publication.

### Telegram Ingress and Access Policy (`src/gateway/ingress/telegram*.ts`)

Telegram runtime config resolution validates that Telegram mode is enabled, the whitelist is non-empty, and the bot token environment variable exists. It returns the token and a `ReadonlySet<string>` of allowed user ids.

The access policy enforces two rules:
- The Telegram `from.id` must be in `allowedUserIds`.
- The first accepted chat becomes the active chat for the process run; later messages from another chat are rejected.

The Telegram ingress adapter trims text, ignores whitespace-only messages, publishes `source: "telegram"`, and attaches Telegram identity metadata (`chatId`, `userId`, `username`, `firstName`, `lastName`). Even though the config field is named `allowedChatIds`, docs and code treat it as Telegram user-id whitelist.

### CLI Renderer (`src/gateway/egress/cliRenderer.ts`)

The CLI renderer subscribes to `agent_to_user` envelopes for one session. Assistant messages render as `bot> ...`; runtime status messages render as plain lines or ANSI-styled dim/secondary lines. It does not consume user messages. Its public interface is `createCliRenderer(...) => unsubscribe`.

### Telegram Egress Relay (`src/gateway/egress/telegramEgressAdapter.ts`)

The Telegram relay subscribes to `agent_to_user` envelopes for one session and forwards `payload.text` to the active Telegram chat through `sendMessage`. It forwards both assistant messages and runtime status. It catches send errors and logs warnings, so a Telegram delivery failure does not crash the runtime.

### Message Bus (`src/messageBus/*`)

The message bus is the internal transport contract. `types.ts` defines envelope shape, directions, priorities, payloads, and allowed message kinds. `kindRegistry.ts` validates top-level envelope fields, direction-kind compatibility, user payload parts, and agent payload text. `id.ts` creates process-local ids like `msg_<timestamp>_<seq>`.

`InMemoryMessageBus` owns:
- `ingressQueue`: global user ingress diagnostic log.
- `assistantEgressQueue`: assistant message diagnostic queue.
- `statusEgressQueue`: runtime status diagnostic queue.
- `ingressBySession`: real per-session FIFO inbox consumed by workers.
- `waitersBySession`: pending consumers blocked on empty queues.
- `subscribers`: renderer/relay/status consumers.

The bus is in-memory only. It does not persist messages, enforce authorization, deduplicate envelopes, cap queue size, retry subscribers, or guarantee exactly-once delivery beyond the current process.

### Agent Worker (`src/agent/worker/agentWorker.ts`)

`AgentWorker` bridges bus ingress to agent turns. It starts one loop per instance, waits on `bus.getUserMsgFromBus(sessionId, signal)`, maps user parts into text, calls `agent.runCliTurn(...)`, and publishes an `agent.assistant_message` envelope. Image parts are preserved only as textual placeholders (`[image] <url>`) because the current agent path is text-based.

The worker catches turn errors and publishes `[error] <error>` as assistant output. Stop uses `AbortController` so a parked bus waiter rejects with `AbortError` and the loop exits cleanly.

### Agent Runtime Wrapper (`src/agent/agent.ts`, `src/agent/runtime/*`, `src/agent/mappers/*`)

`Agent` wraps `@mariozechner/pi-agent-core` and adds application behavior:
- Static construction from `AppConfig`.
- Model resolution and provider credential checks.
- Tool assembly through `ToolRegistry`.
- Serial turn execution with `runExclusive`.
- Startup restore from persisted messages.
- Turn-end token usage tracking for context compaction.
- Event subscription and inspection callback isolation.
- Mapping between temporary inbound/outbound app messages and `AgentMessage`.
- Stop-time persistence and runtime abort/wait-for-idle.

The runtime factory creates a `PiAgent` with system prompt, selected model, thinking level, registered tools, optional transport/payload hooks, and a default `convertToLlm` that allows only `user`, `assistant`, and `toolResult` roles through. The mapper suppresses thinking-only content from user output, joins text blocks, and returns a tool-call summary if an assistant message contains tool calls but no text.

### Message Persistence (`src/agent/persistence/*`)

Persistence is JSONL-based. `JsonlMessageStore` appends records with `schemaVersion: 1`, `sessionId`, `persistedAt`, and raw `AgentMessage`. It reads all records, skips malformed non-final lines, ignores malformed trailing JSONL, and skips records for unexpected sessions.

`MessagePersistenceCoordinator` restores an aligned startup window, tracks a runtime cursor over in-memory messages, appends pending messages, and compacts context when token usage reaches the high watermark. Compaction calculates an approximate keep count based on `low/high` watermark ratio, aligns the retained tail to a completed assistant turn, persists before dropping messages, and adjusts the cursor.

`windowAlignment.ts` defines the key invariant: retained windows must end at an assistant turn end and prefer starting at a user boundary. A dangling final user message is not restored as the tail because it does not represent a completed turn.

### Config (`src/config/*`)

`ConfigManager` owns session workspace creation, config loading/saving, default merging, validation, provider credential lookup, provider/model selection, and prompt scaffold recovery. It creates:
- Session root: `~/.mahabot/<sanitized-session-id>/`.
- Workspace root: `<sessionRoot>/workspace`.
- Persistence root: `<workspaceRoot>/persistence`.
- Skills root: `<workspaceRoot>/skills`.
- Config: `<sessionRoot>/config.json`.
- Prompt files: `<sessionRoot>/AGENTS.md`, `<workspaceRoot>/SOUL.md`, `<workspaceRoot>/USER.md`.
- Persistence files: `history.md` and `session.jsonl`.

Config validation is strict. It rejects removed provider-level `model`, removed `modelFactoryDefaults`, removed model override keys, removed `agent.runtimeStatus`, invalid watermark ordering, invalid Telegram config, and unsupported tool config shapes. Arrays replace during deep merge rather than merging item-by-item.

The model factory resolves requested provider/model, then active provider/model, then default provider/model. It supports custom OpenAI-compatible providers when `category: "openai"` and `baseUrl` are set, using internal defaults for cost/context/max tokens.

### Context Manager (`src/context/*`)

`ContextManager` assembles the system prompt from ordered sections:
- Required `AGENTS.md` from session root.
- Runtime context including session id, platform, node, python, workspace paths, and persistence paths.
- Tool rule prompts from registered tools.
- Optional `SOUL.md` and `USER.md` from workspace root, recreated from templates if missing.
- Skills metadata rendered as XML.

It logs skill scan diagnostics and returns both the assembled prompt and section diagnostics. It does not currently inject long-term memory summaries from `history.md`; that file is reserved by prompt text and runtime metadata.

### Skills Catalog (`src/agent/skills/*`)

Skills are discovered from builtin and workspace skill roots by scanning direct child directories for `SKILL.md`. Frontmatter is parsed with `yaml`. A valid skill has a name and description, with fallback behavior for missing name/description and warnings for guide violations. Workspace skills override builtin skills with the same name, and the final list is sorted by name.

Only metadata is inserted into the prompt. The skill body must be read later by tool use when a skill is actually needed. This keeps prompt size small while preserving discoverability.

### Tool Registry and Assembly (`src/agent/tools/registry/*`)

`ToolRegistry` stores ordered tools and enforces globally unique names. Standard tools are allowed. Add-on registration exists as an interface but intentionally throws in this phase. `ToolAssembly` is the central policy point for available tools.

Standard tools include:
- `show_runtime_info`
- `web_search`
- `in_flight_update` when runtime status publisher is available
- `bash`, `read_file`, `grep`, `glob`, `write_file`, `edit_file`, `list_tree` when `workspaceRoot` is available
- showcase/debug tools through imported modules where used by assembly policy

Filesystem and bash tools are skipped if no workspace root is passed, which prevents unsafe fallback construction paths from exposing privileged tools.

### Filesystem Tools (`src/agent/tools/*FileTool.ts`, `grepTool.ts`, `globTool.ts`, `listTreeTool.ts`, `filesystem_shared/*`)

Filesystem tools share policy helpers in `filesystem_shared/core.ts`. They canonicalize paths, reject empty/null/overlong paths, resolve symlinks through existing ancestors, and enforce `restrictToWorkspace` unless an additional allowed root is configured. `read_file` uniquely allows builtin skill files outside workspace so skill workflows can read builtin `SKILL.md`.

Tool responsibilities:
- `read_file`: UTF-8 paginated reads with offset/maxBytes and truncation metadata.
- `write_file`: overwrite/create/append UTF-8 text with optional parent creation and SHA precondition.
- `edit_file`: exact text replacement with occurrence selection, dry-run, SHA precondition, and preview diff.
- `grep`: bounded recursive text search with literal/regex mode, include/exclude globs, hidden/binary skipping, context lines, and truncation metadata.
- `glob`: bounded recursive path matching with include/exclude globs, file/dir mode, hidden control, symlink cycle detection.
- `list_tree`: bounded directory traversal with max depth, max entries, hidden control, and sibling sorting.

### Bash Tool (`src/agent/tools/bashTool.ts`)

The bash tool runs a command in a new shell process with a fixed timeout of 120 seconds, stdout/stderr byte limits, and abort support. It keeps a logical current working directory across calls, but shell state itself does not persist. It blocks known destructive commands (`rm -rf`, `mkfs`, shutdown/reboot/halt/poweroff, fork bomb patterns), destructive git operations (`git reset --hard`, `git clean -fd`), and high-risk unverifiable command shapes in restricted mode (`curl | sh`, `sudo`, shell `-c`, command substitution, backticks).

When workspace restriction is enabled, the tool checks effective working directory and command path behavior using policy helpers. Static command analysis is necessarily conservative; v2 should continue treating bash as the highest-risk built-in tool.

### Web Search Tool (`src/agent/tools/webSearchTool.ts`)

`web_search` provides a single agent-facing search API over Tavily first and Linkup fallback. It accepts focused query parameters, date filters, domain include/exclude lists, and `max_results` up to 10. It calls Tavily first. It falls back to Linkup only when Tavily reports insufficient credits/usage limit. Tavily 429 rate limit does not trigger fallback by design.

Results are normalized into URL plus description with provider metadata. Errors are structured with codes such as `invalid_input`, `tavily_failed_non_credit`, `all_providers_insufficient_credits`, `network_error`, and provider payload errors. API keys are read from environment variables configured in `tools.webSearch`.

### Runtime Status and Event Inspection (`src/agent/inspection/*`, `src/agent/runtimeStatus/types.ts`, `src/agent/tools/inFlightUpdateTool.ts`)

Runtime status is user-visible but non-final. `EventInspection` subscribes to `AgentEvent` through `Agent.onAgentEvent`, defers processing via microtasks, formats configured event kinds, emits token usage on turn end when enabled, and emits complete thinking text on `thinking_end` when thinking inspection is enabled.

`in_flight_update` is a tool-call-driven progress/status path. It validates message length, optional next step, optional integer progress percent, stage, and dedupe key. On success it publishes `agent.runtime.inflight_update`; on validation or sink failure it returns structured failure details. The default prompt rule asks an assistant to pair this tool with other tool calls in the same batch.

## 4. Inter-Module Relationships and Communication

CLI entrypoint to Gateway is a direct synchronous construction plus awaited method call. There is no retry or timeout policy here; failures propagate to top-level catch. This boundary is intentionally thin.

Gateway to ConfigManager is direct async method calls. Startup creates or loads session files. Config validation failures are fatal for the mode because an invalid config can produce unsafe model/tool behavior. First-run missing config is handled as a guided setup path rather than an exception.

Gateway to ContextManager is direct async prompt assembly. Missing required prompt files are fatal with remediation text. Missing optional `SOUL.md` or `USER.md` triggers template recovery and warning logs. There is no retry loop because these are local filesystem operations.

Gateway to ToolAssembly/ToolRegistry is direct in-memory registration. The exchanged schema is `DescribedAgentTool`, which extends upstream `AgentTool` with optional `toolRulePrompt`. Duplicate names throw immediately. This is a startup-time transaction boundary: if tool registration fails, runtime creation should fail before accepting messages.

Ingress adapters to MessageBus communicate by direct `publish(envelope)`. Protocol is in-process method call. It is synchronous for validation and queue mutation, asynchronous for subscriber side effects. Invalid envelopes throw synchronously. There is no retry because producer code should construct valid envelopes.

MessageBus to AgentWorker communicates through `getUserMsgFromBus(sessionId, AbortSignal)`. This is async and event-driven. If a message is queued, it resolves immediately. If not, it stores a waiter and resolves when a future publish arrives. Ordering is FIFO per session. Abort rejects with an `AbortError`. There is no timeout policy; worker waits until message or abort.

AgentWorker to Agent communicates through `runCliTurn(text, channel, chatId, userId)`. Despite the name, it is used by both CLI and Telegram because the current agent path is text-oriented. Calls are awaited. Agent itself serializes concurrent calls with an internal promise queue, so the module pair has at-most-one-turn-in-runtime semantics.

Agent to pi-agent-core communicates by direct runtime API calls: `prompt`, `continue`, `abort`, `waitForIdle`, `replaceMessages`, `subscribe`, `state`. The protocol is upstream library object API. Retry strategy is delegated to upstream runtime/model configuration (`maxRetryDelayMs` exists in config type but is not set by gateway). Failure propagates to worker and becomes `[error]` output.

Agent to PersistenceCoordinator is direct async. Persistence append is best effort: append failure logs and does not abort the user turn. Compaction has a stricter internal boundary: it persists pending messages before replacing runtime state; if persistence does not reach the full cursor, compaction is skipped to avoid dropping unpersisted messages.

Agent/EventInspection to MessageBus communicates through a status publisher closure created by Gateway. This publishes `agent_to_user` runtime envelopes. It is asynchronous at inspection level via microtasks and synchronous at bus validation/queue mutation. Inspection failures are isolated and logged.

MessageBus to CLI Renderer and Telegram Relay communicates through subscriptions. Subscriber dispatch is deferred to a microtask. Matching is by direction, optional session id, and optional kinds. Subscriber exceptions are caught and logged. There is no retry, no timeout, and no circuit breaker. Telegram send failures are caught inside relay.

Normal CLI flow:
1. User enters a line in readline.
2. Gateway handles local slash commands or calls `publishCliUserMessage`.
3. Bus validates and enqueues `ui.user_message`.
4. Worker wakes or later dequeues by session.
5. Worker converts parts to text and calls `Agent.runCliTurn`.
6. Agent maps inbound to `AgentMessage[]`, invokes pi-agent-core, compacts/persists as needed, extracts assistant text.
7. Worker publishes `agent.assistant_message`.
8. CLI renderer prints `bot> ...`.

Normal Telegram flow:
1. Telegraf receives private text message.
2. Gateway rejects non-private or non-text messages early.
3. Gateway evaluates whitelist and active-chat policy.
4. First accepted chat lazily creates runtime with session `tg:<chatId>` and relay subscription.
5. Telegram ingress publishes `ui.user_message` with Telegram metadata.
6. Shared bus/worker/agent path runs.
7. Telegram relay forwards assistant and runtime status text to the active chat.

Failure scenarios:
- Invalid config: startup fails before worker starts.
- Missing first-run config: template is created and process exits with guidance.
- Non-whitelisted Telegram user: message is rejected and never reaches MessageBus.
- Different Telegram chat after activation: rejected without agent execution.
- Bus envelope invalid: publish throws; current producer path generally treats this as programming error.
- Agent turn failure: worker publishes `[error] ...`.
- Persistence restore failure: warning and empty/current context.
- Persistence append failure: error log and no cursor advancement.
- Subscriber/renderer failure: logged; other subscribers continue.
- Telegram send failure: warning; runtime keeps processing later messages.

Retry scenarios are minimal. No internal queue retry exists. Web search has provider fallback only for Tavily credit exhaustion. Bash has no retry. LLM retry/backoff, if any, is handled by upstream pi-agent runtime/model behavior.

Partial outages:
- Telegram API outage affects only Telegram relay/ingress; CLI mode is unaffected.
- Search provider outage affects only `web_search`.
- Persistence filesystem failure affects history durability/compaction but not immediate turn execution unless startup prompt files/config are unreadable.
- Event inspection failure affects only runtime status visibility.

Communication model rationale: direct method calls keep simple module boundaries; MessageBus is used only where decoupling producer/consumer timing matters.

## 5. Domain Model and Behavior Design

Core entities:
- Session: logical conversation runtime identified by `workspaceSessionId` such as `cli-stable-session`, `telegram-stable-session`, or active message session `tg:<chatId>`.
- WorkspaceBootstrapResult: filesystem roots and config path for a session.
- AppConfig: validated runtime configuration.
- BusEnvelope: typed transport unit with id, sessionId, timestamp, direction, source, kind, priority, payload, render hints, and metadata.
- UserToAgentPayload: non-empty array of text or image parts.
- AgentToUserPayload: non-empty text plus optional format/raw details.
- Agent: runtime wrapper around pi-agent-core state and methods.
- AgentWorker: session-bound consumer/executor.
- ToolRegistry: ordered set of unique tools.
- DescribedAgentTool: executable tool plus optional rule prompt.
- PersistedMessageRecord: JSONL record containing one `AgentMessage`.
- SkillMetadata: skill name, description, and `SKILL.md` location.

Relationships and ownership:
- Gateway owns the live SessionRuntime bundle.
- AgentWorker owns session consumption from MessageBus but does not own bus storage.
- Agent owns pi-agent-core state and persistence cursor coordination.
- MessageBus owns envelopes only while in memory; persistence stores agent messages, not bus envelopes.
- ConfigManager owns app config shape and workspace bootstrap paths.
- ContextManager owns prompt section assembly but not the contents of user-authored prompt files.

Important invariants:
- `user_to_agent` envelopes may only use `ui.user_message`.
- `agent_to_user` envelopes may only use assistant/runtime kinds.
- User payload parts must be non-empty and each part must be text or image.
- Agent payload text must be non-empty.
- Per-session user ingress consumption is FIFO.
- A worker consumes only its configured `sessionId`.
- Agent turns are serialized through `runExclusive`.
- Startup restore and compaction windows must end at an assistant turn end.
- Thinking-only assistant content must not be shown as final user output.
- Telegram messages from non-whitelisted users must not reach agent execution.
- Filesystem writes/edits must stay within workspace when restriction is enabled.

State machines:
- CLI process: not started -> bootstrap -> first config created exit or loaded -> worker running -> exit command/finally -> stopped.
- Telegram process: not started -> bootstrap -> config resolved -> polling -> first accepted chat activates runtime -> active runtime -> signal/normal exit -> stopped.
- AgentWorker: stopped -> running with waiter/turn loop -> aborting -> stopped.
- Agent turn: inbound received -> memory assembled -> prompt invoked -> assistant message found -> outbound mapped -> pending persistence/compaction -> complete.
- Persistence context: empty/current -> restored tail -> pending messages accumulate -> persisted on stop/compaction -> compacted tail replaces runtime messages when watermark exceeded.

Allowed transitions:
- `/clear` in CLI can stop runtime and rebuild it.
- Telegram can activate from no active chat to one active chat.
- Agent can abort/wait/stop from running state.
- Config can be updated/saved through `ConfigManager`, but runtime uses loaded clone values.

Forbidden transitions:
- Telegram non-private chats cannot enter runtime.
- Telegram other chat cannot replace active chat during one process run.
- Add-on tool registration cannot succeed in this phase.
- Config legacy shapes such as provider-level `model`, `modelFactoryDefaults`, `params.agent`, and `params.stream` are rejected.
- Context compaction cannot drop messages unless pending messages were persisted.

Business rules:
- Empty CLI/Telegram messages are ignored.
- Telegram whitelist uses `from.id`, not `chat.id`, despite field name `allowedChatIds`.
- `web_search` falls back to Linkup only for Tavily credit/usage exhaustion.
- Tavily 429 does not trigger Linkup fallback.
- `in_flight_update` messages are 1-280 trimmed chars and progress percent must be integer 0-100.
- `edit_file` requires unique old text or explicit occurrence.
- `write_file` create mode fails if the file exists.

Domain logic is partially protected from infrastructure leakage by module boundaries. For example, Gateway does not inspect pi-agent-core message internals, AgentWorker does not know config file paths, and MessageBus does not know Telegram APIs. Some leakage remains: `runCliTurn` naming is CLI-specific even though Telegram uses it, and image parts are degraded to text placeholders.

Consistency boundaries are local. A single bus publish synchronously validates and mutates queues before subscribers run. A single agent turn is serialized within one Agent instance. Persistence append and runtime context replacement are not one atomic transaction across filesystem and memory, but compaction is ordered to persist before dropping.

## 6. Data Architecture

There is no database technology in the current implementation. Durable data uses local JSON and JSONL files. This is justified by the local-first runtime, low concurrency, and human-editable configuration needs.

Schema structure:
- `config.json`: JSON matching `AppConfig` with `schemaVersion`, `ingress`, `agent`, `tools`, and `eventInspection`.
- `session.jsonl`: one JSON object per line matching `PersistedMessageRecord`.
- `AGENTS.md`, `SOUL.md`, `USER.md`: Markdown prompt/context files.
- `history.md`: reserved for transcript persistence but not actively written by current code.
- `skills/*/SKILL.md`: Markdown with YAML frontmatter.

Indexing and partitioning:
- No indexes exist.
- Persistence is partitioned by session directory and also records `sessionId` per line.
- At read time, records for unexpected sessions are skipped defensively.
- MessageBus partitions ingress in memory by `sessionId`.

Migration strategy:
- Config has `schemaVersion: 1`, but no migration runner exists.
- Validation rejects known legacy/removed fields rather than migrating them.
- JSONL records require `schemaVersion: 1`; unsupported records are skipped.
- v2 should add explicit config migration if schema evolution becomes user-facing.

Backward compatibility rules:
- Provider model config now requires `models: [{ name, params? }]`; legacy provider-level `model` is not accepted.
- Removed config keys fail fast with actionable errors.
- Event inspection thinking uses `eventInspection.thinking`, not removed `agent.runtimeStatus`.
- Telegram docs preserve `allowedChatIds` field name but define user-id semantics.

Data lifecycle:
- Config/templates are created if missing during session bootstrap.
- Prompt scaffold files `SOUL.md` and `USER.md` are recreated if missing during context assembly.
- `session.jsonl` grows append-only; no archival, pruning, or deduplication exists.
- In-memory context is compacted, but persisted JSONL is not compacted.

Caching:
- No explicit cache layer exists.
- ConfigManager stores a validated config clone in memory.
- ToolRegistry stores ordered tools in memory.
- Skills are scanned during prompt assembly, not cached across runtime rebuilds.
- MessageBus queues are transient in-memory state.

Consistency model:
- Strong in-process consistency for current JS event-loop operations.
- Eventual/best-effort consistency for persistence because append failures do not abort turns.
- No cross-process consistency is provided.

## 7. API and Contract Design

Public CLI API:
- `mahabot cli`: starts CLI runtime.
- `mahabot telegram`: starts Telegram runtime.
- `mahabot help`, `-h`, `--help`: prints usage.

CLI in-session commands:
- `/help`: show help.
- `/clear`: rebuild conversation runtime and reload system prompt.
- `/exit`, `exit`, `quit`, `:q`: stop CLI mode.

Telegram public behavior:
- Private text messages from whitelisted users are accepted.
- Non-private chats receive a private-text-only notice.
- Non-whitelisted users receive access denied.
- Other chats after activation receive active-chat rejection.
- Assistant output and runtime status are forwarded as Telegram text messages.

Internal MessageBus API:
- `publish(envelope)`: validates and routes envelope.
- `getUserMsgFromBus(sessionId, signal?)`: resolves next user message for one session.
- `subscribe(handler, filter?)`: registers subscriber and returns unsubscribe function.
- `getQueues()`: returns diagnostic snapshots.

Envelope schema:
- Shared fields: `id`, `sessionId`, `ts`, `direction`, `source`, `kind`, `priority`, `payload`, optional `renderHints`, optional `meta`.
- Directions: `user_to_agent`, `agent_to_user`.
- Priorities: `high`, `normal`, `low`.
- User kind: `ui.user_message`.
- Agent kinds: `agent.assistant_message`, `agent.runtime.event`, `agent.runtime.token_usage`, `agent.runtime.inflight_update`, `agent.runtime.thinking`.

Tool API contracts are upstream `AgentTool` objects with `name`, `label`, `description`, `parameters`, and async `execute(toolCallId, params, signal?)`. Tool results use text content plus structured `details`. Filesystem tools share `ok`, `errorCode`, and `resolvedPath` patterns.

Config API is file-based JSON. Validation is the compatibility enforcement mechanism. There is no HTTP API and no API version negotiation beyond config `schemaVersion`.

Error model:
- Startup/config errors throw with actionable text.
- Tool errors usually return structured tool results instead of throwing, except intentionally failing showcase tools or unexpected runtime errors.
- Worker turn errors become assistant messages.
- Bus validation errors throw synchronously.

Authentication and authorization:
- CLI has no authentication.
- Telegram authenticates implicitly through Telegram identity and authorizes through configured user-id whitelist.
- LLM/search providers authenticate with API keys from environment variables.
- Filesystem/shell tools authorize by workspace path policy, not by user roles.

Rate limiting:
- No app-level rate limiting exists.
- External providers may rate limit.
- `web_search` limits result count and provider fallback, but not call frequency.

Internal event contracts:
- Topic naming is represented by `kind` strings rather than external topics.
- Schema evolution should add new `MessageKind` variants and validator coverage together.
- Consumers are isolated by subscription filters and handler try/catch, but not by process boundary.

## 8. Security Architecture

Authentication:
- CLI mode relies on local machine access.
- Telegram mode relies on Telegram sender identity plus configured whitelist.
- Provider APIs rely on environment-variable API keys.

Token/session model:
- There is no user session token inside mahabot.
- Runtime sessions are logical ids used for routing and persistence.
- Telegram bot token is read from the env var named by `ingress.telegram.botTokenEnvVar`.
- LLM provider keys are read from env vars named by provider config.

Authorization model:
- Telegram user-id whitelist is the only human authorization gate.
- Tool execution authorization is policy-based: workspace restriction, bash blacklist, command risk filters, path canonicalization, and extra allowed root for builtin skills.
- There are no roles, role hierarchy, tenant permissions, or per-tool user permissions.

Multi-tenant isolation:
- Not implemented as a hosted concept.
- Session ids isolate bus consumption and persistence directories in a single-user local runtime.
- Telegram V1 deliberately allows only one active chat per process run.

Encryption:
- In transit to Telegram, LLM providers, Tavily, and Linkup depends on HTTPS used by those libraries/APIs.
- At rest, config, prompts, and JSONL are plain local files. No app-level encryption exists.
- Key management is external to the app through environment variables.

Audit logging:
- No formal audit log exists.
- `session.jsonl` persists agent messages, not bus envelopes, tool policy decisions, or Telegram identity metadata.
- Warnings/errors go to console.

Threat model and mitigations:
- Prompt injection through user text or web/tool output: partially mitigated by system prompt rules, not technically eliminated.
- Unauthorized Telegram access: mitigated by user-id whitelist and private-text-only support.
- Accidental filesystem damage: mitigated by workspace restriction, path canonicalization, atomic writes, SHA preconditions, create mode, and exact edit matching.
- Destructive shell commands: mitigated by command blacklist, git destructive blacklist, high-risk pattern rejection, workspace working-dir checks, timeout, and output truncation.
- Secret leakage: mitigated by env-var indirection, but prompts/tools could still expose env-derived behavior if future tools read env unsafely.
- Denial of service: unbounded bus queues and JSONL growth are current risks.

Attack surface:
- CLI stdin.
- Telegram bot messages.
- Config files and prompt files edited by user.
- Tool parameter execution.
- External search result content.
- LLM provider output/tool-call requests.
- Local filesystem paths and symlinks.

## 9. Non-Functional Design

Performance targets are not explicitly defined in code. The practical expectation is interactive personal-agent latency, dominated by model and tool calls. Internal bus and mapping operations should be negligible relative to LLM latency.

Scalability strategy is vertical and local. The code supports per-session maps but gateway policy is single active session per process mode. v2 scaling would need queue limits, worker pools, durable queueing, isolated runtime per session, and memory controls.

Load behavior:
- Bus queues are unbounded arrays.
- Subscribers run in microtasks, which prevents inline blocking but can still accumulate work under heavy publish rates.
- Bash output is byte-limited.
- Read/search/list/glob tools bound output and traversal by maxBytes/maxResults/maxFiles/maxDepth/maxEntries.
- Web search result count is capped at 10.

Backpressure:
- No central backpressure exists.
- Tool-level bounds are the main local backpressure mechanism.
- Agent turn serialization prevents concurrent turns from the same Agent instance, but incoming bus messages can still queue.

Resilience:
- Defensive catch/log patterns are common around optional observers and egress.
- Abort signals are used for worker waiting and bash command execution.
- Persistence failure degrades without killing the process.

Availability target:
- Code-verified: no SLO/SLA.
- Inferred: best-effort local availability while process and dependencies are running.

Observability:
- Runtime status can be surfaced through MessageBus and egress channels.
- Event inspection is configurable per event kind.
- Token usage can be emitted on turn end when enabled.
- Thinking can be emitted on thinking end when enabled.
- Tool inspection formatters compress tool I/O to short snippets.

Logging:
- Uses console warn/error/debug/info abstractions.
- User-visible status uses bus envelopes, not raw logger output.
- Telegram explicitly does not forward debug logger output.

Metrics/tracing:
- No metrics backend or distributed tracing exists.
- Token usage status is the closest metric-like event.
- Bus queue snapshots are available for tests/diagnostics.

Bottlenecks:
- LLM provider latency and rate limits.
- Shell subprocess timeout and output truncation.
- Recursive grep/glob/list operations on large workspaces.
- Append-only `session.jsonl` read-all startup restore.
- Telegram send throughput and provider limits.

## 10. Configuration and Environment Design

Environment separation is session-directory based, not deployment-environment based. CLI and Telegram use stable session ids and separate `~/.mahabot/<session>/` roots. There are no explicit dev/staging/prod profiles.

Configuration injection:
- `.env` is loaded at process start by `dotenv`.
- Config file is loaded from the session root selected by bootstrap.
- API keys are read from environment variables named by config.
- Template root can be overridden by `MAHABOT_TEMPLATE_ROOT`.

Feature flags:
- `ingress.telegram.enabled` gates Telegram mode.
- `tools.restrictToWorkspace` gates filesystem/bash workspace restrictions.
- `eventInspection.useEventInspection`, `showTokenUsage`, include flags, and `thinking.enabled` gate runtime status visibility.
- There is no rollout service or dynamic feature flag backend.

Rollout strategy:
- Current rollout is local config edit plus restart.
- `/clear` reloads prompt/runtime but not full process environment.

CI/CD:
- Package scripts define build and test.
- Tests use Node's built-in test runner through `tsx`.
- No GitHub Actions or deployment pipeline is visible in the repository.

Infrastructure as Code:
- None.

Blue/green/canary:
- None. A future hosted version would need process supervisor, health checks, config migration, and separate runtime deployments.

## 11. Dependency Graph and Technology Stack

Languages and runtime:
- TypeScript, target ES2022.
- Node.js >= 20.
- ESM package (`"type": "module"`).

Main dependencies:
- `@mariozechner/pi-agent-core`: agent runtime, message/event/tool contracts, thinking levels.
- `@mariozechner/pi-ai`: model lookup, model type, schema `Type`.
- `dotenv`: environment variable loading.
- `telegraf`: Telegram bot long polling and messaging.
- `yaml`: YAML frontmatter parsing for skills.

Dev dependencies:
- `tsx`: execute TypeScript tests/dev commands.
- `typescript`: compile source.
- `@types/node`: Node typings.

Internal dependency layering:
- `src/cli.ts` depends on gateway.
- Gateway depends on config, context, messageBus, agent, worker, tools, ingress/egress adapters.
- Agent depends on config model factory, runtime factory, tools, mappers, persistence.
- Runtime factory depends on upstream pi-agent-core and pi-ai.
- Context depends on config, skills, and tool registry.
- Tools depend on pi-ai `Type`, shared filesystem helpers, and runtime status types.
- MessageBus is intentionally low-level and should not depend on gateway/agent/tools.

Layering rules for v2:
- Keep MessageBus independent of ingress/egress implementations.
- Keep Gateway as composition root; avoid putting runtime construction in adapters.
- Keep tools self-contained with explicit runtime context.
- Keep config validation before runtime construction.
- Preserve tests as executable contracts when changing bus, persistence, Telegram, and filesystem tools.

Version constraints:
- Node engine is `>=20.0.0`.
- Package dependencies use caret versions. v2 upgrades should run full test suite because upstream agent/model contracts may change.

Breaking change policy:
- Config breaking changes should be either rejected clearly as current code does or migrated explicitly.
- MessageBus kind/payload changes require validator and tests together.
- Tool schema changes are prompt/runtime contract changes and should be treated as breaking for existing agent behavior.

## 12. Failure Analysis

CLI entrypoint single point of failure: if command parsing or Gateway construction fails, no runtime starts. Recovery is fixing command/config and rerunning. RTO is manual restart time; RPO is unaffected except unsaved runtime messages.

Gateway single point of failure: it is the composition root. Bad config, missing templates, prompt read failures, or runtime construction failures stop startup. Recovery is fixing filesystem/config/env. RTO is local fix plus restart. RPO depends on last successful `session.jsonl` append.

MessageBus risks: all queues are memory-only and unbounded. Process crash loses queued bus envelopes. A flood can grow arrays and memory. Subscriber failures do not cascade, but validation failures in producers can interrupt the producing path. Disaster recovery is process restart; no queued message recovery exists.

AgentWorker risks: one worker loop per session means a stuck agent turn blocks later messages for that session. Abort on stop helps shutdown, but there is no per-turn timeout in worker. Recovery is abort/restart. User-visible degradation is delayed or `[error]` responses.

Agent/pi-agent-core risks: upstream model/runtime failure blocks core functionality. Missing assistant message throws. Tool-call loops and provider latency dominate availability. Recovery is provider config fix, credential fix, or restart.

Persistence risks: `session.jsonl` append failure loses durable history for those messages. Read-all startup can slow down as file grows. Malformed records are skipped; malformed trailing line is tolerated. Backup is whatever local filesystem backup the user has. No restore command exists beyond reading JSONL on startup.

Config/template risks: missing template files break bootstrap unless another candidate root contains them. User-edited invalid config fails fast. Backup is manual/local. v2 should avoid storing real default personal Telegram ids in shipped templates if broader distribution is intended.

Context/prompt risks: prompt files can become stale, missing, or maliciously edited. Required `AGENTS.md` failure stops startup. Optional prompt files recover from templates. Wrong prompt content can cause agent misbehavior without code errors.

Telegram risks: bot token missing, Telegram outage, polling failure, send failure, non-private messages, or unauthorized users. Current process logs middleware errors and send failures. One active chat policy prevents multi-chat contention but limits availability.

Tools risks:
- Bash is highest risk for destructive or hanging commands; mitigations are blacklist, workspace checks, timeout, output truncation, and abort.
- Filesystem tools risk unintended writes; mitigations are workspace policy, atomic writes, create/append modes, SHA preconditions, exact matching.
- Web search risks provider outage/credit exhaustion; fallback exists only for Tavily credit exhaustion.
- Event/in-flight status risks chat/terminal noise; config can disable inspection, but Telegram forwards all status envelopes for the session.

Disaster recovery:
- There is no automated DR.
- Manual recovery means restart process, fix config/env/files, and rely on existing `session.jsonl`.
- RTO: minutes for local restart and config fixes.
- RPO: last successfully appended messages; queued bus messages and current in-flight turn may be lost on crash.

## 13. Versioning and Evolution Strategy

Semantic versioning is not formally enforced beyond `package.json` version `0.1.0`. For v2, treat public CLI commands, config schema, MessageBus envelope schema, tool schemas, and JSONL records as versioned contracts.

API evolution:
- Add new CLI commands without changing existing `cli`, `telegram`, and `help`.
- Add new MessageBus kinds by updating type union, validator, renderers/relays, and tests.
- Add new tools only through `ToolAssembly` and `ToolRegistry` so prompt rules and uniqueness are preserved.
- Rename `runCliTurn` only with compatibility care because Telegram currently uses it.

Database/file migration governance:
- Config schema should gain explicit migration when `schemaVersion` changes.
- JSONL record schema should support forward-compatible skipping or migration.
- Append-only history may need compaction/archive tooling before long-running usage.

Backward compatibility validation:
- Maintain tests for config slimming, Telegram ingress/egress/runtime config, MessageBus FIFO/waiters, persistence window alignment, message mapping, and tools.
- Add contract tests whenever modifying envelope or tool result details.

Contract testing model:
- Current Node tests already encode important contracts.
- v2 should add integration tests for full CLI bus-worker-agent path with mocked model runtime if upstream runtime can be stubbed.
- Telegram should remain adapter-tested without hitting real Telegram API.

Deprecation timelines:
- None currently documented.
- Future deprecations should fail with explicit messages for at least one minor cycle if this becomes distributed to users.

Compatibility enforcement:
- ConfigManager is the enforcement point for config compatibility.
- kindRegistry is the enforcement point for bus compatibility.
- Tool parameter schemas and tests are enforcement points for tool compatibility.
- TypeScript strict compilation catches many internal contract breaks.

## 14. Formal Consistency and Invariants

System-wide invariants:
- Exactly one gateway mode is active per process invocation: CLI or Telegram.
- Runtime construction must occur after config load/validation.
- Tool registry names must be globally unique.
- Add-on tool registration is disabled in this phase.
- User-visible final output must come from assistant text extraction, not thinking blocks.

Data invariants:
- Config root must be a JSON object with numeric `schemaVersion`.
- Enabled provider/model pairs for active and default config must exist.
- `compactLowWatermarkTokens < compactHighWatermarkTokens`.
- Telegram allowed ids normalize to non-empty strings.
- JSONL records must have `schemaVersion: 1`, matching `sessionId`, finite `persistedAt`, and object message.
- Bus envelopes must have valid id/session/source/priority/direction/kind/payload.

Transaction invariants:
- Bus `publish` validates before routing.
- Per-session user messages are consumed FIFO.
- A waiting worker receives exactly one next message for its session.
- Agent turns are serialized per Agent instance.
- Context compaction must persist pending messages before replacing runtime messages.
- Compacted/restored context windows must align to completed assistant turns.

Security invariants:
- Non-whitelisted Telegram users must not publish agent-executed messages.
- Telegram V1 must not execute messages from a different chat after activation.
- Filesystem tools must reject outside-workspace paths when restricted, except `read_file` may read builtin skill files.
- Bash must reject configured destructive and high-risk command patterns.
- Provider secrets are obtained from env vars, not from committed config secret values.

Operational invariants:
- Worker stop must abort pending bus waiters and exit the loop.
- Event inspection must not throw into agent runtime callbacks.
- Subscriber failure must not prevent other subscribers from receiving future messages.
- Telegram send failures must not crash the process.
- Persistence restore/append failures must degrade gracefully and log.

Verification approach:
- Keep `npm test` green as the minimum executable consistency check.
- Use targeted tests around bus, persistence, gateway adapters, and tool policy before changing those modules.
- When adding runtime modes, preserve the existing normalized bus contract so AgentWorker/Agent behavior remains reusable.
- When adding persistence migrations, test malformed, mixed-session, old-version, and trailing-partial-line cases.

For a coding agent reading this project, the practical path is: start with `src/gateway/manager.ts` for runtime wiring, then `src/messageBus/*` for transport semantics, then `src/agent/worker/agentWorker.ts` and `src/agent/agent.ts` for turn execution, then `src/config/*` and `src/context/*` for startup/prompt behavior, and finally the specific adapter/tool/persistence module relevant to the requested change.

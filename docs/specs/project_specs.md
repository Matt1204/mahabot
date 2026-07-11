# Mahabot Project Specification (v1 Baseline for v2 Engineering)

This document describes the current `mahabot` repository as implemented in `src/` and verified against the tests under `tests/`. It is written for an engineering team using the present implementation as version `v1` and planning compatible changes, refactors, or a future `v2`.

Conventions used below:

- **Code-verified** means the behavior was confirmed from the current source or tests.
- **Inferred** means the behavior is not fully enforced by code, but follows from the implemented design.
- File references are repo-relative.

## 1. System Boundary and Context Analysis

`mahabot` is a local-first, single-process TypeScript/Node.js assistant runtime. Its purpose is to receive user input from supported channels, normalize it into an internal message-bus contract, execute an LLM agent with tools and prompt context, persist conversation turns in SQLite, and deliver assistant output plus optional runtime status back to the user.

The current operating ecosystem is Node.js `>=22.5.0`, TypeScript ESM with `NodeNext` module resolution, Telegraf long polling for Telegram, `@mariozechner/pi-agent-core` for agent orchestration, `@mariozechner/pi-ai` for model and tool schemas, Node's built-in `node:sqlite` `DatabaseSync`, local filesystem state under `~/.mahabot/<session>/`, and environment variables for provider credentials.

External actors are human CLI users, whitelisted Telegram users, Telegram Bot API, LLM providers configured in `agent.llmProviders`, OpenAI-compatible audio transcription used for Telegram voice messages, Tavily and Linkup search APIs, local shell and filesystem facilities, and `ffmpeg` for audio conversion. Telegram supports private text, photo, and voice messages. Group chats and unsupported message types are rejected at ingress.

Inside the system boundary are the CLI entrypoint, gateway manager, CLI and Telegram ingress adapters, Telegram media storage and voice transcription adapters, CLI and Telegram egress adapters, Telegram runtime-command parsing and control, in-memory message bus, agent worker loop, agent runtime wrapper, model factory, context assembly, skills catalog, tool registry and tools, event inspection, structured logging, SQLite persistence, onboarding checks, and tests.

Outside the system boundary are Telegram infrastructure behavior, bot account provisioning, LLM provider internals, OpenAI transcription service internals, Tavily/Linkup availability and billing, `ffmpeg` installation, OS-level file permissions, and any hosted deployment architecture. There is no HTTP server, webhook listener, external queue, external database server, container definition, or multi-region deployment in `v1`.

Boundary-crossing data flows are concrete and directional. CLI text enters through stdin and becomes `user_to_agent/ui.user_message` with a text part. Telegram text enters through Telegraf and becomes a text part with origin `telegram_text`. Telegram photos are downloaded from Telegram, stored as local JPEG files under the session persistence tree, buffered until a text or voice message submits them, then sent as image parts plus text. Telegram voice files are downloaded to a temporary path, converted to MP3 with `ffmpeg`, transcribed through OpenAI-compatible transcription, deleted, and submitted as text origin `telegram_voice_transcript`. Agent output and runtime status leave the system through CLI rendering or Telegram `sendMessage`.

Trust boundaries are important. User content and Telegram media are untrusted. MessageBus validates envelope shape, but it is not an authorization layer. Telegram ingress enforces private chat plus allowed Telegram user ids before messages reach the runtime. Tool execution is the most privileged local boundary because bash and filesystem tools can affect the local machine; policy is enforced by workspace restrictions and command blacklists, but cannot prove every command is safe. Secrets are read from environment variables and should not be persisted. LLM and transcription calls send user content, images, tool outputs, and prompts to external providers.

Ownership boundaries are as follows. `gateway` owns process lifecycle and channel wiring. `gateway/commands` owns parsing recognized Telegram control tokens and mutating session-local inspection state; it does not persist config changes. `messageBus` owns envelope validation, queueing, and subscriber fanout. `agent/worker` owns user-message consumption and assistant envelope publication. `agent/agent` owns serial turn execution, runtime events, applied/runtime snapshots, model interaction, persistence hooks, and compaction. `config` owns defaults, validation, bootstrap paths, and credential env-var names. `context` owns prompt assembly. `tools` own tool schemas and execution policy. `logging` owns structured event normalization, redaction, console output, bounded NDJSON retention, and flush semantics. `ingress/telegram*` owns Telegram access, media buffering, download, and transcription preparation. `egress` owns channel rendering only.

## 2. Overall Architecture Design

The architecture style is a modular monolith with event-driven internal communication. One Node.js process owns ingress, message routing, agent execution, tools, persistence, observability, and egress. The implementation is modular because source boundaries are explicit: gateway, commands, bus, worker, agent runtime, config/context, persistence, media handling, tools, skills, inspection, and logging are separated by narrow interfaces.

This style fits `v1` because the product is a personal agent shell rather than a hosted service. LLM and tool calls dominate latency, so externalizing the message bus would not currently improve the critical path. The in-memory bus is still a useful extraction point for `v2`: if durable multi-process execution is needed, preserve the envelope contract first.

High-level structure:

```text
src/cli.ts
  -> MahabotGatewayManager
      -> ConfigManager.initializeSessionWorkspace/load
      -> session-scoped structured Logger
      -> InMemoryMessageBus
      -> ToolRegistry + assembleTools
      -> ContextManager.assembleSystemPrompt
      -> EventInspection
      -> RuntimeEventInspectionConfig + RuntimeCommandController
      -> Agent.createFromAppConfig
      -> AgentWorker.start

CLI ingress:
  readline text -> publishCliUserMessage -> MessageBus -> AgentWorker

Telegram ingress:
  Telegraf message -> access policy -> optional media handling
    -> publishTelegramUserParts -> MessageBus -> AgentWorker

Agent execution:
  AgentWorker -> Agent.runUserTurn -> mapper -> pi-agent-core
    -> model/tools -> assistant message -> MessageBus -> renderer/relay

Persistence:
  pi-agent-core state.messages -> MessagePersistenceCoordinator
    -> SqliteMessageStore -> persistence/session.sqlite

Observability:
  components -> structured Logger -> ConsoleLogSink
                                -> NdjsonLogStore -> persistence/logs/latest.ndjson
```

Runtime topology is a single Node.js process. CLI mode owns stdin/stdout and a readline loop. Telegram mode owns a Telegraf polling client, one active private chat per process run, a serialized message queue, a Telegram egress relay, a media store, a pending-image buffer, and a voice transcriber. Bash tool calls spawn child shell processes. Voice transcription spawns `ffmpeg` through `execFile` and then performs an HTTP transcription request. SQLite is embedded in-process, not a network service.

The scalability model is intentionally local. The bus has per-session FIFO queues and could technically hold multiple sessions, but gateway policy creates one CLI session or one active Telegram chat. There is no queue size limit, durable queue, rate limiter, worker pool, or horizontal scale. Telegram message handling is serialized by chaining `messageQueue` promises, which preserves predictable order but limits throughput to one Telegram message handler at a time.

Fault tolerance is defensive but local. Subscriber failures are caught and logged. Bus dispatch is deferred with `queueMicrotask`. Worker turn failures become user-visible assistant error messages. Event inspection failures are isolated. Persistence restore failures start without history; append failures log and keep running. Telegram formatted-send failure retries once as plain text. Voice temp files and converted MP3s are removed in `finally`. NDJSON writes are serialized and internal store errors fall back to console reporting. Shutdown stops workers, aborts the agent runtime, stops Telegraf, unsubscribes relays, clears pending images, flushes persistence, and flushes logs.

Deployment is npm-based. Development commands are `npm run cli`, `npm run telegram`, `npm run playground`, and `npm run dev`. Build is `npm run build`, which runs TypeScript compilation and copies config templates. The package binary is `mahabot`, pointing to `dist/cli.js`. Session files are created under `~/.mahabot/<sanitized-session-id>/`.

Multi-region operation is not applicable. A hosted `v2` would need durable ingress queues, identity/session isolation, hosted secret management, managed media storage, external persistence, idempotency, rate limiting, and explicit tenant boundaries before multi-region design would be meaningful.

The main trade-offs are simple operation versus limited isolation, in-memory routing versus message loss on process exit, long polling versus webhook scalability, SQLite durability versus single-process write assumptions, and local tool power versus local machine risk.

## 3. Complete Module Breakdown

### CLI Entrypoint (`src/cli.ts`)

The CLI entrypoint parses top-level commands and loads `.env`. It recognizes `cli`, `telegram`, `playground`, and help paths, delegates runtime work to `MahabotGatewayManager`, and reports top-level failures with `process.exitCode = 1`. It owns no agent state, persistence, or channel-specific logic.

### Gateway Manager (`src/gateway/manager.ts`)

The gateway manager is the lifecycle orchestrator. In both CLI and Telegram modes it bootstraps the session workspace, loads config, creates the in-memory bus, assembles tools, assembles the system prompt, creates event inspection, constructs the agent, and starts an `AgentWorker`.

In CLI mode it owns readline and local commands: `/help`, `/clear`, and exit aliases. `/clear` stops the current worker and agent, rebuilds the runtime with the same bus and session paths, and reloads the system prompt. It does not delete the SQLite history; it clears active runtime context by rebuilding the runtime.

In Telegram mode it runs onboarding checks, resolves bot token and whitelist, starts Telegraf long polling, accepts only private chats, allows only configured Telegram user ids, and locks a process run to the first accepted chat. It serializes message handling through a promise chain, which keeps photo buffering, voice transcription, command execution, and text publication ordered. Runtime construction also creates a structured logger, session-local event-inspection state, and a command controller bound to read-only agent snapshots.

### Telegram Runtime Commands (`src/gateway/commands/*`)

`parseRuntimeCommands` recognizes a fixed allowlist of slash commands only in contiguous leading and trailing token regions. It supports Telegram `@botname` suffixes, preserves unknown slash tokens in the remaining prompt, returns command order and origin, and avoids interpreting command-like text in the middle of prose. Recognized commands are `/context`, `/agent_state`, `/inspect`, `/inspect_all_on`, `/inspect_all_off`, `/inspect_tool_on`, `/inspect_tool_off`, `/inspect_thinking_on`, and `/inspect_thinking_off`.

`RuntimeCommandController` executes recognized commands synchronously. Read commands format the agent's current token-budget, applied-model, lifecycle, tool-count, and inspection snapshots. Mutation commands update only `RuntimeEventInspectionConfig`, a defensive-copy session object initialized from startup config. They do not write `config.json` or rebuild the agent. Command replies are sent directly through Telegram before any remaining prompt is published; command-only messages do not drain pending images or create agent turns. Enabling all inspection events intentionally excludes thinking, whose visibility has a separate explicit switch.

### Telegram Runtime Config and Access Policy

`telegramRuntimeConfig.ts` validates Telegram readiness: `ingress.telegram.enabled` must be true, `allowedChatIds` must be non-empty, and the configured bot token environment variable must exist. Although the config field is named `allowedChatIds`, code treats the values as allowed Telegram `from.id` user ids.

`telegramAccessPolicy.ts` enforces two decisions: reject non-whitelisted users, reject chats other than the active chat once activated, or accept and optionally activate the first valid chat. Authorization happens before runtime activation and before media download.

### Telegram Text, Image, and Voice Ingress

`telegramIngressAdapter.ts` publishes normalized `ui.user_message` envelopes for Telegram. Text parts carry origin `telegram_text`; voice transcript parts carry origin `telegram_voice_transcript`; image parts carry local file metadata and Telegram media metadata.

`TelegramMediaStore` downloads Telegram photos and voice files through `bot.telegram.getFileLink`. Photos are saved under `persistence/media/<safe-session-id>/images/<timestamp>_<message-id>_<file-unique-id>.jpg` and become image parts with `mimeType: image/jpeg`, optional caption, dimensions, and Telegram file ids. Voice files are saved temporarily under `persistence/tmp/<safe-session-id>/voice/`.

`TelegramPendingImageBuffer` buffers image parts per session until the next text or voice message submits them. Each new image extends the timeout window for that session. Expired images are removed from the buffer and their files are deleted when detected. A standalone photo only receives the acknowledgement "Image received. Send a text or voice message to submit it." and does not run an agent turn by itself.

`TelegramVoiceTranscriber` converts downloaded voice audio to mono 16 kHz MP3 using `ffmpeg`, checks the converted file against the 25 MB OpenAI audio upload limit, calls `OpenAiTranscriptionClient`, and deletes both original and converted temp files in a `finally` block. Missing transcription API keys, `ffmpeg` failures, and oversized audio become user-visible Telegram errors.

### CLI Ingress and Renderers

`cliIngressAdapter.ts` trims CLI text, ignores empty input, and publishes a high-priority `ui.user_message` with source `cli` and origin `cli`.

`cliRenderer.ts` subscribes to `agent_to_user` envelopes for one session. Assistant output is rendered with a bot prefix; status and thinking messages are rendered as plain or dim lines. The renderer does not consume user messages.

`telegramEgressAdapter.ts` subscribes to `agent_to_user` envelopes for one session. It converts Markdown-ish assistant text to Telegram-safe HTML, splits long messages around 3900 characters with a hard 4096-character cap, disables link previews, and falls back to plain text if formatted send fails.

`telegramTextFormatter.ts` parses Markdown with `remark-parse` and `remark-gfm`, renders safe HTML tags supported by Telegram, escapes unsafe HTML, allows only `http`, `https`, and `tg://user?id=` links, and renders tables into readable text forms.

### Message Bus (`src/messageBus/*`)

The message bus is the internal transport contract. Envelopes include id, session id, timestamp, direction, source, kind, priority, payload, optional render hints, and optional metadata. Valid user-to-agent payloads are non-empty arrays of text or image parts. Valid agent-to-user payloads require non-empty text and optional `plain` or `markdown` format.

`InMemoryMessageBus` keeps a global ingress diagnostic log, assistant egress log, status egress log, per-session ingress queues, waiters by session, and subscribers. `publish` validates, routes, and schedules subscriber dispatch in a microtask. `getUserMsgFromBus` resolves immediately from the session queue or parks a waiter that can be aborted. Delivery to workers is FIFO per session. Subscriber delivery is best-effort and failures are logged.

The bus does not persist messages, deduplicate ids, cap memory, authorize senders, retry subscribers, or provide exactly-once delivery across process boundaries.

### Agent Worker (`src/agent/worker/agentWorker.ts`)

`AgentWorker` bridges the bus and agent runtime. It owns one consume-execute-publish loop for one session. For each user envelope, it calls `agent.runUserTurn` with structured parts, channel, chat id, user id, and metadata. It publishes successful assistant output as `agent.assistant_message`; failures become `[error] ...` assistant messages. Stop uses `AbortController` so a parked bus waiter exits cleanly.

### Agent Runtime Wrapper (`src/agent/agent.ts`, `src/agent/runtime/*`, `src/agent/mappers/*`)

`Agent` wraps `@mariozechner/pi-agent-core` and adds application behavior: model resolution, provider credential checks, tool registration, serial turn execution, startup restore from SQLite, turn-end token tracking, context compaction, event subscription, inbound/outbound mapping, runtime abort, and pending-message persistence.

The mapper converts structured user parts into `AgentMessage` content. Text parts become text blocks. Image parts require the selected model to advertise image input support; otherwise the turn fails before calling the model. Supported images are read from local disk, base64 encoded, and sent as image blocks with `mimeType` and `sourcePath`; captions are emitted as preceding text blocks. Assistant responses expose text blocks to humans, summarize tool-call-only messages, and suppress thinking-only content from final output.

`agentRuntimeFactory.ts` creates a `PiAgent` with system prompt, model, thinking level, tools, optional transport hooks, and a default `convertToLlm` that passes only `user`, `assistant`, and `toolResult` roles to the LLM adapter.

### SQLite Message Persistence (`src/agent/persistence/*`)

Persistence is SQLite-based. `SqliteMessageStore` uses Node's built-in `DatabaseSync`, creates `messages(id INTEGER PRIMARY KEY AUTOINCREMENT, schema_version, session_id, persisted_at, message_json)`, enables WAL mode, and indexes `(session_id, id)`. Reads filter by session id and order by insertion id. Appends use `BEGIN IMMEDIATE` and commit all messages in one transaction or roll back on error.

`MessagePersistenceCoordinator` restores an aligned startup window only when the current runtime has no messages. It tracks a runtime cursor so only pending messages are appended. On turn-end token usage it records the current context size. If context size reaches the high watermark, it persists all pending messages, computes a target tail size from low/high watermark ratio, aligns the retained tail to completed turn boundaries, drops older in-memory messages, and adjusts the cursor. Append failures are logged and do not crash the agent.

`windowAlignment.ts` preserves turn safety: restored and compacted windows prefer starting on user boundaries and ending at completed assistant turns. A dangling final user message is not restored as a complete history tail.

### Config (`src/config/*`)

`ConfigManager` creates session roots under `~/.mahabot/<sanitized-session-id>/`, including `workspace`, `workspace/persistence`, `workspace/skills`, `config.json`, `AGENTS.md`, `workspace/SOUL.md`, `workspace/USER.md`, `persistence/history.md`, and `persistence/.keep`. Templates come from `MAHABOT_TEMPLATE_ROOT`, built `config_template`, source templates, or cwd source templates.

Config loading deep-merges user JSON over defaults, replaces arrays as wholes, and validates strictly. It rejects legacy provider-level `model`, provider-level `modelFactoryDefaults`, removed per-model keys, `agent.runtimeStatus`, and `tools.workspaceRoot`. It validates Telegram media config, provider/model pairs, context watermarks, web search env-var names, event inspection settings, and model override shapes. Model overrides allow `reasoning`, `input` containing `text` or `image`, `headers`, and `compat`.

`modelFactory.ts` resolves requested, active, and default provider/model pairs in that order. Built-in providers use `getModel`; custom OpenAI-compatible providers with `category: "openai"` and `baseUrl` get a synthesized `openai-completions` model with conservative defaults and optional overrides.

### Context and Skills

`ContextManager` reads `AGENTS.md`, `SOUL.md`, `USER.md`, tool rule prompts, runtime metadata, and skills summaries into the system prompt. The runtime section includes platform, Node version, Python version if available, workspace root, `history.md`, and `session.sqlite`. Missing `SOUL.md` or `USER.md` files are restored from templates when possible. Skills are loaded from workspace skills and built-in skills, then rendered into prompt context.

### Tools

The standard tool set is registered centrally by `ToolAssembly`: `show_runtime_info`, `web_search`, optional `in_flight_update`, `bash`, `read_file`, `grep`, `glob`, `write_file`, `edit_file`, and `list_tree`. Bash and filesystem tools are registered only when a workspace root is available. Add-on tool registration is intentionally disabled in this phase.

Filesystem tools resolve paths through workspace policy, reject invalid or outside-workspace paths when restricted, operate on UTF-8 text, use atomic writes where appropriate, and return structured details. Bash creates a fresh shell process per call, maintains a logical current working directory across successful calls, enforces timeout bounds, truncates output, blocks known destructive commands, blocks high-risk unverified command shapes when workspace-restricted, and verifies effective and next working directories remain allowed. `web_search` uses Tavily first and falls back to Linkup only when Tavily reports insufficient credits.

### Event Inspection and Runtime Status

`EventInspection` listens to pi-agent-core events through `Agent` and emits optional `agent.runtime.event`, `agent.runtime.token_usage`, and `agent.runtime.thinking` envelopes. It uses microtask deferral so inspection does not run inline with the agent event callback. Token usage emission is deduplicated by fingerprint. Thinking emission only supports `emitMode: "on_end"` and can truncate via `maxChars`.

Inspection reads a fresh immutable snapshot for each event, so Telegram inspection commands affect subsequent events without mutating static application config. Agent snapshots expose the resolved provider/model, image-input capability, thinking level, running/busy state, message count, persistence state, restore limit, last known context tokens, and configured compaction watermarks without exposing mutable runtime internals.

### Structured Logging (`src/logging/*`)

The logging subsystem accepts typed `LogInput` records and legacy strings. Typed records become `LogEvent` objects with generated id, timestamp, level, category, event name, component, summary, optional session/turn/message correlation, sanitized data, and normalized errors. Level filtering occurs before sinks. Accepted events reach `ConsoleLogSink`; persistence receives non-debug events by default and debug events only when `logging.debugEvents` is enabled.

`NdjsonLogStore` serializes append and compaction through one promise chain, retains at most `maxEntries`, optionally removes entries older than `maxAgeMs`, and compacts after configured write/time thresholds or at flush. Compaction parses valid records, writes a temporary file, then atomically renames it. Keys matching API-key, authorization, token, secret, or password patterns are redacted; buffers become byte counts and errors are normalized with optional stacks. This subsystem owns operational telemetry, while SQLite owns conversational `AgentMessage` durability.

## 4. Inter-Module Relationships and Communication

Ingress adapters communicate with MessageBus synchronously in-process by calling `publish`. The schema is `BusEnvelope<UserToAgentPayload>`. Validation failure propagates immediately as an exception. There is no retry because publish is local and deterministic once input is built. Idempotency is producer-owned; the bus accepts duplicate semantic messages if ids differ.

MessageBus communicates with AgentWorker through `getUserMsgFromBus(sessionId, signal)`. This is asynchronous and FIFO per session. Abort cancels parked waiters. There is no timeout policy at the bus layer and no durable retry. Ordering is guaranteed only within a single process and session queue.

AgentWorker communicates with Agent by direct async method call. It is sync in contract but async in execution because the agent calls models and tools. Agent-level `runExclusive` serializes turns, so concurrent caller attempts become ordered turns. Worker failures are caught and converted to assistant error envelopes; they do not poison the bus loop.

Agent communicates with pi-agent-core through direct library calls. User content is provided as `AgentMessage[]`; model/tool execution is owned by pi-agent-core. Agent subscribes to runtime events and never lets observer failures propagate into the runtime. Timeout and retry behavior for LLM transport are delegated to upstream runtime/model configuration, except bash and `ffmpeg` have local timeouts.

Agent communicates with SQLite through `MessagePersistenceCoordinator` and `SqliteMessageStore`. Appends are transactional. Restore reads are best-effort: invalid rows are skipped; store-level read failure starts without history. The consistency boundary is one append transaction containing the pending messages passed by the coordinator.

Telegram ingress communicates with Telegram Bot API through Telegraf. Downloads use `getFileLink` and `fetch`. Photo download failures produce Telegram replies and stop that message path. Voice download/conversion/transcription failures produce Telegram replies and do not publish a user message. Telegram egress sends one or more `sendMessage` calls; formatted send failure triggers plain-text fallback.

Telegram text first passes through the command parser after authorization and runtime activation. Recognized commands flow directly to `RuntimeCommandController` and then to `ctx.reply`; this is synchronous state access/mutation followed by asynchronous Telegram egress. Any remaining text proceeds to pending-image consumption and bus publication. The command path has no transaction with an agent turn: command replies occur first, and a later publication failure does not roll back inspection changes. Commands are idempotent state assignments except read commands; repeated enable/disable commands converge on the same snapshot.

Telegram photo-to-text flow is intentionally two-step. A photo message downloads and buffers image parts, but does not enqueue an agent turn. The next text or voice message consumes pending images if not expired, appends the trigger text, and publishes a single structured user turn. This gives the user a chance to send context for images.

Voice flow is photo-compatible. If pending images exist, the voice transcript submits them together with the transcript text. If pending images expired, their files are deleted and the transcript is processed alone.

Runtime status flows from pi-agent-core events or the `in_flight_update` tool to `publishRuntimeStatus`, then to MessageBus as `agent_to_user` status kinds, then to CLI or Telegram subscribers. Status is best-effort. A status publication failure is logged by the originating inspection/tool path where applicable.

There is no circuit breaker implementation. Partial outages degrade by component: Telegram send outage loses egress but not local runtime state; transcription outage blocks voice turns only; photo download outage blocks that photo only; web search provider outage returns tool errors or fallback results; SQLite append outage loses durability but not immediate conversation continuity; LLM outage produces a worker error response.

## 5. Domain Model and Behavior Design

Core domain entities are Session, BusEnvelope, UserToAgentPart, AgentToUserPayload, InboundMessageTemp, OutboundMessageTemp, AgentMessage, PersistedMessageRecord, TelegramPendingImageBuffer entry, and Tool result.

Operational domain values include `RuntimeEventInspectionConfigSnapshot`, `RuntimeContextSnapshot`, `AppliedAgentConfigSnapshot`, `AgentRuntimeLifecycleSnapshot`, and `LogEvent`. Inspection state is session-local and mutable only through its controller interface. Snapshot getters return copies so consumers cannot mutate ownership state indirectly. A `LogEvent` is append-only after creation and correlates activity by session, turn, and message identifiers where producers supply them.

A Session is identified by a sanitized string. CLI uses `cli-stable-session`. Telegram uses `tg:<chatId>` before sanitization by workspace bootstrap or media path sanitization. A session owns its workspace, prompt files, persistence database rows, skills root, and active agent runtime.

A BusEnvelope is the internal communication aggregate. Its invariant is direction-kind compatibility: `user_to_agent` may only use `ui.user_message`; `agent_to_user` may use assistant, event, token usage, inflight update, or thinking kinds. User payloads must contain at least one valid part. Agent payloads must contain non-empty text.

UserToAgentPart is either text or image. Text must be non-empty after trim and may identify origin as CLI text, Telegram text, or Telegram voice transcript. Image parts are local-file references with MIME type and optional Telegram metadata. The system currently supports image input only when the selected model declares image capability.

Telegram pending image state machine:

```text
empty
  -> add photo -> pending(images, expiresAt)
pending
  -> add photo before expiry -> pending(images + new image, refreshed expiresAt)
pending
  -> text/voice before expiry -> submitted and buffer empty
pending
  -> clear/take after expiry -> expired files deleted and buffer empty
```

Telegram runtime state machine:

```text
not ready
  -> onboarding ready + bot launch -> waiting for accepted private message
waiting
  -> whitelisted user in private chat -> active(chatId, sessionId)
active
  -> messages from same chat -> processed serially
active
  -> messages from other chat -> rejected
active
  -> SIGINT/SIGTERM/normal exit -> stopping -> stopped
```

Agent turn state is serialized. A user turn becomes one inbound temp message, then one or more LLM messages including memory/history, then a pi-agent-core prompt, then one assistant message, then one outbound temp message and one `agent.assistant_message` envelope. Forbidden transition: two turns should not execute inside one Agent instance at the same time; `runExclusive` enforces this.

Persistence invariants require rows to have `schemaVersion: 1`, matching session id, finite persisted timestamp, and parseable JSON object messages. Startup restore and compaction avoid dangling incomplete turns. The database is append-only in `v1`; compaction drops old messages from runtime memory but does not delete old SQLite rows.

Domain logic is mostly protected from infrastructure by mappers and adapters. Telegram file details stay in ingress/media modules until converted to generic parts. Agent logic consumes structured parts, not Telegraf contexts. Egress consumes generic agent-to-user payloads, not pi-agent-core messages.

## 6. Data Architecture

The database technology is embedded SQLite through Node's `node:sqlite` `DatabaseSync`. This is justified for a local-first single-process assistant because it provides durable structured persistence without a server and supports transactional appends. It requires Node `>=22.5.0`, which is reflected in `package.json`.

The schema is created lazily:

```sql
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  schema_version INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  persisted_at INTEGER NOT NULL,
  message_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_session_id_id
  ON messages(session_id, id);
```

Rows are partitioned logically by `session_id`, not by separate database files. The current gateway passes `persistence/session.sqlite` as the database path. Reads select one session and order by `id ASC`. Writes append one row per `AgentMessage`.

Migration strategy is minimal in `v1`: `schema_version` exists on each row, but there is no migration runner. Future schema changes should add explicit migrations and preserve read compatibility for `schema_version = 1` rows. Because `message_json` stores upstream `AgentMessage` shape, schema evolution must also account for pi-agent-core message shape changes.

Data lifecycle is append-only. `persistence/session.sqlite` retains all successfully appended messages unless manually deleted. Runtime compaction only reduces in-memory context. `history.md` is currently reserved in prompt context but not used for transcript writes. Telegram image files under `persistence/media/.../images` are retained after submission. Telegram voice temp files under `persistence/tmp/.../voice` are deleted after transcription attempts. Expired pending image files are deleted when expiry is detected by later message handling.

Operational logs use newline-delimited JSON at a configurable path resolved relative to the persistence root (default `logs/latest.ndjson`). Unlike messages, logs have bounded retention: compaction filters invalid/expired lines and keeps the newest configured number. Writes are ordered in-process, but log and message stores have independent transaction boundaries. There is no relational join; correlation relies on duplicated session/turn/message ids.

There is no cache layer beyond in-memory runtime state, message bus queues, and pending image buffer. There is no read/write separation. Consistency is strong within one SQLite append transaction and in-memory process ordering, but not durable for queued bus messages or pending image buffer state across process crashes.

## 7. API and Contract Design

There is no public HTTP API. The public user-facing interfaces are CLI commands and Telegram bot messages. Programmatic internal APIs are TypeScript module contracts.

CLI commands are:

- `mahabot cli` starts local CLI mode.
- `mahabot telegram` starts Telegram mode after onboarding checks.
- `mahabot playground` is recognized by the entrypoint if implemented in the CLI path.
- `/help`, `/clear`, and `/exit` are runtime CLI commands.

Telegram public contract accepts private text, photo, and voice messages only. Non-private chats receive a rejection. Non-whitelisted users receive access denied. Unsupported message types receive "Unsupported message type. Send text, voice, or photo." Photos are acknowledged and buffered; text or voice submits a turn. Voice is submitted as transcription text, not as audio bytes to the main LLM.

Telegram also exposes nine fixed runtime-control commands. `/context`, `/agent_state`, and `/inspect` are read-only snapshot queries. `/inspect_all_on|off`, `/inspect_tool_on|off`, and `/inspect_thinking_on|off` mutate ephemeral inspection state. Command tokens may appear at the leading or trailing edge, including an `@BotName` suffix. Unknown tokens remain agent input. There is no HTTP endpoint, topic namespace, or external event schema; internal message kinds act as the event namespace.

Internal bus contract:

```ts
type MessageDirection = "user_to_agent" | "agent_to_user";
type MessageKind =
  | "ui.user_message"
  | "agent.assistant_message"
  | "agent.runtime.event"
  | "agent.runtime.token_usage"
  | "agent.runtime.inflight_update"
  | "agent.runtime.thinking";
```

`UserToAgentPayload.parts` supports text and local-file image parts. `AgentToUserPayload` supports `text`, optional format, and optional raw metadata. Errors at the contract layer are thrown synchronously during `publish`.

Internal agent contract is `Agent.runUserTurn({ parts, channel, chatId, userId, metadata })`. The output is a `CliTurnResult` containing inbound, outbound, and a human-readable `cliMessage`. Naming still says CLI in a few places, but the method is now channel-neutral enough for Telegram.

Tool API contracts are pi-agent-core `AgentTool` objects with JSON-like schemas from `@mariozechner/pi-ai` `Type`. Tool outputs are text blocks plus structured details where helper functions provide them. Tool schema evolution should preserve tool names and parameter names unless a prompt and test migration accompanies the change.

Versioning policy is informal. Config has `schemaVersion: 1`; SQLite rows have `schema_version: 1`; this document is a `v1` baseline. There is no API deprecation framework yet.

Authentication and authorization are channel-specific. CLI has no authentication beyond local machine access. Telegram uses user-id whitelist plus one-active-chat policy. Tools have no per-user authorization because the process is single-user by design.

Rate limiting is not implemented. Telegram serialization provides natural backpressure but no limits. LLM provider and Telegram API rate limits are external failure modes.

## 8. Security Architecture

Authentication is local/process-based for CLI and Telegram user-id whitelist based for Telegram. The Telegram bot token is read from the configured environment variable. LLM and transcription API keys are read from configured environment variables. Search provider keys are read from configured environment variables by the web search tool. The code validates presence for active LLM providers and voice transcription at use time.

There is no session token, cookie, or web session model. Authorization granularity is coarse: a whitelisted Telegram user or local CLI operator can access the full configured agent and tools. There is no role hierarchy or per-tool permission model in `v1`.

Multi-tenant isolation is not implemented. The runtime is intended for one local user and, in Telegram mode, one active private chat per process. The bus can carry session ids, but secrets, workspace, and tool capabilities are process-global.

Encryption in transit relies on provider HTTPS and Telegram API transport. SQLite data and downloaded images are stored unencrypted at rest in the user's home directory. Temporary voice files are also stored unencrypted until deleted. There is no key management system, envelope encryption, or secure deletion.

Audit and operational visibility use structured console events and bounded NDJSON logs, bus diagnostic queues in memory, SQLite persisted agent messages, and retained Telegram image files. Log fields with secret-like keys are recursively redacted, and message bodies are generally represented by lengths/previews according to producer and config rather than indiscriminately persisted. Logs are not immutable or centrally collected, so they are operational evidence rather than a compliance audit trail.

Threat model:

- Prompt injection can arrive through user text, Telegram transcripts, image captions, web search results, and file contents read by tools. Mitigation is prompt/tool policy only; there is no automated content isolation.
- Local command risk exists through the bash tool. Mitigations include workspace restriction, destructive command blacklists, high-risk pattern rejection, timeout bounds, output truncation, and working-directory verification.
- Filesystem exfiltration risk exists if `restrictToWorkspace` is false or if allowed roots are expanded. The default is restricted.
- Telegram spoofing risk is mitigated by checking `from.id`, not username.
- Media handling risk includes large or malformed files. Voice conversion has timeout and size checks after conversion; photo download has no explicit size cap in code.
- Secret leakage risk exists if prompts or tools expose environment variables through shell commands or include secrets under innocuous field names. Structured log data redacts recognized secret-like keys, but that is not a general data-loss-prevention boundary.

Security-sensitive `v2` work should add per-tool policy, media size caps, encrypted persistence option, explicit secret redaction, and a clearer distinction between chat ids and user ids in config naming.

## 9. Non-Functional Design

Performance targets are not formally specified. Current practical targets are interactive latency for CLI and Telegram, bounded local tool execution, and prompt context kept below configured watermarks. LLM latency, transcription latency, Telegram downloads, and web search latency dominate normal user waits.

Scalability is limited by one process, one active Telegram chat, synchronous SQLite operations, serialized agent turns, serialized Telegram message handling, and in-memory unbounded queues. The design is adequate for personal use but not for many users or high media volume.

Backpressure is partial. Agent turns are serialized by `runExclusive`; Telegram message handling is serialized by `messageQueue`; bash and `ffmpeg` have timeouts. The message bus itself has no max queue size, and media downloads have no global concurrency or byte budget.

Resilience mechanisms include local try/catch boundaries, abortable waiters, graceful shutdown, SQLite transactions, WAL mode, formatted Telegram fallback, transcription temp-file cleanup, and best-effort persistence. Availability target is "best effort local process availability"; no SLA is encoded.

Observability combines user-visible runtime inspection with structured process logging. Event inspection can publish event, token usage, inflight update, and explicitly enabled thinking lines. Structured logs use stable categories and event names, correlation identifiers, console rendering, and retained NDJSON. There is no metrics backend, distributed tracing, alert transport, or health endpoint; inferred availability monitoring therefore remains manual log inspection.

Known bottlenecks are LLM calls, image base64 memory use for large photos, voice conversion and transcription, synchronous SQLite operations during append/read, shell subprocess duration, unbounded message queues, and Telegram 4096-character message splitting.

## 10. Configuration and Environment Design

Environment separation is session-directory based, not deployment-stage based. Each session workspace has its own `config.json`, prompt files, workspace, skills root, and persistence directory under `~/.mahabot`. There are no built-in `dev`, `staging`, or `prod` profiles.

Configuration injection uses JSON config plus environment variables. Defaults live in `src/config/types.ts`; templates live under `src/config/config_template`; user config is merged over defaults. Environment variable names are configurable for Telegram bot token, LLM provider keys, web search keys, and transcription key.

Feature flags are represented as config booleans rather than a feature-flag service. Examples are `ingress.telegram.enabled`, `tools.restrictToWorkspace`, `eventInspection.useEventInspection`, `eventInspection.showTokenUsage`, `eventInspection.thinking.enabled`, `logging.persist`, and `logging.debugEvents`. Telegram inspection commands overlay session-local state but deliberately do not modify startup config.

Rollout strategy is manual: edit config, run tests, build, and restart the process. There is no CI/CD definition in the repository beyond npm scripts. There is no infrastructure-as-code, blue/green, canary, or migration orchestration.

Config compatibility is intentionally strict. The validator rejects removed keys so stale config fails early with actionable errors. This is a good safety pattern for a local tool because silent config drift could otherwise produce surprising model/tool behavior.

## 11. Dependency Graph and Technology Stack

Programming language is TypeScript targeting Node ESM. Runtime dependency versions are managed by npm and `package-lock.json`. The declared Node engine is `>=22.5.0`, primarily because SQLite persistence uses `node:sqlite`.

Major dependencies are:

- `@mariozechner/pi-agent-core` `^0.57.1` for agent runtime, events, messages, tools, thinking, and model prompting.
- `@mariozechner/pi-ai` `^0.57.1` for model lookup and tool parameter schemas.
- `telegraf` `^4.16.3` for Telegram long polling and Bot API access.
- `dotenv` for environment loading.
- `unified`, `remark-parse`, and `remark-gfm` for Markdown-to-Telegram formatting.
- `yaml` parses skill frontmatter metadata.
- TypeScript, tsx, and Node types are dev dependencies.

Node built-ins provide SQLite, filesystem/path/process primitives, child processes, readline, locally generated identifiers, and fetch/FormData support; there is no ORM, web framework, or external logging SDK.

Internal dependency layering is roughly:

```text
cli
  -> gateway
    -> config, context, onboarding, messageBus, agent, tools, egress, ingress
agent
  -> config/modelFactory, persistence, runtime, mappers, tools, inspection
context
  -> config, skills, tool registry
tools
  -> filesystem/shared, runtimeStatus, external search APIs
logging
  -> console sink, NDJSON store (no gateway dependency)
messageBus
  -> no app-level modules
```

Lower-level modules should not import gateway. MessageBus should remain independent from agent and Telegram specifics. Telegram adapters should convert channel-specific data into generic parts before reaching agent code. Persistence should depend on agent message types but not on gateway or channel adapters.

Upgrade strategy should be conservative for pi-agent-core/pi-ai because their `AgentMessage`, model metadata, and event shapes are central contracts. Node upgrades must preserve `node:sqlite` behavior. Telegraf upgrades should be tested against text/photo/voice message shapes. Remark upgrades should be tested against Telegram HTML escaping.

Breaking change policy is currently enforced by tests and config validator, not by semver automation. Any change to bus envelope shape, config schema, SQLite schema, tool names, or Telegram flow should include tests and a migration note.

## 12. Failure Analysis

CLI entrypoint failure is simple: invalid command or manager failure prints an error and exits non-zero. There is no retry because the user can rerun locally.

Config failure is a startup blocker. First-run config creation exits with instructions. Invalid config throws with a specific message. Missing active provider credentials block agent construction. Missing Telegram bot token or whitelist blocks Telegram startup through onboarding/runtime config.

MessageBus failure is mostly validation failure. Invalid envelopes throw synchronously. Subscriber exceptions are isolated. Process crash loses all queued messages and pending waiters. There is no backup for in-memory queues.

Agent/model failure during a turn propagates to AgentWorker and becomes `[error] ...` output. A hung upstream model call depends on pi-agent-core/model transport behavior; the wrapper does not impose a universal model timeout. Agent stop aborts the runtime and waits for idle.

SQLite failure during restore logs a warning and starts without history. SQLite failure during append logs an error and keeps the live runtime. This protects interactivity but weakens RPO because recent turns may be lost if the process exits before persistence recovers. The database file itself has no automated backup.

Telegram Bot API failure can affect launch, download, replies, or egress. Middleware errors are caught by `bot.catch` or the serialized handler catch. Send failures log warnings. Download failures prevent the affected media message from entering the agent. If Telegraf launch fails, Telegram mode cannot operate.

Photo handling failure can leave no agent turn for that photo and may leave partial files only if write fails after directory creation; normal save writes the complete downloaded bytes. Pending images are runtime memory only, so process crash after photo acknowledgement but before text submission loses the buffer while image files may remain on disk.

Voice handling failure can occur at download, missing API key, missing `ffmpeg`, conversion timeout, conversion error, oversized MP3, or transcription HTTP failure. Temp files are deleted in `finally` after transcriber execution starts. If download succeeds but transcriber construction path throws before `finally`, the manager still catches and reports, but store-level temp cleanup depends on where the failure happened.

Bash tool failure returns structured tool output with exit code, timeout, stderr, or blocked reason. It does not crash the process. High-risk commands are blocked in restricted mode, but command parsing is pattern-based and not a formal shell sandbox.

Runtime command failure is narrowly scoped because parsing is pure and execution reads in-memory snapshots. A Telegram reply failure may leave an inspection mutation applied even though its acknowledgement was not delivered. Since these settings are ephemeral and converge under repeated commands, recovery is to retry the command or restart the session. Unknown commands never mutate runtime state.

Logging failure does not intentionally fail an agent turn. NDJSON operations run on a serialized chain and report internal failures to the configured console callback. A process crash can lose queued-but-unflushed log lines; shutdown calls `flush`, which drains and compacts. Corrupt NDJSON lines are omitted during compaction. Inferred RPO for logs is the last completed append, and RTO is immediate console-only operation plus repair/removal of the log file.

Disaster recovery is manual. Users can delete or copy `~/.mahabot/<session>/`, restore `config.json` and prompt files, and preserve or replace `persistence/session.sqlite`. RTO is the time to restart the process and restore config. RPO is last successful SQLite append for conversation state; pending bus messages and pending image buffers have RPO of zero because they are not durable.

## 13. Versioning and Evolution Strategy

The project package version is `0.1.0`. There is no formal semantic-version release policy, but `v2` should treat current config, bus, tool, and persistence contracts as compatibility surfaces.

API evolution should preserve bus direction/kind semantics and add new `MessageKind` or `UserToAgentPart` variants only with validator, mapper, worker, renderer, and tests updated together. Existing part types should remain backwards compatible because persisted and test fixtures may depend on them.

Database evolution should add a migration runner before changing the `messages` table. `schema_version` should be used to support old rows. A safe path is additive migrations first, followed by read support for multiple versions, followed by optional compaction or export tooling.

Config evolution should continue the current fail-fast approach for removed keys, but provide migration guidance in error messages. Rename `allowedChatIds` or add `allowedUserIds` carefully because current code semantics are user-id based despite the old name.

Model evolution must preserve image capability detection. If future models represent multimodal support differently than `model.input.includes("image")`, update `supportsImageInput` and tests so Telegram photos do not silently degrade.

Contract testing should cover text turns, Telegram photo buffering and expiry, voice transcription success/failure with mocked clients, SQLite restore/append/invalid rows, model image support gating, Telegram formatting fallback, bus validation, and tool policy boundaries.

Current tests additionally pin command edge parsing, runtime inspection mutation semantics, controller reply formatting, event inspection snapshot refresh, structured log filtering/redaction/retention, skill parsing/catalog behavior, context prompt integration, persistence window alignment, and detailed behavior of bash/read/grep/glob/web-search tools. These are compatibility tests even where no external API exists.

Deprecation timelines are not implemented. For a local tool, a practical rule is to support one config schema migration path for at least one minor version and refuse ambiguous legacy shapes with clear remediation.

## 14. Formal Consistency and Invariants

System-wide invariants:

- One `AgentWorker` consumes one session queue and publishes assistant output for that session.
- One `Agent` instance executes turns serially through `runExclusive`.
- Telegram mode has at most one active chat per process run.
- Unsupported or unauthorized Telegram messages never reach the agent.
- A command-only Telegram message never becomes an agent turn and never consumes pending images.
- Runtime inspection mutations affect only the active session snapshot and never rewrite `config.json`.

Data invariants:

- User-to-agent envelopes have non-empty `parts`.
- Text parts have non-empty trimmed text.
- Image parts reference local files and have a non-empty MIME type.
- Agent-to-user envelopes have non-empty text.
- SQLite records use `schema_version = 1`, matching `session_id`, finite `persisted_at`, and parseable object `message_json`.
- Structured log events have ids, timestamps, levels, categories, event names, components, and summaries; known secret-key fields are redacted before persistence.

Transaction invariants:

- SQLite append of pending messages is all-or-nothing per `appendMessages` call.
- Runtime compaction persists pending messages before dropping in-memory messages.
- Startup restore only occurs when the runtime message list is empty.
- Restored/compacted windows must align to completed assistant turns when possible.
- NDJSON append/compaction operations are serialized within a store, and compaction replaces the destination via temporary-file rename.

Security invariants:

- Telegram `from.id` must be whitelisted before activation or processing.
- Telegram chat type must be `private`.
- Active Telegram chat id cannot change during one process run.
- Active LLM provider credentials must exist before agent construction.
- Voice transcription API key must exist before transcription.
- Workspace-restricted filesystem and bash tools must reject outside-workspace paths or unverifiable high-risk commands.

Operational invariants:

- Shutdown should stop Telegraf, worker, agent runtime, relay subscription, and pending image buffer.
- Event inspection must never throw into the agent runtime callback.
- Telegram egress failure must not crash the process.
- Voice temp files should be removed after transcription attempts.
- MessageBus subscriber failures must be isolated.
- Inspection config getters return defensive snapshots; one event is evaluated against one coherent snapshot.
- Logger flush must drain pending writes before runtime shutdown completes.

These invariants are enforced partly by code and partly by tests. For `v2`, any implementation that changes the runtime topology should keep these invariants explicit, because they are the practical safety rails that let a personal local agent manipulate files, run tools, and interact with external AI services without becoming unpredictable.

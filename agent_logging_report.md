# Agent 日志系统设计与打点报告

## 目标与范围

本报告基于 `output_specs.md` 与当前 `src/` 源码，讨论在 mahabot agent 中实现一套可打印、可本地保存、可按 TTL 清理的日志系统。日志目标不是复刻完整消息历史，而是在排查 agent 行为时提供足够语境：知道进程何时启动、读了多少历史、处理了哪类用户输入、何时调用模型/工具、哪里发生了 warn/error。

日志应覆盖两类事件：

- **重要生命周期事件**：agent/gateway 启停、session runtime 创建、恢复持久化 message、用户消息进入、agent 消息发出、context compact 执行。这类日志可以简略，重点是给 error log 提供阅读语境。
- **运行时问题事件**：LLM/provider 失败或 timeout、工具 blocked/timeout、SQLite 读写失败、Telegram 下载/发送/转写失败、EventInspection 发布失败、command 解析异常、上下文压缩被阻塞等。

## 1. 实现日志系统的最佳实践建议

### 1.1 统一结构化 Logger，不继续散落 `console.*`

当前代码多处直接传入 `console.warn/error`，例如 `MahabotGatewayManager.buildSessionRuntime`、`InMemoryMessageBus`、`Agent`、`EventInspection`、`ContextManager`、`AgentWorker`。建议新增 `src/logging/` 模块，统一提供：

```ts
type LogLevel = "debug" | "info" | "warn" | "error";
type LogCategory =
  | "lifecycle"
  | "message"
  | "persistence"
  | "context"
  | "agent_turn"
  | "llm_provider"
  | "tool"
  | "gateway"
  | "command"
  | "system";

interface LogEvent {
  id: string;
  ts: number;
  level: LogLevel;
  category: LogCategory;
  event: string;
  sessionId?: string;
  turnId?: string;
  messageId?: string;
  component: string;
  summary: string;
  data?: Record<string, unknown>;
  error?: {
    name?: string;
    message: string;
    code?: string;
    stack?: string;
  };
}
```

核心原则：

- **所有组件依赖 `Logger` 接口**，不要直接依赖 `Console`。保留 `ConsoleLogSink` 打印到 stdout/stderr，另加 `PersistentLogSink` 保存到本地。
- **事件命名稳定**，用 `category.event_name`，例如 `lifecycle.agent_started`、`persistence.restore_failed`、`tool.bash_timeout`。
- **日志是观测数据，不是业务数据**。不要把完整 prompt、完整用户消息、API key、HTTP header、工具 stdout 全量保存进日志。
- **高频事件降噪**。`message_update`、thinking delta、tool streaming update 不能全量入库；默认只记录 start/end/error，debug 模式再记录采样或聚合。
- **同一个 turn 贯穿 correlation id**。在 `AgentWorker.handleUserEnvelope` 创建 `turnId`，传给 `Agent.runUserTurn`、LLM 调用、工具事件、最终 assistant message，方便串起来读。

### 1.2 保存策略：建议 SQLite ring buffer + 可选 JSONL 调试输出

项目已使用 SQLite 保存 message，且运行环境是单进程 Node.js，本地保存日志也建议优先使用 SQLite：

- 新增表 `logs(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, level TEXT NOT NULL, category TEXT NOT NULL, event TEXT NOT NULL, session_id TEXT, turn_id TEXT, component TEXT NOT NULL, summary TEXT NOT NULL, data_json TEXT, error_json TEXT)`。
- 在 `session.sqlite` 内复用同一个数据库即可，或者拆成 `persistence/logs.sqlite`。如果希望 message 与 log 生命周期相互独立，拆库更清晰。
- 写入使用批量队列，避免每条日志同步阻塞主流程。进程退出时 flush。
- 控制台打印使用单行摘要，持久化保存结构化 JSON 字段。

TTL 建议：

- 默认保留 **最近 1000 条**日志，另可配置 `maxAgeMs`，例如 7 天。
- 每次写入后按轻量节流清理，例如每 100 条写入或每 60 秒执行一次：
  - `DELETE FROM logs WHERE id NOT IN (SELECT id FROM logs ORDER BY id DESC LIMIT ?)`
  - `DELETE FROM logs WHERE ts < ?`
- 默认只保存 `info/warn/error`；`debug` 只打印或按配置保存，避免 `message_update` 造成写放大。

建议配置：

```json
{
  "logging": {
    "level": "info",
    "persist": true,
    "maxEntries": 1000,
    "maxAgeMs": 604800000,
    "debugEvents": false,
    "redactMessageText": true,
    "messagePreviewChars": 120
  }
}
```

### 1.3 生命周期日志应简洁，问题日志应可行动

生命周期日志建议只记录状态转移与计数：

- `agent_start`：session、channel、provider/model、toolCount、promptCharCount、persistenceEnabled。
- `persistence_restore_complete`：dbPath、readRows、restoredMessages、skippedInvalidRows。
- `user_message_received`：source、partTypes、textLength、imageCount、hasVoiceTranscript。
- `assistant_message_published`：textLength、format、durationMs。
- `context_compact_executed`：curTokens、high/low watermark、beforeCount、afterCount、droppedCount。

问题日志应能回答“哪里坏、影响什么、下一步看什么”：

- 记录 `component`、`operation`、`durationMs`、`attempt`、`timeoutMs`、`statusCode`、`provider`、`toolName`、`blockedReason`。
- 对用户可见错误也记录内部错误类型，但不要把用户消息原文或密钥写进去。
- 对可恢复失败使用 `warn`，例如 EventInspection 发布失败、Telegram 发送 fallback、SQLite append 失败但当前会话继续。
- 对会导致一轮 turn 失败或进程启动失败的问题使用 `error`，例如模型配置不存在、provider 凭证缺失、LLM prompt 抛错。

### 1.4 不要把 EventInspection 当作持久日志系统

`EventInspection` 现在负责把 pi-agent-core 事件转换为用户可见 status，例如 token usage、tool event、thinking。它是 UI/status 通道，不应直接承担持久日志职责。建议做法：

- `Agent.agentRuntime.subscribe` 收到 `AgentEvent` 后同时投递给 `EventInspection` 与 `Logger`。
- `EventInspection` 继续遵守用户配置，用于展示。
- `Logger` 默认只保存关键 pi 事件：`turn_start`、`turn_end`、`tool_execution_start`、`tool_execution_end`、`agent_end/error`。`message_update` 与 thinking 只做 debug 采样。

### 1.5 隐私与安全红线

- 不保存 API key、Authorization header、Telegram bot token、provider base URL 中可能含敏感参数的完整 URL。
- 用户消息默认只存长度、part 类型、来源、短 preview 或 hash；如果要保存 preview，默认截断到 120 字符。
- 工具输出默认不保存正文，只保存 bytes、truncated、exitCode、timedOut。排障时可临时打开 debug，但仍需截断。
- Telegram 文件 path 可保存相对路径或 basename，避免泄漏完整本地目录结构；需要定位文件时可保存 `mediaId` 或 `fileUniqueId`。

### 1.6 推荐实施顺序

1. 新增 `src/logging/`：`Logger` 接口、`ConsoleLogSink`、`SqliteLogStore`、`redactError`、`createLogger`。
2. 在 `MahabotGatewayManager` 创建 session runtime 时创建 logger，并注入 `ContextManager`、`InMemoryMessageBus`、`Agent`、`EventInspection`、`AgentWorker`、Telegram egress。
3. 先迁移现有 `console.warn/error` 为结构化日志，不改行为。
4. 给 `AgentWorker.handleUserEnvelope` 加 `turnId`，贯通 turn 开始、LLM 调用、assistant 发布、失败。
5. 给 `MessagePersistenceCoordinator` 与 `SqliteMessageStore` 增加 restore/append/compact 的统计字段。
6. 给工具与外部网络边界加 warning/error：bash timeout/blocked、web search provider fallback、Telegram media/transcription、Telegram send fallback。
7. 添加 TTL 清理测试：超过 `maxEntries`、超过 `maxAgeMs`、debug event 不持久化。

## 2. 日志种类、触发位置与预期 timing 统计

| # | 日志事件 | 级别 | 类别 | 触发位置 | 触发时机 / timing | 关键字段 | 说明 |
|---:|---|---|---|---|---|---|---|
| 1 | `lifecycle.cli_starting` | info | lifecycle | `src/gateway/manager.ts` `runInCliMode` | session workspace 初始化后、runtime 构建前 | `sessionId`, `workspaceRoot` | CLI 入口语境。 |
| 2 | `lifecycle.telegram_starting` | info | lifecycle | `src/gateway/manager.ts` `runInTelegramMode` | onboarding ready 且 Telegraf launch 前 | `allowedUserCount`, `mediaConfig` | Telegram 入口语境。 |
| 3 | `lifecycle.runtime_created` | info | lifecycle | `MahabotGatewayManager.buildSessionRuntime` | `Agent.createFromAppConfig` 与 `AgentWorker` 创建成功后 | `sessionId`, `channel`, `provider`, `model`, `toolCount`, `promptCharCount` | agent 启动核心语境。 |
| 4 | `lifecycle.worker_started` | info | lifecycle | `AgentWorker.start` | `loopPromise` 创建后 | `sessionId`, `channel` | 说明 worker 已开始消费 bus。 |
| 5 | `lifecycle.agent_started` | info | lifecycle | `Agent.start` | `running=true` 后进入 inbound loop 前 | `sessionId`, `persistenceEnabled` | 如果以后直接使用 `Agent.start`，需要此事件。当前主要由 worker 调用 `runUserTurn`。 |
| 6 | `lifecycle.shutdown_start` | info | system | `runInCliMode` finally、Telegram `shutdown` | 收到 `/exit`、SIGINT/SIGTERM 或 normal_exit 时 | `reason`, `channel` | 停机起点。 |
| 7 | `lifecycle.shutdown_complete` | info | system | `runInCliMode` finally、Telegram `shutdown` | worker/agent/relay/pendingImages 停止后 | `durationMs` | 停机完成，可确认 pending log flush。 |
| 8 | `persistence.restore_start` | info | persistence | `Agent.restorePersistedContextOnStartup` / `MessagePersistenceCoordinator.loadPersistedContextWindow` | Agent 构造后立即执行 | `sessionId`, `dbPath`, `startupRestoreMessageCount` | 启动历史加载起点。 |
| 9 | `persistence.restore_complete` | info | persistence | `MessagePersistenceCoordinator.loadPersistedContextWindow` | `readAll` 与 `buildStartupRestoreWindow` 后 | `readRows`, `restoredMessages`, `persistedCursor` | 用户要求的“读取持久化 message”。 |
| 10 | `persistence.restore_skipped` | debug/info | persistence | `MessagePersistenceCoordinator.loadPersistedContextWindow` | persistence disabled 或 runtime 已有 messages | `reason`, `currentMessageCount` | 防止误判“为什么没读历史”。 |
| 11 | `persistence.restore_failed` | warn | persistence | `MessagePersistenceCoordinator.loadPersistedContextWindow` catch | SQLite read/schema/parse 失败后 | `error`, `dbPath` | 当前行为是启动但无历史，应明确记录。 |
| 12 | `persistence.invalid_row_skipped` | warn | persistence | `SqliteMessageStore.readAll` / `normalizeRow` | 遍历 rows 遇到坏行时 | `rowIndex`, `schemaVersion`, `dbPath` | 现有 warning 应结构化。 |
| 13 | `persistence.append_start` | debug | persistence | `MessagePersistenceCoordinator.persistPendingMessages` | pendingMessages 非空且 append 前 | `pendingCount`, `boundedCursor` | 可默认不打印，只持久化 debug。 |
| 14 | `persistence.append_complete` | info/debug | persistence | `MessagePersistenceCoordinator.persistPendingMessages` | append transaction commit 后 | `persistedCount`, `persistedCursor` | 生命周期语境：消息已落库。 |
| 15 | `persistence.append_failed` | error | persistence | `MessagePersistenceCoordinator.persistPendingMessages` catch | SQLite append/rollback 后 | `pendingCount`, `error` | 当前会话继续但 durability 丢失。 |
| 16 | `message.user_published` | info | message | `cliIngressAdapter.publishCliUserMessage`、`telegramIngressAdapter.publishTelegramUserParts` | bus.publish 前或成功后 | `source`, `origin`, `partTypes`, `textLength`, `imageCount` | 用户消息进入系统。 |
| 17 | `message.bus_enqueued` | debug/info | message | `InMemoryMessageBus.publish` / `routeUserToAgent` | envelope validate 且入队后 | `direction`, `kind`, `sessionId`, `queueDepth` | 低频可 info，高频建议 debug。 |
| 18 | `message.bus_waiter_aborted` | debug | message | `InMemoryMessageBus.getUserMsgFromBus` abort path | worker stop 或 shutdown abort 时 | `sessionId` | 正常停机语境，避免误报。 |
| 19 | `message.bus_subscriber_failed` | warn | message | `InMemoryMessageBus.dispatch` | subscriber handler throw/reject 时 | `subscriberId`, `filter`, `error` | 现有 best-effort subscriber 失败需要可见。 |
| 20 | `agent_turn.start` | info | agent_turn | `AgentWorker.handleUserEnvelope` | 调用 `agent.runUserTurn` 前 | `turnId`, `messageId`, `channel`, `partTypes` | 单轮 turn 的根事件。 |
| 21 | `agent_turn.input_mapped` | debug | agent_turn | `Agent.processInboundMessage` / mapper | structured parts 转 `AgentMessage[]` 后 | `llmMessageCount`, `supportsImageInput` | 排查图片模型能力和 mapper 错误。 |
| 22 | `agent_turn.llm_prompt_start` | info | llm_provider | `Agent.invokeAgentLoop` | `agentRuntime.prompt(messages)` 前 | `turnId`, `provider`, `model`, `messageCount` | LLM 调用起点。 |
| 23 | `agent_turn.llm_prompt_complete` | info | llm_provider | `Agent.invokeAgentLoop` | `prompt` 返回且 assistant message 找到后 | `durationMs`, `runtimeMessageCount`, `assistantTextLength` | LLM 成功结束。 |
| 24 | `agent_turn.llm_prompt_failed` | error | llm_provider | `Agent.invokeAgentLoop` / `executeInboundTurn` catch 上层 | `prompt` 抛错或无 assistant message | `durationMs`, `error` | 包括 provider timeout、网络错误、上游抛错。 |
| 25 | `agent_turn.complete` | info | agent_turn | `AgentWorker.handleUserEnvelope` | assistant envelope publish 后 | `turnId`, `durationMs`, `assistantTextLength` | 与 start 成对。 |
| 26 | `agent_turn.failed_user_visible` | error | agent_turn | `AgentWorker.handleUserEnvelope` catch | 发布 `[error] ...` assistant message 前/后 | `turnId`, `error` | 用户可见失败。 |
| 27 | `message.assistant_published` | info | message | `AgentWorker.handleUserEnvelope` | `bus.publish(agent.assistant_message)` 后 | `turnId`, `textLength`, `format` | 用户/agent 消息语境。 |
| 28 | `context.token_usage` | info/debug | context | `Agent.agentRuntime.subscribe` on `turn_end` / `EventInspection` | pi `turn_end` 后 | `curContextSize`, `lowWaterMark`, `highWaterMark` | 已有 token status，建议也结构化保存。 |
| 29 | `context.compact_skipped` | debug | context | `MessagePersistenceCoordinator.compactContextIfNeeded` | 低于 high watermark、空 messages、压缩无收益时 | `reason`, `curContextSize`, `messageCount` | 默认 debug，排查“为什么没 compact”。 |
| 30 | `context.compact_triggered` | info | context | `MessagePersistenceCoordinator.compactContextIfNeeded` | `curContextSize >= highWatermark` 且计算出 tail window 后 | `curContextSize`, `targetKeep`, `beforeCount` | compact 决策点。 |
| 31 | `context.compact_blocked` | warn | context | `compactContextIfNeeded` | persist-before-compact 后 cursor 未追上全量时 | `persistedCursor`, `messageCount` | 防止丢未持久化消息。 |
| 32 | `context.compact_executed` | info | context | `Agent.ensureContextSize` / `compactContextIfNeeded` | `agentRuntime.replaceMessages` 后 | `beforeCount`, `afterCount`, `droppedCount`, `persistedCursor` | 用户要求的 compact 执行日志。 |
| 33 | `context.prompt_assembled` | info | context | `ContextManager.assembleSystemPrompt` | systemPrompt 拼装完成后 | `promptCharCount`, `sectionIds`, `usedTemplateFallback` | 启动语境，替代现有 debug 字符串。 |
| 34 | `context.prompt_file_restored` | warn | context | `ContextManager.ensureOptionalPromptFile` | SOUL/USER 缺失并从模板恢复后 | `fileName`, `filePath` | 现有 warning 应结构化。 |
| 35 | `context.prompt_file_read_failed` | error | context | `ContextManager.readRequiredFile` | 必需 prompt 文件读取失败时 | `label`, `path`, `error` | 启动失败根因。 |
| 36 | `context.skills_catalog_warning` | warn | context | `ContextManager.assembleSystemPrompt` | skills summary 有 warnings 时 | `code`, `location`, `message` | 现有 warning 应结构化。 |
| 37 | `provider.model_resolved` | info | llm_provider | `modelFactory.createModelFromConfig` | provider/model 成功解析后 | `provider`, `model`, `category`, `supportsImageInput` | 启动语境。 |
| 38 | `provider.model_resolve_failed` | error | llm_provider | `modelFactory.resolveTargetProviderModel` | 无 enabled provider/model match 时 | `attemptedPairs` | 配置错误。 |
| 39 | `provider.credentials_missing` | error | llm_provider | `ConfigManager.ensureProviderCredentials` 调用点 | Agent 创建时凭证检查失败 | `provider`, `envVar` | 启动失败或 runtime 激活失败。 |
| 40 | `tool.execution_start` | info/debug | tool | `EventInspection` 处理 `tool_execution_start` | pi-agent-core 发出工具开始事件时 | `toolName`, `toolCallId`, `turnId` | 统一工具起点。 |
| 41 | `tool.execution_end` | info | tool | `EventInspection` 处理 `tool_execution_end` | 工具结束事件时 | `toolName`, `toolCallId`, `durationMs`, `ok` | 统一工具结束。 |
| 42 | `tool.execution_update` | debug | tool | `EventInspection` 处理 `tool_execution_update` | 工具中间更新时 | `toolName`, `toolCallId` | 默认不持久化或采样。 |
| 43 | `tool.bash_blocked` | warn | tool | `bashTool.createBashTool().execute` | policy/timeout 参数/工作目录检查拒绝命令时 | `blockedReason`, `restrictToWorkspace`, `timeoutMs` | 现在只返回工具结果，建议也记录。 |
| 44 | `tool.bash_timeout` | warn | tool | `bashTool.runCommand` timeout path | timeout timer 触发 SIGTERM/SIGKILL 时 | `toolCallId`, `timeoutMs`, `durationMs` | 用户特别提到的 timeout 类问题。 |
| 45 | `tool.bash_aborted` | warn/debug | tool | `bashTool.runCommand` abort handler | runtime abort 或 turn cancel 时 | `toolCallId` | 正常 abort 可 debug，异常 abort 可 warn。 |
| 46 | `tool.bash_complete_nonzero` | warn | tool | `bashTool.execute` after `runCommand` | exitCode 非 0 且非 timeout | `exitCode`, `stderrBytes`, `stdoutBytes` | 非致命但排障重要。 |
| 47 | `tool.web_search_provider_failed` | warn | tool | `webSearchTool.createWebSearchTool` | Tavily/Linkup HTTP、网络、payload 异常 | `provider`, `status`, `errorCode` | 现在作为工具结果返回，建议额外记录。 |
| 48 | `tool.web_search_fallback` | info/warn | tool | `webSearchTool` Tavily credits fallback | Tavily credits 不足后尝试 Linkup | `from`, `to`, `fallbackReason` | 外部服务降级语境。 |
| 49 | `gateway.telegram_access_decision` | info/warn | gateway | `evaluateTelegramIngress` 调用点 | 每条 Telegram 消息鉴权后 | `decision`, `chatId`, `userId` | reject 可 warn，accept 可 info/debug。 |
| 50 | `gateway.telegram_runtime_activated` | info | gateway | `activateRuntime` | activeRuntime 设置完成后 | `chatId`, `sessionId`, `userId` | Telegram session 绑定。 |
| 51 | `gateway.telegram_runtime_activate_failed` | error | gateway | `handleTelegramMessage` `accept_activate` catch | `buildSessionRuntime` 或 credential/model/prompt 失败 | `chatId`, `userId`, `error` | 用户可见 `[error]` 前记录。 |
| 52 | `gateway.telegram_unsupported_message` | info | gateway | `handleTelegramMessage` | 不支持的 message kind | `messageKind` | 用户体验语境。 |
| 53 | `gateway.media_photo_saved` | info | gateway | `TelegramMediaStore.savePhoto` 调用点 | photo 下载并写入本地后 | `fileSize`, `width`, `height`, `sessionId` | 图片进入 pending buffer。 |
| 54 | `gateway.media_photo_failed` | warn | gateway | `handleTelegramMessage` photo catch | getFileLink/download/write 失败 | `error`, `messageId` | 用户可见失败。 |
| 55 | `gateway.pending_images_expired` | info/warn | gateway | `TelegramPendingImageBuffer.clearExpired/takeImages` 调用点 | photo/text/voice 触发清理时 | `expiredCount`, `sessionId` | 用户消息上下文变化。 |
| 56 | `gateway.voice_saved` | info | gateway | `TelegramMediaStore.saveVoiceTemp` 调用点 | voice 下载到 tmp 后 | `duration`, `mimeType`, `fileSize` | 转写前语境。 |
| 57 | `gateway.voice_ffmpeg_failed` | warn/error | gateway | `ffmpegAudioConverter.convertVoiceToMp3` catch | ffmpeg 不可用、转换 timeout/失败 | `ffmpegCommand`, `timeoutMs`, `error` | voice 转写关键错误。 |
| 58 | `gateway.voice_transcription_failed` | warn/error | gateway | `TelegramVoiceTranscriber.transcribe` / `OpenAiTranscriptionClient.transcribe` | API key 缺失、HTTP 非 2xx、空 transcript、超限 | `model`, `status`, `error` | 用户可见 voice 失败。 |
| 59 | `gateway.voice_transcribed` | info | gateway | `TelegramVoiceTranscriber.transcribe` | OpenAI transcription 返回文本后 | `model`, `textLength`, `duration`, `fileSize` | 不保存完整 transcript。 |
| 60 | `gateway.telegram_egress_send_start` | debug | gateway | `telegramEgressAdapter.createTelegramEgressRelay` | 收到 `agent_to_user` envelope 后 | `chunkCount`, `textLength`, `format` | 可选，用于排查发送延迟。 |
| 61 | `gateway.telegram_egress_fallback` | warn | gateway | `sendFormattedWithPlainTextFallback` | HTML formatted send 失败，改 plain text | `chunkCount`, `error` | 现在 catch 吞掉具体格式失败，建议记录。 |
| 62 | `gateway.telegram_egress_failed` | warn/error | gateway | `createTelegramEgressRelay` catch | plain text fallback 也失败 | `chatId`, `error` | 出站丢失。 |
| 63 | `gateway.telegram_middleware_failed` | warn | gateway | `bot.catch` | Telegraf middleware 未处理异常 | `error` | 现有 console.warn。 |
| 64 | `gateway.telegram_message_failed` | warn | gateway | `messageQueue.catch` | 串行消息处理 promise reject | `error` | 现有 console.warn。 |
| 65 | `command.parsed` | debug/info | command | `parseRuntimeCommands` 调用点 | Telegram text 解析后 | `commandCount`, `unknownCount`, `remainingTextLength` | 不保存完整文本。 |
| 66 | `command.unknown` | info/warn | command | `runInTelegramMode` unknown loop | 用户发了未知 runtime command | `commandPreview` | 现有 console.log。 |
| 67 | `command.executed` | info | command | `RuntimeCommandController.execute` / 调用点 | command result replies 生成后 | `commands`, `replyCount` | 记录 runtime 配置变更。 |
| 68 | `event_inspection.publish_failed` | warn | system | `EventInspection.processEvent` | runtime event/token/thinking status publish 抛错 | `eventType`, `kind`, `error` | 当前已 warn，建议结构化。 |
| 69 | `agent_event.observer_failed` | warn | system | `Agent.agentRuntime.subscribe` observer catch | `onAgentEvent` 抛错 | `eventType`, `error` | 避免 inspection 破坏 agent loop。 |
| 70 | `agent.inbound_poll_failed` | warn | agent_turn | `Agent.checkAndWaitInboundMessage` catch | inboundSource 失败后 sleep 250ms | `error` | 当前已有 warn。 |

## 补充统计结论

- 建议首批实现 **70 个事件点**，其中生命周期/语境类约 25 个，运行时问题类约 45 个。
- 最关键的首批落地点是 `MahabotGatewayManager.buildSessionRuntime`、`AgentWorker.handleUserEnvelope`、`Agent.invokeAgentLoop`、`MessagePersistenceCoordinator`、`InMemoryMessageBus`、`EventInspection`、`bashTool`、Telegram media/transcription/egress。
- 当前系统已有 `EventInspection` 和 `MessageBus` 诊断队列，但二者都不是持久日志：前者偏 UI status，后者无 TTL 且只在内存中。
- TTL 最适合在持久 log sink 层做，默认 `maxEntries=1000` 足够本地排障；如果打开 debug/tool update，必须配合采样或更小保存范围。

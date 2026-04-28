# Agent 日志系统设计与打点报告

## 目标与范围

本报告基于 `output_specs.md` 与当前 `src/` 源码，讨论在 mahabot agent 中实现一套可打印、可本地保存、可按 TTL 清理的日志系统。日志目标不是复刻完整消息历史，而是在排查 agent 行为时提供足够语境：知道进程何时启动、读了多少历史、处理了哪类用户输入、何时调用模型/工具、哪里发生了 warn/error。

日志应覆盖两类事件：

- **重要生命周期事件**：agent/gateway 启停、session runtime 创建、恢复持久化 message、用户消息进入、agent 消息发出、context compact 执行。这类日志可以简略，重点是给 error log 提供阅读语境。
- **运行时问题事件**：LLM/provider 失败或 timeout、工具 blocked/timeout、message 持久化失败、Telegram 下载/发送/转写失败、EventInspection 发布失败、command 解析异常、上下文压缩被阻塞等。

## 1. 代码实现设计

### 1.1 新增模块结构

新增 `src/logging/`，把日志类型、写入、控制台输出、TTL 清理、脱敏逻辑集中在一个边界内。业务模块只依赖 `Logger` 接口，不直接知道日志写到哪里。

```text
src/logging/
  index.ts
  types.ts
  logger.ts
  ndjsonLogStore.ts
  consoleLogSink.ts
  logRedaction.ts
  logEventFactory.ts
```

职责拆分：

- `types.ts`：定义 `LogEvent`、`LogLevel`、`LogCategory`、`Logger`、配置类型。
- `logger.ts`：组合 console sink 和 NDJSON store，提供 `debug/info/warn/error` 方法。
- `ndjsonLogStore.ts`：负责 append-only 写入 `latest.ndjson`、flush、TTL compaction。
- `consoleLogSink.ts`：把结构化事件渲染成一行人类可读摘要。
- `logRedaction.ts`：统一脱敏 error、message preview、headers、路径、工具输出。
- `logEventFactory.ts`：创建 `id`、`ts`、默认字段，避免各处手写重复结构。

### 1.2 核心类型与接口

`LogEvent` 一行对应一个 NDJSON 对象。字段保持扁平、稳定，方便 coding agent 用文本工具检索。

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

interface Logger {
  debug(input: LogInput): void;
  info(input: LogInput): void;
  warn(input: LogInput): void;
  error(input: LogInput): void;
  flush(): Promise<void>;
}

type LogInput = Omit<LogEvent, "id" | "ts" | "level"> & {
  error?: unknown;
};
```

实现约束：

- `Logger` 方法不能 throw；写文件失败只能写 console error 或内部降级，不能影响 agent loop。
- `error(input)` 接收 `unknown`，由 `redactError()` 转为 `{ name, message, code, stack }`。
- `data` 必须是 JSON-safe object；不可传 `Error`、`Buffer`、stream、class instance。
- 高频事件默认走 `debug`，只有 `logging.debugEvents=true` 时持久化。

### 1.3 NDJSON 文件格式与 TTL

日志的主要消费者会包括 coding agent：它们更常用 `read_file`、`grep`、`bash`/shell 文本工具读取和分析日志。因此主存储使用 **NDJSON/JSONL 文件**，每行一个完整 `LogEvent` JSON 对象。

推荐文件布局：

```text
persistence/logs/
  latest.ndjson              # 当前 ring buffer 文件，最近 N 条
  latest.pretty.log          # 可选，人类阅读的一行摘要
  archive/
    2026-04-28.ndjson        # 可选，debug 时按天滚动，受 maxAgeMs 控制
```

NDJSON 示例：

```json
{"ts":1777391200000,"level":"info","category":"agent_turn","event":"agent_turn.start","sessionId":"cli-stable-session","turnId":"turn_01","component":"AgentWorker","summary":"agent turn started","data":{"channel":"cli","partTypes":["text"],"textLength":42}}
```

实现建议：

- `latest.ndjson` 是权威日志文件，便于 `read_file` 读取、`grep '"event":"tool.bash_timeout"'` 检索、按行截取。
- 每次写入追加一行 JSON；后台定期执行 ring compaction，只保留最后 `maxEntries` 行。
- 如果文件超过阈值，例如 2-5 MB，可重写为尾部 N 行；本地个人 agent 场景下成本可接受。
- 控制台打印仍保留短摘要，持久文件保存完整结构化字段。

TTL 建议：

- 默认保留 **最近 1000 条**日志，另可配置 `maxAgeMs`，例如 7 天。
- 每次写入后按轻量节流清理，例如每 100 条写入或每 60 秒执行一次：
  - 读取 `latest.ndjson` 尾部，保留最后 `maxEntries` 行。
  - 解析每行 `ts`，过滤早于 `Date.now() - maxAgeMs` 的日志。
- 默认只保存 `info/warn/error`；`debug` 只打印或按配置保存，避免 `message_update` 造成写放大。

建议配置：

```json
{
  "logging": {
    "level": "info",
    "persist": true,
    "format": "ndjson",
    "path": "persistence/logs/latest.ndjson",
    "maxEntries": 1000,
    "maxAgeMs": 604800000,
    "debugEvents": false,
    "redactMessageText": true,
    "messagePreviewChars": 120
  }
}
```

`NdjsonLogStore` 建议行为：

- `append(event)`：序列化为一行 JSON，进入内存队列；队列异步批量写入，避免每条日志阻塞主流程。
- `flush()`：写入剩余队列；CLI/Telegram shutdown 必须 await。
- `compactIfNeeded()`：每 `compactEveryWrites` 次或每 `compactIntervalMs` 执行一次。
- `compact` 策略：读取文件、逐行 parse、过滤过期 `ts`、保留最后 `maxEntries` 条、写入临时文件后 rename 替换。
- parse 失败的旧行直接丢弃，并输出 `logging.compact_invalid_line_skipped` 到 console，不再写入同一个坏文件。

### 1.4 配置设计

在 `AppConfig` 增加 `logging`：

```ts
interface LoggingConfig {
  level: "debug" | "info" | "warn" | "error";
  persist: boolean;
  path: string;
  maxEntries: number;
  maxAgeMs?: number;
  compactEveryWrites: number;
  compactIntervalMs: number;
  debugEvents: boolean;
  redactMessageText: boolean;
  messagePreviewChars: number;
  includeStack: boolean;
}
```

默认值建议：

```ts
logging: {
  level: "info",
  persist: true,
  path: "persistence/logs/latest.ndjson",
  maxEntries: 1000,
  maxAgeMs: 7 * 24 * 60 * 60 * 1000,
  compactEveryWrites: 100,
  compactIntervalMs: 60_000,
  debugEvents: false,
  redactMessageText: true,
  messagePreviewChars: 120,
  includeStack: true,
}
```

`ConfigManager` 需要校验：

- `level` 必须是合法枚举。
- `maxEntries` 建议范围 `[100, 100000]`。
- `maxAgeMs` 如果存在必须为正整数。
- `path` 必须相对 persistence root 或 resolve 后仍在 session workspace 下。

### 1.5 依赖注入设计

在 `MahabotGatewayManager.buildSessionRuntime` 创建 session logger：

```ts
const logger = createLogger({
  config: appConfig.logging,
  persistenceRoot,
  sessionId,
  now: Date.now,
});
```

注入位置：

- `ContextManager`：替代 constructor 中的 `console.warn/error`。
- `InMemoryMessageBus`：只记录 subscriber failure 等异常。
- `EventInspection`：记录 publish failure、observer failure。
- `Agent`：记录 restore、turn、LLM prompt、compact、runtime snapshot。
- `AgentWorker`：创建 `turnId`，记录 turn start/complete/error。
- `ToolAssembly` / tools：把 logger 传给 `bashTool`、`webSearchTool` 等工具。
- Telegram relay/media/voice：只记录关键失败，不记录正常发送/下载噪音。

`runInCliMode` 和 `runInTelegramMode` 的 shutdown 路径必须调用：

```ts
await runtime.logger.flush();
```

因此 `SessionRuntime` 需要新增：

```ts
interface SessionRuntime {
  agent: Agent;
  worker: AgentWorker;
  logger: Logger;
  eventInspectionConfig: RuntimeEventInspectionConfig;
  commandController: RuntimeCommandController;
}
```

### 1.6 Agent Runtime Snapshot 实现

`lifecycle.agent_started` 后紧跟 `lifecycle.agent_runtime_snapshot`。字段应复用 `/agent_state` 的数据源，避免实现两套口径：

- `agent.getRuntimeContextSnapshot()`
- `agent.getAppliedConfigSnapshot()`
- `agent.getRuntimeLifecycleSnapshot()`
- `toolRegistry.getToolNames().length`
- `eventInspectionConfig.getSnapshot()`

建议新增一个纯函数，供 command 和 logger 共享：

```ts
export function buildAgentStateSnapshot(input: {
  agent: Agent;
  toolRegistry: ToolRegistry;
  eventInspectionConfig: RuntimeEventInspectionConfig;
}): RuntimeCommandAgentStateSnapshot & {
  inspection: ReturnType<RuntimeEventInspectionConfig["getSnapshot"]>;
};
```

`RuntimeCommandController.formatAgentStateSnapshot` 继续负责人类可读文本；logger 保存同源结构化对象。

### 1.7 Turn ID 与事件关联

在 `AgentWorker.handleUserEnvelope` 创建 `turnId`：

```ts
const turnId = createTurnId(this.now);
```

然后传入 `Agent.runUserTurn`：

```ts
await this.agent.runUserTurn({
  parts: envelope.payload.parts,
  channel: this.channelType,
  chatId: this.chatId,
  userId: this.userId,
  metadata: { ...envelope.meta, turnId },
});
```

`Agent.executeInboundTurn`、`invokeAgentLoop`、`ensureContextSize`、tool event logging 都从 metadata 或 current turn context 读取 `turnId`。这样同一轮中的 `agent_turn.*`、`context.*`、`persistence.*`、`tool.*` 可以被文本检索串起来：

```text
grep '"turnId":"turn_abc"' persistence/logs/latest.ndjson
```

### 1.8 日志内容策略

生命周期日志建议只记录状态转移与计数：

- `lifecycle.agent_started`：session、channel、provider/model、toolCount、promptCharCount、persistenceEnabled。
- `lifecycle.agent_runtime_snapshot`：紧跟 `lifecycle.agent_started` 后打印 runtime 信息，字段参考 `RuntimeCommandController.formatAgentStateSnapshot`：`context`、`applied_config`、`runtime`、`tools`、`inspection`。
- `persistence.msg_restore_complete`：storePath、readRows、restoredMessages、skippedInvalidRecords。
- `agent_turn.start` / `agent_turn.complete`：source、partTypes、textLength、imageCount、hasVoiceTranscript、durationMs。
- `context_compact_executed`：curTokens、high/low watermark、beforeCount、afterCount、droppedCount。

问题日志应能回答“哪里坏、影响什么、下一步看什么”：

- 记录 `component`、`operation`、`durationMs`、`attempt`、`timeoutMs`、`statusCode`、`provider`、`toolName`、`blockedReason`。
- 对用户可见错误也记录内部错误类型，但不要把用户消息原文或密钥写进去。
- 对可恢复失败使用 `warn`，例如 EventInspection 发布失败、Telegram 发送 fallback、message append 失败但当前会话继续。
- 对会导致一轮 turn 失败或进程启动失败的问题使用 `error`，例如模型配置不存在、provider 凭证缺失、LLM prompt 抛错。

### 1.9 EventInspection 与持久日志分工

`EventInspection` 现在负责把 pi-agent-core 事件转换为用户可见 status，例如 token usage、tool event、thinking。它是 UI/status 通道，不应直接承担持久日志职责。建议做法：

- `Agent.agentRuntime.subscribe` 收到 `AgentEvent` 后同时投递给 `EventInspection` 与 `Logger`。
- `EventInspection` 继续遵守用户配置，用于展示。
- `Logger` 默认只保存关键 pi 事件：`turn_start`、`turn_end`、`tool_execution_start`、`tool_execution_end`、`agent_end/error`。`message_update` 与 thinking 只做 debug 采样。

### 1.10 隐私与安全红线

- 不保存 API key、Authorization header、Telegram bot token、provider base URL 中可能含敏感参数的完整 URL。
- 用户消息默认只存长度、part 类型、来源、短 preview 或 hash；如果要保存 preview，默认截断到 120 字符。
- 工具输出默认不保存正文，只保存 bytes、truncated、exitCode、timedOut。排障时可临时打开 debug，但仍需截断。
- Telegram 文件 path 可保存相对路径或 basename，避免泄漏完整本地目录结构；需要定位文件时可保存 `mediaId` 或 `fileUniqueId`。

### 1.11 实施步骤

1. 新增 `src/logging/`：`Logger` 接口、`ConsoleLogSink`、`NdjsonLogStore`、`redactError`、`createLogger`。
2. 给 `AppConfig` 和 config template 增加 `logging` 配置，并补充校验。
3. 在 `MahabotGatewayManager` 创建 session runtime 时创建 logger，并注入 `ContextManager`、`InMemoryMessageBus`、`Agent`、`EventInspection`、`AgentWorker`、Telegram egress。
4. 先迁移现有 `console.warn/error` 为结构化日志，不改行为。
5. 给 `AgentWorker.handleUserEnvelope` 加 `turnId`，贯通 turn 开始、LLM 调用、assistant 发布、失败。
6. 给 `MessagePersistenceCoordinator` 与 message store 增加 msg restore/append/compact 的统计字段。
7. 给工具与外部网络边界加 warning/error：bash timeout/blocked、web search provider fallback、Telegram media/transcription、Telegram send fallback。
8. 在 CLI/Telegram shutdown 中 flush logger。
9. 添加 TTL 清理测试：超过 `maxEntries`、超过 `maxAgeMs`、debug event 不持久化。

### 1.12 测试设计

建议新增测试：

- `tests/logging/ndjsonLogStore.test.ts`：append 一行 JSON、flush、坏行 compaction、按 `maxEntries` 裁剪、按 `maxAgeMs` 清理。
- `tests/logging/logger.test.ts`：level filtering、debugEvents 控制、error redaction、console sink fallback。
- `tests/agent/agentLogging.test.ts`：`agent_turn.start/complete/failed`、LLM prompt failed、compact executed。
- `tests/agent/messagePersistenceLogging.test.ts`：`persistence.msg_restore_*`、`persistence.msg_append_*`、append failed 不影响 agent loop。
- `tests/gateway/runtimeLogging.test.ts`：`lifecycle.agent_runtime_snapshot` 字段与 `/agent_state` 数据源一致。

## 2. 日志种类、触发位置与预期 timing 统计

| # | 日志事件 | 级别 | 类别 | 触发位置 | 触发时机 / timing | 关键字段 | 说明 |
|---:|---|---|---|---|---|---|---|
| 1 | `lifecycle.cli_starting` | info | lifecycle | `src/gateway/manager.ts` `runInCliMode` | session workspace 初始化后、runtime 构建前 | `sessionId`, `workspaceRoot` | CLI 入口语境。 |
| 2 | `lifecycle.telegram_starting` | info | lifecycle | `src/gateway/manager.ts` `runInTelegramMode` | onboarding ready 且 Telegraf launch 前 | `allowedUserCount`, `mediaConfig` | Telegram 入口语境。 |
| 3 | `lifecycle.runtime_created` | info | lifecycle | `MahabotGatewayManager.buildSessionRuntime` | `Agent.createFromAppConfig` 与 `AgentWorker` 创建成功后 | `sessionId`, `channel`, `provider`, `model`, `toolCount`, `promptCharCount` | agent 启动核心语境。 |
| 4 | `lifecycle.worker_started` | info | lifecycle | `AgentWorker.start` | `loopPromise` 创建后 | `sessionId`, `channel` | 说明 worker 已开始消费 agent loop 输入。 |
| 5 | `lifecycle.agent_started` | info | lifecycle | `Agent.start` 或 `MahabotGatewayManager.buildSessionRuntime` 后 | agent runtime 可用、worker 启动前后 | `sessionId`, `persistenceEnabled` | agent 生命周期语境。 |
| 6 | `lifecycle.agent_runtime_snapshot` | info | lifecycle | `RuntimeCommandController.formatAgentStateSnapshot` 同源字段；可由 `buildSessionRuntime` 组装 | 紧跟 `lifecycle.agent_started` 后 | `context`, `appliedConfig`, `runtime`, `toolCount`, `inspection` | 参考 `/agent_state` 输出，打印 runtime 信息，便于 agent 读取分析。 |
| 7 | `lifecycle.shutdown_start` | info | system | `runInCliMode` finally、Telegram `shutdown` | 收到 `/exit`、SIGINT/SIGTERM 或 normal_exit 时 | `reason`, `channel` | 停机起点。 |
| 8 | `lifecycle.shutdown_complete` | info | system | `runInCliMode` finally、Telegram `shutdown` | worker/agent/relay/pendingImages 停止且 log flush 后 | `durationMs`, `flushedLogCount` | 停机完成。 |
| 9 | `persistence.msg_restore_start` | info | persistence | `Agent.restorePersistedContextOnStartup` / `MessagePersistenceCoordinator.loadPersistedContextWindow` | Agent 构造后立即执行 | `sessionId`, `storePath`, `startupRestoreMessageCount` | 启动历史加载起点。 |
| 10 | `persistence.msg_restore_complete` | info | persistence | `MessagePersistenceCoordinator.loadPersistedContextWindow` | `readAll` 与 `buildStartupRestoreWindow` 后 | `readRows`, `restoredMessages`, `persistedCursor`, `durationMs` | 用户要求的“读取持久化 message”。 |
| 11 | `persistence.msg_restore_skipped` | debug/info | persistence | `MessagePersistenceCoordinator.loadPersistedContextWindow` | persistence disabled 或 runtime 已有 messages | `reason`, `currentMessageCount` | 防止误判“为什么没读历史”。 |
| 12 | `persistence.msg_restore_failed` | warn | persistence | `MessagePersistenceCoordinator.loadPersistedContextWindow` catch | message store 读取、解析或窗口对齐失败后 | `error`, `storePath`, `durationMs` | 当前行为是启动但无历史，应明确记录。 |
| 13 | `persistence.msg_restore_invalid_record_skipped` | warn | persistence | message store 读取与记录标准化逻辑 | 遍历持久化记录遇到坏数据时 | `recordIndex`, `schemaVersion`, `storePath`, `parseError` | 现有 warning 应结构化。 |
| 14 | `persistence.msg_append_start` | debug | persistence | `MessagePersistenceCoordinator.persistPendingMessages` | pendingMessages 非空且 append 前 | `pendingCount`, `boundedCursor`, `runtimeMessageCount` | agent loop 相关，可在 debug 频繁打印。 |
| 15 | `persistence.msg_append_complete` | info/debug | persistence | `MessagePersistenceCoordinator.persistPendingMessages` | pending messages 写入完成后 | `persistedCount`, `persistedCursor`, `durationMs` | 消息已写入持久化存储。 |
| 16 | `persistence.msg_append_failed` | error | persistence | `MessagePersistenceCoordinator.persistPendingMessages` catch | append 失败后 | `pendingCount`, `boundedCursor`, `storePath`, `error` | 当前会话继续但 durability 丢失，error 字段要详细。 |
| 17 | `agent_turn.start` | info | agent_turn | `AgentWorker.handleUserEnvelope` | 调用 `agent.runUserTurn` 前 | `turnId`, `messageId`, `channel`, `partTypes`, `textLength`, `imageCount` | 单轮 turn 的根事件，替代独立 user published log。 |
| 18 | `agent_turn.input_mapped` | debug | agent_turn | `Agent.processInboundMessage` / mapper | structured parts 转 `AgentMessage[]` 后 | `llmMessageCount`, `supportsImageInput`, `memoryMessageCount` | 排查图片模型能力和 mapper 错误。 |
| 19 | `agent_turn.llm_prompt_start` | info | llm_provider | `Agent.invokeAgentLoop` | `agentRuntime.prompt(messages)` 前 | `turnId`, `provider`, `model`, `messageCount`, `runtimeMessageCountBefore` | LLM 调用起点。 |
| 20 | `agent_turn.llm_prompt_complete` | info | llm_provider | `Agent.invokeAgentLoop` | `prompt` 返回且 assistant message 找到后 | `durationMs`, `runtimeMessageCountAfter`, `assistantTextLength`, `usage` | LLM 成功结束。 |
| 21 | `agent_turn.llm_prompt_failed` | error | llm_provider | `Agent.invokeAgentLoop` / `executeInboundTurn` catch 上层 | `prompt` 抛错或无 assistant message | `durationMs`, `provider`, `model`, `messageCount`, `error` | 包括 provider timeout、网络错误、上游抛错；error 可更详细。 |
| 22 | `agent_turn.complete` | info | agent_turn | `AgentWorker.handleUserEnvelope` | assistant envelope publish 后 | `turnId`, `durationMs`, `assistantTextLength`, `runtimeMessageCount` | 与 start 成对，替代独立 assistant published log。 |
| 23 | `agent_turn.failed_user_visible` | error | agent_turn | `AgentWorker.handleUserEnvelope` catch | 发布 `[error] ...` assistant message 前/后 | `turnId`, `durationMs`, `error`, `userVisibleTextLength` | 用户可见失败。 |
| 24 | `agent_turn.runtime_aborted` | warn/debug | agent_turn | `Agent.abort`、`AgentWorker.stop` | turn 执行中 abort 或 shutdown abort | `turnId`, `reason`, `agentBusy` | 正常停机可 debug，运行中断可 warn。 |
| 25 | `context.token_usage` | info/debug | context | `Agent.agentRuntime.subscribe` on `turn_end` / `EventInspection` | pi `turn_end` 后 | `curContextSize`, `lowWaterMark`, `highWaterMark`, `turnId` | agent loop 核心指标，可保存。 |
| 26 | `context.compact_skipped` | debug | context | `MessagePersistenceCoordinator.compactContextIfNeeded` | 低于 high watermark、空 messages、压缩无收益时 | `reason`, `curContextSize`, `messageCount` | agent loop 相关，debug 频繁记录有价值。 |
| 27 | `context.compact_triggered` | info | context | `MessagePersistenceCoordinator.compactContextIfNeeded` | `curContextSize >= highWatermark` 且计算出 tail window 后 | `curContextSize`, `targetKeep`, `beforeCount` | compact 决策点。 |
| 28 | `context.compact_blocked` | warn | context | `compactContextIfNeeded` | persist-before-compact 后 cursor 未追上全量时 | `persistedCursor`, `messageCount`, `pendingCount` | 防止丢未持久化消息。 |
| 29 | `context.compact_executed` | info | context | `Agent.ensureContextSize` / `compactContextIfNeeded` | `agentRuntime.replaceMessages` 后 | `beforeCount`, `afterCount`, `droppedCount`, `persistedCursor` | 用户要求的 compact 执行日志。 |
| 30 | `context.prompt_assembled` | info | context | `ContextManager.assembleSystemPrompt` | systemPrompt 拼装完成后 | `promptCharCount`, `sectionIds`, `usedTemplateFallback` | 启动语境，替代现有 debug 字符串。 |
| 31 | `context.prompt_file_restored` | warn | context | `ContextManager.ensureOptionalPromptFile` | SOUL/USER 缺失并从模板恢复后 | `fileName`, `filePath` | 现有 warning 应结构化。 |
| 32 | `context.prompt_file_read_failed` | error | context | `ContextManager.readRequiredFile` | 必需 prompt 文件读取失败时 | `label`, `path`, `error` | 启动失败根因。 |
| 33 | `context.skills_catalog_warning` | warn | context | `ContextManager.assembleSystemPrompt` | skills summary 有 warnings 时 | `code`, `location`, `message` | 与 agent prompt 质量相关，保留。 |
| 34 | `provider.model_resolved` | info | llm_provider | `modelFactory.createModelFromConfig` | provider/model 成功解析后 | `provider`, `model`, `category`, `supportsImageInput` | 启动语境。 |
| 35 | `provider.model_resolve_failed` | error | llm_provider | `modelFactory.resolveTargetProviderModel` | 无 enabled provider/model match 时 | `attemptedPairs`, `configuredProviders` | 配置错误。 |
| 36 | `provider.credentials_missing` | error | llm_provider | `ConfigManager.ensureProviderCredentials` 调用点 | Agent 创建时凭证检查失败 | `provider`, `envVar` | 启动失败或 runtime 激活失败。 |
| 37 | `tool.execution_start` | info/debug | tool | `Agent.agentRuntime.subscribe` 或 `EventInspection` 处理 `tool_execution_start` | pi-agent-core 发出工具开始事件时 | `toolName`, `toolCallId`, `turnId`, `argsPreview` | tool call 是核心 agent loop 行为，可较详细。 |
| 38 | `tool.execution_end` | info | tool | `Agent.agentRuntime.subscribe` 或 `EventInspection` 处理 `tool_execution_end` | 工具结束事件时 | `toolName`, `toolCallId`, `durationMs`, `ok`, `resultBytes` | 统一工具结束。 |
| 39 | `tool.execution_update` | debug | tool | `EventInspection` 处理 `tool_execution_update` | 工具中间更新时 | `toolName`, `toolCallId`, `updateType` | 只 debug 或采样，避免刷屏。 |
| 40 | `tool.bash_blocked` | warn | tool | `bashTool.createBashTool().execute` | policy/timeout 参数/工作目录检查拒绝命令时 | `blockedReason`, `restrictToWorkspace`, `timeoutMs`, `commandPreview` | 现在只返回工具结果，建议也记录。 |
| 41 | `tool.bash_timeout` | warn | tool | `bashTool.runCommand` timeout path | timeout timer 触发 SIGTERM/SIGKILL 时 | `toolCallId`, `timeoutMs`, `durationMs`, `stdoutBytes`, `stderrBytes` | 用户特别提到的 timeout 类问题。 |
| 42 | `tool.bash_aborted` | warn/debug | tool | `bashTool.runCommand` abort handler | runtime abort 或 turn cancel 时 | `toolCallId`, `turnId`, `durationMs` | 正常 abort 可 debug，异常 abort 可 warn。 |
| 43 | `tool.bash_complete_nonzero` | warn | tool | `bashTool.execute` after `runCommand` | exitCode 非 0 且非 timeout | `exitCode`, `stderrBytes`, `stdoutBytes`, `stderrPreview` | 非致命但排障重要。 |
| 44 | `tool.web_search_provider_failed` | warn | tool | `webSearchTool.createWebSearchTool` | Tavily/Linkup HTTP、网络、payload 异常 | `provider`, `status`, `errorCode`, `message` | 现在作为工具结果返回，建议额外记录。 |
| 45 | `tool.web_search_fallback` | info/warn | tool | `webSearchTool` Tavily credits fallback | Tavily credits 不足后尝试 Linkup | `from`, `to`, `fallbackReason` | 外部服务降级语境。 |
| 46 | `event_inspection.publish_failed` | warn | system | `EventInspection.processEvent` | runtime event/token/thinking status publish 抛错 | `eventType`, `kind`, `error` | 当前已 warn，建议结构化。 |
| 47 | `agent_event.observer_failed` | warn | system | `Agent.agentRuntime.subscribe` observer catch | `onAgentEvent` 抛错 | `eventType`, `error` | 避免 inspection 破坏 agent loop。 |
| 48 | `agent.inbound_poll_failed` | warn | agent_turn | `Agent.checkAndWaitInboundMessage` catch | inboundSource 失败后 sleep 250ms | `error`, `retryDelayMs` | 当前已有 warn。 |
| 49 | `message.bus_subscriber_failed` | warn | message | `InMemoryMessageBus.dispatch` | subscriber handler throw/reject 时 | `subscriberId`, `filter`, `error` | MessageBus 非核心，只保留异常，不记录正常 enqueue。 |
| 50 | `gateway.telegram_runtime_activate_failed` | error | gateway | `handleTelegramMessage` `accept_activate` catch | `buildSessionRuntime` 或 credential/model/prompt 失败 | `chatId`, `userId`, `error` | gateway 正常路径少记，只保留关键失败。 |
| 51 | `gateway.media_photo_failed` | warn | gateway | `handleTelegramMessage` photo catch | getFileLink/download/write 失败 | `error`, `messageId` | 用户可见失败。 |
| 52 | `gateway.voice_ffmpeg_failed` | warn/error | gateway | `ffmpegAudioConverter.convertVoiceToMp3` catch | ffmpeg 不可用、转换 timeout/失败 | `ffmpegCommand`, `timeoutMs`, `error` | voice 转写关键错误。 |
| 53 | `gateway.voice_transcription_failed` | warn/error | gateway | `TelegramVoiceTranscriber.transcribe` / `OpenAiTranscriptionClient.transcribe` | API key 缺失、HTTP 非 2xx、空 transcript、超限 | `model`, `status`, `error` | 用户可见 voice 失败。 |
| 54 | `gateway.telegram_egress_failed` | warn/error | gateway | `createTelegramEgressRelay` catch | formatted/plain send 均失败 | `chatId`, `error` | 出站丢失。 |
| 55 | `gateway.telegram_message_failed` | warn | gateway | `messageQueue.catch` | 串行消息处理 promise reject | `error` | 只保留异常。 |
| 56 | `command.executed` | info | command | `RuntimeCommandController.execute` / 调用点 | command result replies 生成后 | `commands`, `replyCount` | runtime 配置变更会影响日志/inspection，保留。 |

## 补充统计结论

- 建议首批实现 **56 个事件点**，其中高频/详细日志主要集中在 Agent Loop、Context、Persistence、Tool Call。
- `message.user_published` 与 `message.assistant_published` 已删除，相关信息并入 `agent_turn.start` 与 `agent_turn.complete`，减少重复噪音。
- MessageBus、Gateway、Command 这类外围子系统只保留异常、激活失败和会影响 runtime 状态的事件；正常 publish/enqueue/send 不默认记录。
- 持久格式使用 `latest.ndjson`，便于 coding agent 用 `read_file`、`grep`、bash 文本工具分析；TTL 在 NDJSON sink 层通过保留最后 `maxEntries=1000` 行和 `maxAgeMs` 清理实现。

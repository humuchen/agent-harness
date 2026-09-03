# 项目执行图（AgentHarness.run 执行流）

> 配套图：`./diagrams/execution-flow.svg`
> 代码位置：`backend/core/src/harness.ts` — `AgentHarness.run(userInput)`（约 104–344 行）

## 1. 总览

`run()` 是框架的主循环：把「LLM 调用 ↔ 工具执行 ↔ 记忆读写」串成一个带护栏、可取消、可观测的闭环。一次运行 = 一个 Job（在 server 端提交到运行队列异步执行）。

## 2. 阶段拆解

1. **初始化**：生成 `runId`；`emit` 绑定到 `opts.onEvent`；构造 `AbortController`，把外部 `signal` 与 `timeoutMs` 定时器组合成统一的 `abortedFlag`。
2. **输入护栏**：`checkInput` 扫描密钥 / 提示词注入 / 超长输入；若本次 run 携带 `guardrailPolicy`（per-tenant / 行业画像覆盖），输入/输出/工具参数校验与脱敏均用该策略而非全局默认。被拦截则 `emit guardrail:blocked` 并直接 `return`，不进入循环。
3. **记忆加载**：若 `memory.hasPersistence`，从 `FileMemoryStore` / `SqliteMemoryStore` 加载长期笔记（跨 run 学习；默认 `MEMORY_BACKEND=sqlite` 已开启持久化）。
4. **系统提示注入**：把长期记忆（`memory.systemContext()`）拼进系统提示词，再 `memory.add` 系统 + 用户消息。
5. **主循环**（`for step < maxSteps`，**默认 24**，可经 `MAX_STEPS` 或前端「步数上限」按任务覆盖）：
   - **预算检查**：`tokenBudget` / `costBudget` 超限即熔断 `return`。
   - **LLM 调用**：`opts.llm(messages, schemas, { signal})`，用 `Promise.race` 与 `abortedFlag` 竞速，信号触发即返回 `[timeout]`/`[aborted]`。
   - **记账**：`recordTokens` + `estimateCost`（按 `llm/pricing.ts` 单价表）累计 `runCost` / `runTokens`，发出 `run:cost`，再次查预算。
   - **输出护栏**：`checkOutput` 拦截则 `return`。
   - **终结判定**：若无 `tool_calls` → 返回 `final answer`（若开启 `requireCompletion` 且内容为空且未达步数上限，则注入系统提示继续，避免空响应提前结束）。
   - **工具执行**：每个 `tool_call` 先过 `checkToolArgs`（参数护栏）；通过则 `tools.call(name, args)`（错误作为 result 回灌自愈），结果截断后 `memory.add(tool)`。
6. **收尾**：若注入了 `Verifier`（`verify` 选项），产出后自动校验；未过且 `verifyMaxRetries>0` 则注入自检提示重跑整个主循环（自愈），仍未过则加 `[verify:failed]` 标记。`memory.save()`（持久化）→ `redactOutput`（出口 PII 脱敏）→ `emit run:end` → `return final`。

> **闭环收口保证**：超时（`timeoutMs`）/ 外部取消（`signal`）/ 预算（`tokenBudget`/`costBudget`）任一触发即中止并返回 `[timeout]`/`[aborted]`/`[budget]`，不会无限挂起。路径内**无人工节点**——工具异常作为 tool message 回灌模型自愈。完整「自动闭环 vs 断点（审批/记忆/隔离/外部动作）」分析见 `../05-analysis/single-agent-closed-loop.md`。

## 3. 关注点如何在主循环中「零改动接入」

| 关注点 | 接入点 | 机制 |
|---|---|---|
| **记忆** | 步骤 3/4/6 + 每步 `memory.history()` | 加载、注入系统提示、滚动窗口、落盘 |
| **LLM 适配器** | 步骤 5b | 每步一次调用，`signal` 透传到 fetch 层 |
| **工具** | 步骤 5k | `ToolRegistry.call`；MCP 工具注册进同一注册表，流程一致 |
| **护栏** | 步骤 2 / 5h / 5k + 收尾 | 输入 / 输出 / 工具参数三层 + 出口 PII 脱敏 |
| **MCP 注册** | 组装期（`server/runner.ts` `mergeFrom(mcpManager.liveRegistry())`） | 不在 `run()` 内，注册进 `ToolRegistry` 后自然流过 |
| **onEvent / 可观测** | 全程 | `emit`：run:start/step:start/llm:call/llm:response/tool:start/tool:result/run:cost/guardrail:blocked/budget:exceeded/**run:meta**(agentId/workflowId/traceId/tenantId/decidedBy，全可选)/verify:result/run:end/error；`telemetry`：`incCounter`/`recordTokens`/`recordCost`/`recordError`/`withSpan`（tenantId 维度指标 `incCounterTenant` 等） |

## 4. 超时 / 取消

组合 `AbortController`（外部 `signal` + `timeoutMs` 定时器）驱动：
- `Promise.race` 在 LLM 调用处竞速 `abortedFlag`；
- 循环顶部（步骤 5a）与工具执行前（步骤 5k）显式检查 `signal.aborted`；
- `abortedMessage()` 按 `signal.reason` 返回 `[timeout]` / `[aborted]`。

## 5. server 端的「运行队列」解耦（水平扩展）

`POST /api/run` 提交即返回 `jobId`，真正执行由 worker 池（并发 `RUN_CONCURRENCY`，默认 4）异步完成；SSE 订阅先重放已发生事件再转发后续，断线可凭 `jobId` 续上。后端由 `QueueBackend` 接口抽象（`Memory` / `File` / `Redis`），多副本必须配 `REDIS_URL`。

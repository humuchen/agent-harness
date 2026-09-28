# agent-harness 与 LangChain / LangGraph 架构对比分析

> 成文日期：2026-09-28。对比基准：LangChain 1.x 与 LangGraph 1.x（两者于 2025-10-22 同日发布 1.0，承诺 2.0 前无破坏性变更；LangGraph 1.2 于 2026-05 发布）。本项目实现坐标以当日代码为准。
> 本文属分析评估文档；架构权威结论以 `01-architecture/architecture.md` 为准。

## 0. 结论摘要（TL;DR）

1. **定位不同**：agent-harness 不是 LangChain/LangGraph 那样的"编排库/框架"，而是**自带服务端（HTTP+SSE、BYOK、会话、MCP manager）与前端（Lit SPA）的产品化 Agent 运行时**，自包含部署；Lang* 是纯库生态，托管能力由商业化的 LangGraph Platform 提供。
2. **重叠区**：与 LangGraph 重叠集中在**持久化编排层**（检查点恢复、HITL、并发波次、流式事件）；与 LangChain 重叠集中在 **Agent 循环与工具/记忆层**。
3. **欠缺区**：主要不在"能力有没有"，而在**图抽象表达力**（动态 fan-out、reducer 状态通道、time travel、subgraph 复用）与**生态广度**（结构化输出 schema 体系、RAG 组件、provider 适配、评估链）。
4. **正向差异**：saga 补偿事务、预算/配额熔断、软截止收尾、BYOK 加密凭据、Jev 决策模型集成、计划模式全链路与前端三级恢复对账，均为 Lang* 不内建、需自建或借助生态的能力。
5. **一句话**：编排**可靠性语义**本项目更强；编排**表达力与生态**Lang* 更强。两者互补而非替代。

## 1. 对比对象与版本基准

| 维度 | agent-harness（本项目） | LangGraph 1.x | LangChain 1.x |
| --- | --- | --- | --- |
| 形态 | 自包含 monorepo 产品（core + server + client + webapp + services/rag + plugins） | 编排运行时库（StateGraph / Pregel 执行模型） | Agent 高层 API（`createAgent` + middleware），运行在 LangGraph 之上 |
| 核心抽象 | `AgentHarness.runLoop` 显式循环 + `DagEngine` 静态 DAG | State（channel/reducer）+ 节点/边/条件边 | Runnable 接口；LCEL 管道在 agent 路径已边缘化 |
| 持久化 | `FileWorkflowStore` 全量 JSON 快照（volatile/file 两种） | Checkpointer 可插拔（InMemory/SQLite/Postgres，平台自动配置） | 无内建（复用 LangGraph） |
| 托管/服务化 | 自带 server + webapp，自包含部署 | LangGraph Platform（Cloud/BYOC/Self-Hosted 分层） | LangSmith（追踪/评估） |
| 语言 | TypeScript（Node 22+） | Python / JS 双实现 | Python / JS 双实现 |

## 2. 能力映射总表

| 能力项 | agent-harness | LangGraph 1.x | LangChain 1.x |
| --- | --- | --- | --- |
| Agent 循环 | `AgentHarness.runLoop` 显式 for 循环（maxSteps 默认 12） | StateGraph 节点循环 + 条件边（`createAgent` 同构） | `createAgent` + middleware 管线 |
| 编排模型 | `DagEngine` 静态 DAG（Kahn 波次 + 并发工作池） | Pregel superstep + Send 动态 fan-out | LCEL 管道（数据流，agent 路径已弃用） |
| 持久化/恢复 | `FileWorkflowStore` 快照 + `run`/`resume` 双路径 | Checkpointer 可插拔 + time travel（`get_state_history`） | 无内建，复用 LangGraph |
| 人机协同 | `requireApproval` 波次门（run 置 awaiting）+ `approvals[]` 后 resume | `interrupt()` + `Command(resume=)`（节点内任意点） | `humanInTheLoopMiddleware` |
| 流式/事件 | 20+ 类 HarnessEvent + SSE + ALS 旁路 + trace 节点 | `stream_mode` 四种（values/updates/messages/custom）+ v2 类型安全 StreamPart | `content_blocks` 标准化多模态响应 |
| 记忆/上下文 | window + longTerm + summary 三层；启发式/Jev 打分压缩 | thread 检查点 + Store（跨会话语义记忆） | `SummarizationMiddleware` 自动摘要 |
| RAG | `services/rag` 独立微服务（BM25 + MMR，内存向量库） | 无内建 | 组件生态最全（Loaders/Splitters/VectorStores/Retrievers） |

## 3. 相同的设计（按层对照）

1. **Agent 循环**：`backend/core/src/harness.ts` 的 `runLoop` 是标准 ReAct 循环——`for step < maxSteps`（默认 12）：上下文压缩 → 动态工具选择 → LLM 调用 → 输出护栏 → 解析 `tool_calls`（为空则终止）→ 三阶段执行工具（按序准备/有界并发/按原序回填）→ 下一轮。与 LangChain `createAgent` / LangGraph 预置 agent 的 model→tools→条件回边结构同构。
2. **工具抽象**：`backend/core/src/tools.ts` 的 `ToolRegistry.register(name, description, JSON-Schema, fn)` 与 `defineTool()` ≈ LangChain `@tool` + schema 装饰器；MCP 工具以 `<server>__tool` 命名、经 `ToolRegistry.mergeFrom` 合流（`backend/core/src/integrations/mcp/` + `access/server/src/mcp-manager.ts`），与 LangChain 的 MCP 适配同型。
3. **编排**：`backend/core/src/workflow/engine.ts` 的 `DagEngine` 支持 `dependsOn` 拓扑、`condition` 分支（`steps.<id>.output` / `steps.<id>.state`）与级联跳过，对应 StateGraph 条件边；`execMode='parallel'` + `maxConcurrency` 工作池对应并行 superstep（差异见 §4-2）。
4. **持久化恢复**：`backend/core/src/workflow/store.ts` 全量 JSON 快照（def + 每 step 的 `StepRun{state,input,output,...}`）+ `run()`/`resume()` 双路径（resume 只跑非终态 step，`initialInput` 随检查点持久化），语义等价于 checkpointer + thread 恢复。
5. **HITL**：`StepDef.requireApproval` → 引擎在波次边界暂停整个 run（`state='awaiting'`、emit `wf:awaiting-approval`、落盘后 return），`approvals[]` 记录后经 resume 放行——与 `interrupt()` + `Command(resume=)` 的"暂停-持久化-恢复"三段式同构；服务端另有通用 `ApprovalTicket`（`access/server/src/approval.ts`，InMemory/Redis 双策略）。
6. **流式观测**：`backend/core/src/harness/types.ts` 的 HarnessEvent（run/llm/tool/guardrail/budget/plan/jev 全覆盖）经 SSE 下发（`access/server/src/routes/run-routes.ts`，15s 心跳注释帧），前端 `traceHandle` 建 trace 节点、`chat-trace.ts` 聚合 Insights——对应 Lang* 的 streaming + callbacks + LangSmith 追踪链。
7. **记忆**：`backend/core/src/memory.ts` 的 window/longTerm/summary 三层 + `MemoryStore` 三后端可插拔（volatile/file/sqlite，`memory-store.ts`）≈ LangGraph Store + SummarizationMiddleware 的分层记忆；压缩策略（预算剪枝 68% 目标、陈旧工具结果折叠、异步摘要）更细。
8. **多 Agent**：`SubAgentManager`（并发 4，子会话键 `{parent}:sub:{uuid8}`）+ server 端 `delegate_task` 工具、`TeamManager`（sequential/parallel/round-robin/competitive，competitive 按长度×权重投票）、A2A transport（local/HTTP），对应 subgraphs/supervisor 的方向（形态差异见 §4-3）。

## 4. 关键设计差异（取舍而非优劣）

1. **循环形态**：单文件显式 for 循环（预算熔断、软截止、溢出自愈全部内嵌主循环）vs 图/节点/通道抽象。本项目控制流透明、可审计、易插桩；代价是拓扑不可视化、不可声明式编排。
2. **并行模型**：Kahn **静态分层波次**（波次编译期由 `dependsOn` 确定，波内 `runWaveParallel` 工作池保序补位、fail-fast 不拉新、在途自然跑完）vs Pregel superstep + **Send API 动态扇出**（运行期决定并行度）。本项目无法"运行期 planner 产出 N 个子任务就扇出 N 个并行节点"。
3. **状态模型**：`inputMapping` 点对点传值——黑板即 `outputs: Record<stepId, unknown>`（`plan.ts: buildInputMapping` 注释自述"共享黑板"），并行步输出天然隔离、无写冲突；LangGraph 是全局共享 State + **reducer 合并规则**（如 `Annotated[list, operator.add]`），可表达累积语义但需处理并行写。本项目没有 reducer，跨步共享只能靠显式映射。
4. **中断粒度**：审批门是**波次边界整 run 挂起 + step 级快照**，恢复语义简单、无重放副作用问题；`interrupt()` 是**节点内任意语句处暂停**、resume 从节点顶部重放（要求前置代码幂等、不可逆操作放在 interrupt 之后）。粗粒度易用 vs 细粒度表达力。
5. **补偿事务（正向差异）**：`StepDef.onRolling` 逆序补偿已完成 step，补偿失败标 `compensate-failed`（非终态，resume 可重试）——类 Temporal 的 saga 语义；LangGraph 无内建补偿，只有 time travel。
6. **横切关注点载体**：预算熔断（`tokenBudget`/`costBudget`，每步双重检查）、租户配额（`quota/engine.ts`：QPS/并发/窗口 token/成本，进程内令牌桶 + 多副本 Redis Lua，故障 fail-open）、三层护栏（输入/输出/工具参数 + PII 脱敏 + 网络 allowlist/denylist）**编译进运行时核心**；LangChain 1.0 将同类能力做成**可插拔 middleware**（summarization/humanInTheLoop/pii/modelCallLimit）。方向一致、载体不同：本项目强绑定但开箱即用，Lang 生态可组合。
7. **工程边界**：server（SSE 路由、BYOK AES-256-GCM 用户级密钥、MCP manager、审批票据）+ webapp（计划执行三级恢复：内存 → 服务端镜像 `PlanExecMirror` → 反推；对账 `mergePlanStatusLookup` 镜像等级高者胜）是 Lang* 纯库没有的层，接近 LangGraph Platform 的部分职责，但为自包含开源部署形态。
8. **输出契约**：工具参数手写 JSON-Schema（无 zod/pydantic）+ LLM 结构化输出靠容错解析（`parsePlanOutput` 剥围栏、`PLAN_OUTPUT_CHECK_MAX=4` 多候选、`parsePlanOrClarify` 澄清分支）vs zod/pydantic schema **内联主循环的结构化输出**（LangChain 1.0 已把 structured output 折进 createAgent，无额外 LLM 调用）。本项目灵活但无类型级校验。
9. **动态工具选择**：`selectToolsForInput` 按输入相关性裁剪发给 LLM 的 schema 子集（`DYNAMIC_TOOL_TOPK` 默认 8 + `allowTools` 硬允许集）；Lang* 默认全量 tools 传入。

## 5. 欠缺的功能项

### 5.1 相对 LangGraph 1.x

| # | 缺口 | 说明 |
| --- | --- | --- |
| 1 | **Time travel** | `get_state_history` / `update_state` 可回滚到任意历史检查点、注入修正后重放；本项目 `resume()` 只能从最后快照续跑，不能从中间 step 分叉重执行 |
| 2 | **Send 式动态 fan-out** | 并行拓扑编译期锁死在 `dependsOn` 波次；无运行期动态扇出原语（`SubAgentManager` 有并发子代理，但不是图级动态拓扑） |
| 3 | **Subgraph 嵌套复用** | WorkflowDef 不能作为节点嵌入另一个 def（`teamRef`/A2A 是跨 agent 调用，非图复用） |
| 4 | **节点级 retry/cache/timeout 声明** | LangGraph `add_node(retry_policy, cache_policy, timeout)`；本项目 LLM 层有 failover/多 key 轮转、上下文溢出有自愈重试（4 次），但 step 层无通用重试策略 |
| 5 | **Checkpointer 后端生态** | workflow store 仅 volatile/file 两种实现（记忆层有 sqlite，工作流层无 Postgres/Redis 级实现）；LangGraph 有官方 SQLite/Postgres saver 且平台自动配置 |
| 6 | **状态中间态流** | `stream_mode` 的 values/updates（节点执行后的状态增量流）无对应物；本项目事件到 token/tool 粒度为止，无"状态 diff"流 |

### 5.2 相对 LangChain 1.x

| # | 缺口 | 说明 |
| --- | --- | --- |
| 1 | **结构化输出体系** | 无 schema 校验内联、无 withStructuredOutput 等价物；仅手写 JSON-Schema + 容错解析 |
| 2 | **RAG 生态深度** | 缺 document loaders / text splitters / 生产级向量库（pgvector/Qdrant/Milvus 等）/ 高级检索模式（ParentDocument、HyDE 等）；`services/rag` 目前为 `HashEmbedding` + 内存 JSON 向量库（tenant 强制过滤、BM25 + MMR rerank），仅适合小规模 |
| 3 | **Provider 广度与响应标准** | 仅 openrouter/openai + 自定义 base_url；缺 100+ 官方适配包与 `content_blocks` 级多模态标准（thinking/citation 等结构块需自行适配 `llm:reasoning`） |
| 4 | **Middleware 可组合生态** | 横切能力需改 harness 源码；LangChain 侧为可组合 middleware 数组 |
| 5 | **评估/回归工具链** | LangSmith evals 级（数据集、评估器、回归测试）缺失，仅 `services/rag/eval.ts` 局部覆盖 |

## 6. 反向差异：本项目独有、Lang* 需自建的能力

1. **Run 级预算熔断**：`tokenBudget`/`costBudget` 超限即 `budget:exceeded` 中止 + 软截止（默认 90s，≤ 总预算 1/4，到期注入收尾提示让模型主动收束而非硬砍）。
2. **租户配额引擎**：QPS/最大并发/窗口 token/窗口成本四维，进程内令牌桶 + 多副本 Redis Lua 原子脚本，故障 fail-open。
3. **Saga 补偿**（见 §4-5）。
4. **BYOK 加密凭据链**：`user_provider_keys` 表 AES-256-GCM 落库、GET 仅回掩码、per-run 注入；Jev key 同链路且绝不入 `process.env`。
5. **Jev（System One）决策模型集成**：非文本 LLM 校准决策，用于注入攻击打分、领域分类、分块打分、上下文压缩重要性打分；ALS 旁路事件通道 `run-events.ts` 让直连调用以 `jev:call` 汇入事件流。
6. **计划模式全链路**：澄清 → 两段式 propose → 前端确认 → `planToWorkflowDef` DAG 派发 → 产物归档（幂等 artifacts 接口）→ 前端三级恢复对账（内存 → 镜像 → 反推）。
7. **guardrails 行业基线**：`policy/` 行业画像（医疗/金融默认 deny-all）+ PII 脱敏 + 网络 allowlist/denylist + 日志脱敏。

## 7. 补齐建议与优先级

> **落地状态（2026-09-28 P6 批次）**：第 1–2 项（结构化输出 schema：`json-schema.ts` 校验器 + 工具参数 `validateArgs` 接入 harness 执行链 + `StepDef.outputSchema` 产出闸门）、
> 第 2 行动态 fan-out 原语（`StepDef.dynamic` + `spawn` 物化）、第 3 行检查点 DB 后端（`DbWorkflowStore`，PostgreSQL/SQLite 经 DbAdapter）、
> 以及 step 分叉重跑（`resetRunForRerun` + `POST /api/workflows/:id/rerun`）**均已实现并随 `backend/core/test/workflow-p6.test.cjs` 覆盖**；
> step 级重试（`retries`/`retryBackoffMs` + `wf:step:retry` 事件）同批落地。RAG 生产化与节点级 time travel 完整版仍为后续项。

| 优先级 | 事项 | 建议落点 |
| --- | --- | --- |
| P1 | 结构化输出 schema（zod 校验内联工具参数与 step 输出闸门） | `tools.ts`（schema 定义）+ `workflow/step-output.ts`（`inspectStepOutput` 已有挂点） |
| P2 | 动态 fan-out 原语（planner 运行期产出 N 任务即扇出 N 并行节点，受 `WF_MAX_CONCURRENCY` 约束） | `workflow/types.ts` 新增 `dynamic` step 类型 + `engine.ts` 波次扩展 |
| P2 | 工作流 checkpointer Postgres 后端 | `workflow/store.ts` 增加 `PgWorkflowStore`（对齐 `database-backends.md` 的方言层范式） |
| P3 | RAG 生产化（可插拔向量库 + 文档加载/切分管线） | `services/rag/src/store.ts` 抽象 `VectorStore` 接口（`EmbeddingProvider` 已是先例） |
| P3 | 节点级 retry_policy / time travel 只读回放 | `engine.ts`（retry）与 trace 链（回放仅前端只读，成本低） |

## 8. 附录

### 8.1 代码坐标索引

| 主题 | 坐标 |
| --- | --- |
| Agent 循环 / 预算 / 软截止 | `backend/core/src/harness.ts`（`maxSteps` 默认 12；`AGENT_SOFT_DEADLINE_MS` 默认 90s；`OVERFLOW_MAX_RETRIES=4`） |
| 工具注册 / 动态选择 | `backend/core/src/tools.ts`（`DYNAMIC_TOOL_TOPK=8`）；内置工具 `backend/core/src/builtins/index.ts`（`builtin__` 前缀、`allow(n)` 门控） |
| 工作流类型 / 引擎 / 存储 | `backend/core/src/workflow/{types,engine,store}.ts`（`WF_MAX_CONCURRENCY` 默认 16；`store.claim` 原子占位） |
| HITL / 审批 | `workflow/engine.ts`（波次门）+ `access/server/src/approval.ts`（ApprovalTicket）+ `routes/run-routes.ts`（`/:id/resume` `/:id/approve`） |
| 计划模式 | `backend/core/src/{plan-propose,plan}.ts` + `access/server/src/plan-store.ts` + `frontend/webapp/src/chat.ts`（`confirmPlan`/`confirmPlanViaWorkflow`）+ `chat-render-utils.ts`（`mergePlanStatusLookup`） |
| 事件 / 流式 / 追踪 | `backend/core/src/harness/types.ts` + `run-events.ts`（ALS）+ `telemetry.ts`（structLog）+ `frontend/webapp/src/{chat-run-runtime,chat-trace}.ts` |
| 记忆 | `backend/core/src/{memory,memory-store}.ts`；压缩专题 `docs/08-others/memory-context-compression.md` |
| 多 Agent | `backend/core/src/subagent/index.ts` + `teams/index.ts` + `a2a/transport.ts` |
| LLM 接入 / BYOK | `backend/core/src/llm/{openrouter,openai,failover,multi-key,pricing}.ts` + `access/server/src/{custom-models,provider-keys}.ts` |
| 配额 / 熔断 / 护栏 | `backend/core/src/quota/engine.ts` + `circuit-breaker.ts` + `guardrails.ts` + `policy/` |
| RAG | `services/rag/src/*`（设计文档 `docs/07-rag/external-rag-design.md`） |

### 8.2 参考来源

- LangGraph v1 发布说明（核心 API 与执行模型、typed interrupts、前端 SDK）：docs.langchain.com — What's new in LangGraph v1
- LangChain 1.0 / createAgent + middleware 模式与 LCEL 边缘化：LangChain v1 release notes 及多篇 2026 生产实践综述
- LangGraph checkpointer/interrupt/Send/time travel 语义：官方 Graph API / Persistence / Human-in-the-loop 文档
- 本项目事实：全部来自对仓库代码的直接核查（坐标见 §8.1），未经推断的部分已标注

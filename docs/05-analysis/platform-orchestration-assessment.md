# agent-harness 作为「统一智能体调度基座平台」的能力评估

> 评估对象：`@agent-harness/core` + `@agent-harness/server`（截至 2026-08-15 代码快照）
> 评估视角：能否作为**统一基座平台**，用于**调度与协调跨行业专业智能体**（医美 / 金融 / 医疗 / 教育 …）
> 评估口径：**已具备**（能力完整、默认生效）/ **部分具备**（有核心实现但有边界或缺口）/ **缺失**（无对应实现）
> 配套：本文聚焦「多智能体调度 / 协调」这一新维度；沙箱 / 进程隔离 / 自验证 / 自修复 / 插件化等单智能体维度见 `./platform-capability-assessment.md`。

---

## 0. 结论速览

**一句话结论：当前项目是一个优秀的「单智能体执行引擎 + 扎实的基础设施原语」，具备成为统一基座平台的良好地基，但还不是「多智能体调度 / 协调平台」。** 它缺的不是零散功能，而是三件**架构级一等公民**：

1. **「智能体（Agent）」本身不是一等实体** —— 系统里只有一个 `AgentHarness` 执行循环，所谓能力差异只是「同一 harness 挂了不同的工具集」。
2. **没有跨智能体的路由与编排** —— `RunQueue` 只做并发控制与排队，不做「按领域 / 能力 / 负载选择哪个 agent」的语义路由，也没有多 agent 工作流引擎。
3. **没有租户 / 行业隔离模型** —— 记忆隔离只到 `sessionKey` 粒度，护栏策略是全局唯一可变对象，跨行业数据（医疗 PII / 金融数据）会流经同一进程、同一全局 MCP 注册表、同一输出通道。

**好消息**：它的可扩展性范式（接口 + 默认实现 + 组合工厂）、MCP 运行时动态加载、类型化 `HarnessEvent`、可插拔队列后端（memory/file/redis）、RBAC/审批/护栏，恰好是搭建基座平台的「 plumbing 」。因此这是一次**有方向的模块化演进**，而不是推倒重写 —— 预计可复用 60%~70% 的现有资产。

| 基座核心能力 | 现状 | 一句话 |
|---|---|---|
| ① 智能体注册与发现 | **缺失** | 有 MCP 工具级服务发现的雏形，但无「agent」实体、无 AgentCard、无能力索引 |
| ② 任务路由与分发 | **缺失** | 有队列（RunQueue），但所有任务进同一个 harness，无语义路由 / 无按能力选 agent |
| ③ 跨行业上下文隔离与数据安全 | **部分具备** | 安全基因强（三层护栏 + PII 脱敏 + 密钥扫描），但缺租户 / 行业边界与数据分区 |
| ④ 统一通信协议与接口规范 | **部分具备** | 内部事件协议（HarnessEvent）与 MCP 很强，但无 A2A 协议 / 无 AgentCard 标准 |
| ⑤ 工作流编排与状态监控 | **部分具备** | 单 run 编排 + run 级可观测强；跨 agent 的 DAG 编排 / 跨 agent 追踪缺失 |

---

## 1. 现有架构速写（它实际是什么）

整个系统围绕一条主轴展开：

```
一个 prompt → 一个 AgentHarness.run() → 一组工具（内置 + Skills + 全局 MCP）→ 一份记忆（按 sessionKey）
```

关键事实（均已对照源码核实）：

- **单执行循环**：`backend/core/src/harness.ts` 的 `AgentHarness` 是一个线性 `LLM ↔ 工具 ↔ 记忆` 循环。整库只有这一种「智能体」形态。
- **工具即能力原语**：`ToolRegistry`（`tools.ts`）是一切能力的统一载体；MCP 工具以 `<server>__<tool>` 前缀合并进同一注册表（`mcp-manager.ts` + `runner.ts: tools.mergeFrom(mcpManager.liveRegistry())`）。
- **队列只管并发不管路由**：`RunQueue`（`run-queue.ts`）用 `RUN_CONCURRENCY`(默认 4) 限制并发、用 `runningSessions` 做同会话串行化、用 `JOB_TIMEOUT_MS` 看门狗兜底；但**每次 `execute()` 都 `assembleAgent()` 出一个挂满全部工具 + 全部 MCP 的全能 harness** —— 它并不知道「这个任务是医美的还是金融的」。
- **记忆隔离到会话**：`sessionKey`（来自 `body.sessionId` / `x-session-id` / 默认 `anonymous`）在 `file` / `sqlite` / `volatile` 后端做隔离，配合 `SESSION_MEMORY_MAX` LRU（`runner.ts`）。这是**会话级**，不是**租户 / 行业级**。
- **安全基因扎实**：`guardrails.ts` 在 input/output/tool-args 三层做归一化注入检测、密钥扫描、输出侧 PII 脱敏；`authz.ts` + `approval.ts` 提供 RBAC + 人工审批闸门。但护栏策略 `configureGuardrails` 是**全局可变单例**，不是 per-tenant。
- **可观测有基础**：类型化 `HarnessEvent`（`run:start` / `llm:call` / `tool:result` / `run:end` …）+ `/api/jobs` + `/api/metrics` + 可选 OTel。

> 核心洞察：当前平台解决的是「**如何可靠地跑好一个 agent**」，而「统一基座平台」要解决的额外问题是「**如何发现、路由、隔离、编排多个 agent**」。后者在现有代码里基本是空白。

---

## 2. 五大基座核心能力逐项评估

### 2.1 ① 智能体注册与发现机制

**现状：缺失（但底层模式已就绪 60%）。**

- 不存在「智能体」这个实体。最接近的是：
  - **MCP 服务注册**（`mcp-manager.ts`）：`parseMcpServersEnv()` 从 `MCP_SERVERS` 加载、`addServer()` 运行时接入、`presets()` 预设市场。这是**工具级**的「服务注册 / 发现」，可作为 agent 接入协议的雏形。
  - **Skills**（`skills/index.ts`）：`SkillRegistry` 把「工具 + 执行指引 + 触发词」打包；但它是**提示词层面**的能力包，不是可独立寻址、可被路由选中的 agent。
  - **HarnessClient**（`integrations/harness-client.ts`）：对接的是 Harness.io **环境编排平台**，用于拉起 / 销毁预览环境，与「智能体注册」无关。
- **缺口**：
  - 无 **AgentCard / 能力清单**（描述 agent 的领域、工具、输入输出 schema、版本、owner、SLA、健康度）。
  - 无 **Registry 存储**（目前 MCP 列表只存在 `McpManager.servers` 内存数组里，进程重启即丢，redis 不存 agent 元数据）。
  - 无 **能力索引 / 语义发现**（「帮我找一个能做医美合规审查的 agent」无法被解析）。
  - 无 **跨进程 / 跨主机 agent 发现**（远端行业 agent 怎么加入这个平台？目前只有 MCP 工具级接入或同 harness 代码级接入两条路）。

**评级：缺失。**

### 2.2 ② 任务路由与分发逻辑

**现状：缺失（有「分发」无「路由」）。**

- `RunQueue.submit()` 接收 `{mode, prompt, sessionKey, maxSteps, verify}`，**没有「目标 agent / 领域 / 能力」字段**。`execute()` 永远 `assembleAgent(job.mode, …)` 出一个万能 harness。
- 所谓「分发」只是：worker 池并发控制 + FIFO + 同会话串行化（`run-queue.ts: pump()`）。它**不感知能力**，也不会把「医美任务」送给「医美 agent」、把「金融任务」送给「金融 agent」。
- 无意图分类器、无 agent 评分 / 选择、无负载均衡、无成本 / 租户策略约束下的路由。
- `mode` 只有 `mock / real / real-mcp` —— 是**运行模式**，不是**领域路由**。

**评级：缺失。**

### 2.3 ③ 跨行业上下文隔离与数据安全管理

**现状：部分具备（安全基因为主，隔离边界为辅，租户模型缺失）。**

已具备：
- **会话级记忆隔离**：`sessionKey` → `file` / `sqlite` / `volatile` 后端分区（`runner.ts: getMemoryStore()`）；`SESSION_MEMORY_MAX` LRU 防膨胀。
- **三层内容护栏**：`guardrails.ts` 的 `checkInput / checkOutput / checkToolArgs`，含归一化提示词注入检测、密钥扫描、`redactOutput` 输出侧 PII 脱敏（邮箱 / 手机 / 身份证 / 银行卡 / IPv4 / API Key）。
- **RBAC + 审批**：`authz.ts` + `approval.ts` 按动作授权（`agent:run` / `mcp:add` / `memory:clear` …），敏感动作返回 202 + ticket。

关键缺口：
- **无租户 / 行业边界**：所有 run 共享同一 Node 进程、同一全局 MCP 注册表（`mcpManager.liveRegistry()` 被合并进每次 run）、同一全局 `guardrails` 策略实例。**医疗 PII 与金融数据没有任何强制边界**。
- **策略非 per-tenant**：`configureGuardrails(p)` 改的是全局单例。无法做到「医疗租户强制脱敏 + 金融租户额外审计 + 教育租户放宽」。
- **无数据分区 / 数据驻留**：跨行业数据落同一后端、同一输出通道，无分区键、无行业合规画像（如医疗等保 / 金融数据出境限制）。
- **无出网管控**：`web_fetch` 无域名白名单，MCP stdio 子进程可任意联网（`./platform-capability-assessment.md` 已指出）。
- **跨租户访问无强制隔离**：`sessionKey` 是客户端自报的弱标识，无租户认证锚定。

**评级：部分具备。**

### 2.4 ④ 统一通信协议与接口规范

**现状：部分具备（内部强，跨 agent 弱）。**

已具备：
- **类型化事件协议**：`HarnessEvent`（`harness.ts`）定义了完整的运行时事件 schema，是极好的「可观测契约」。
- **MCP 标准工具协议**：已用 `@modelcontextprotocol/sdk` 接入远端 / 本地工具，是业界标准，可支撑「工具即服务」。
- **HTTP + SSE 服务协议** + `client` SDK 建模 `/api/v1` + OpenAPI spec（`openapi.ts`）。

关键缺口：
- **无 Agent-to-Agent（A2A）协议**：agent 之间如何握手、如何传递任务、如何回传结果，没有定义。
- **无 AgentCard 标准**：外部行业 agent（第三方、异构实现）要接入平台，缺少一份「能力声明 + 接入契约」标准。
- **无跨 agent 任务信封（task envelope）**：任务在 agent 间 handoff 时，携带哪些字段（tenantId / traceId / 输入 schema / SLA / 回调用址）没有规范。
- **接入通道有限**：外部 agent 目前只能走 MCP（工具级）或同 harness（代码级），没有「远程异构 agent 以标准协议入驻」的入口。

**评级：部分具备。**

### 2.5 ⑤ 工作流编排与状态监控

**现状：部分具备（单 run 强，跨 agent 缺失）。**

已具备：
- **单 run 编排**：`AgentHarness.run()` 的线性循环 + 预算熔断 + 超时 + 验证门禁。
- **Skills 流程指引**：`SkillRegistry` 注入工作流提示词，但它是**提示词层面的软编排**，不是可执行的状态机。
- **run 级可观测**：`HarnessEvent` 流 + `/api/jobs`（脱敏状态）+ `/api/metrics`（token / 成本 / 延迟 / 错误率）+ 可选 OTel。

关键缺口：
- **无多智能体工作流引擎**：无法表达「医美 agent 完成 → 交给金融 agent → 再交教育 agent」的 DAG / 状态机。
- **无 agent 间 handoff / 子 agent 派发**：当前 harness 内部不会 spawn 另一个 agent。
- **无 step 级状态 / 检查点续跑**：一次长任务中断只能整体重来（`./platform-capability-assessment.md` 已指出）。
- **无跨 agent 链路追踪**：`traceId` / `span` 无法关联多个 agent 的调用链。
- **无工作流级监控**：`RunQueue` 的 job 状态是单 run 粒度，没有「工作流第 3 步在金融 agent 上卡住」这类视图。

**评级：部分具备。**

---

## 3. 可扩展性 / 插件化 / 多租户 三维现状与差距

### 3.1 可扩展性（Extensibility）
- **强**：`tool` / `LLM` / `MCP` / `queue-backend` / `approval` / `eval` 全面采用「接口 + 默认实现 + 组合工厂」；Redis 多实例 + `reclaimStale` 崩溃回收；水平扩展有基础。
- **弱**：新增一个**行业智能体**需要改 `assembleAgent()` 注册 skills / tools；**无动态 agent 加载**；执行仍在**单进程内**（无 per-job 进程隔离，见既有评估 P0）。

### 3.2 插件化架构（Plugin Architecture）
- **强**：`ToolRegistry` 是统一插件原语；**MCP 是运行时动态插件**（最强，配置驱动、无需重启）；Skills 是组合包；护栏 / 评估 / 队列后端均可插拔。
- **弱**：`builtins` / `Skills`（`defaultSkills()`）需**代码级变更**；**无插件清单（manifest）**、无版本 / 依赖解析、无安全隔离加载（接入的插件与核心**同进程同权限**）；无市场 / 目录分发。

### 3.3 多租户（Multi-tenant）
- **强**：`sessionKey` 记忆隔离 + LRU；RBAC + 审批；可插拔护栏。
- **弱**：**无真实租户模型**（job 上仅有 `sessionKey`，无 `tenantId`）；无租户开通 / 配额 / 计费；**无 per-tenant 策略 / 数据 / 网络隔离**；跨租户访问无强制边界。

> 三者共同的本质问题：**「租户 / 行业 / agent」都不是一等实体**，一切以「单次 run + 全局共享资源」为中心。

---

## 4. 改造方向：从「单智能体执行引擎」到「统一智能体调度基座」

### 4.1 目标分层架构（见附图）

```
┌──────────────────────────────────────────────────────────────────┐
│ 接入层：统一 API 网关 + A2A 协议边界（AgentCard / Task Envelope）   │
├──────────────────────────────────────────────────────────────────┤
│ 路由层：Intent Router → Agent Selector（能力/负载/成本/租户策略）    │
│        Workflow Orchestrator（DAG 状态机 / 多 agent handoff）       │
├──────────────────────────────────────────────────────────────────┤
│ 智能体层：Agent Runtime × N（每个 = harness + 专属工具集 + 专属记忆  │
│          + 专属护栏策略；医美/金融/医疗/教育 … 各自独立注册）          │
├──────────────┬──────────────┬──────────────┬─────────────────────┤
│ Agent Registry│ Tenant Service│ Policy Engine │ Observability(Trace)│
│ (AgentCard+  │ (隔离/配额/  │ (per-tenant  │ (traceId 跨 agent    │
│  心跳/发现)   │  合规画像)   │  护栏/出网)  │  关联 + 工作流监控)  │
├──────────────┴──────────────┴──────────────┴─────────────────────┤
│ 基座执行后端：RunQueue 升级为 Capability-aware Dispatcher           │
│            （redis 多实例 + 按 agent 能力分发 + per-tenant 分区）     │
└──────────────────────────────────────────────────────────────────┘
```

### 4.2 关键模块设计

**① Agent Registry & Discovery**
- 引入 **AgentCard** 清单：`{ id, name, domain(医美/金融/…), capabilities[], inputSchema, outputSchema, endpoint?, transport(mcp|a2a|local), version, owner, health, sla }`。
- Registry 存储：复用 `memory-store` 的 `MemoryStore` 接口（`Volatile/File/Sqlite`）扩展为 `AgentStore`，支持注册 / 心跳 / 注销 / 按能力查询。
- 发现 API：`/api/agents` 列出、`/api/agents/:id` 详情、按 `domain` / `capability` 过滤。
- 远端 agent 通过 A2A 协议「自注册」；本地 agent 在启动期登记。

**② Task Router / Orchestrator**
- **Intent Router**：对入站任务做轻量分类（规则 / 小模型 / LLM），产出 `{ domain, intent, requiredCapabilities[] }`。
- **Agent Selector**：从 Registry 取候选 → 评分（能力匹配度 + 实时负载 + 预估成本 + 租户策略权重）→ 选中目标 agent。
- **Workflow Orchestrator**：DAG / 状态机引擎，支持顺序 / 并行 / 条件分支；每个节点 = 一次 agent 调用；支持 checkpoint 续跑、失败补偿（解决既有评估 P1「副作用无回滚」）。
- 复用 `RunQueue`：将其升级为 **capability-aware dispatcher**（按目标 agent 投递，而非统一 harness）。

**③ Tenant & Industry Isolation**
- 引入 **TenantContext**：`{ tenantId, industry, policyRef }` 贯穿 run 全链路（从 `handleRun` 注入，经 `assembleAgent` → `AgentHarness` → `Memory` → 输出）。
- **数据分区**：记忆 / 向量库按 `tenantId` 分桶（扩展 `MemoryStore` 增加 `tenantId` 维度）；医疗 / 金融租户使用独立后端或加密分区。
- **per-tenant Policy**：把全局 `configureGuardrails` 改为 `PolicyEngine.getPolicy(tenantId)`（从 Registry 拉取行业合规画像：医疗强制脱敏 + 审计、金融数据出境限制、教育放宽）。
- **出网管控**：`web_fetch` / MCP 按租户策略走域名白名单。

**④ Unified Agent Protocol（A2A）**
- 定义 **Task Envelope**：`{ taskId, tenantId, traceId, fromAgent, toAgent, input, schema, sla, callback }`。
- 桥接两种标准：**MCP**（工具级接入，已有）+ **A2A**（agent 级协作，新增）。外部异构行业 agent 用 A2A 入驻。
- 扩展 `client` SDK 与 OpenAPI，覆盖 agents / tasks / workflows 资源。

**⑤ Workflow Engine + Observability**
- DAG 执行器：step 状态机（pending / running / done / failed / compensated），持久化到 `queue-backend` 同类接口。
- **跨 agent 追踪**：`traceId` 贯穿所有 agent 调用；`HarnessEvent` 扩展 `agentId` / `workflowId` 字段，OTel span 跨 agent 关联。
- 工作流级监控面板：区别于当前 job 级，补充「第 N 步在哪个 agent、耗时、健康」。

**⑥ Plugin Framework**
- **Plugin Manifest**（类 `package.json`）：`{ id, version, capabilities[], dependencies[], permissions[], transport }`。
- 热加载 + 版本 / 依赖解析 + 生命周期（install / enable / disable / upgrade）。
- **隔离加载**：插件在独立 `worker_thread` / 子进程运行并裁剪权限（解决既有评估 P0「同进程同权限」），而非与核心同堆。

### 4.3 复用现有资产（避免重写）

| 现有资产 | 在基座平台中的角色 |
|---|---|
| `RunQueue` + redis 后端 + `reclaimStale` | 升级为 **capability-aware dispatcher**（多实例、崩溃回收复用） |
| `HarnessEvent` | 扩展为**跨 agent trace 事件**（加 `agentId` / `workflowId`） |
| MCP `placeholder.ts` | 既是工具插件，也可作为**远端 agent 接入协议之一**（A2A 的补充） |
| `guardrails.ts`（PII / 注入 / 密钥） | 作为 **PolicyEngine 的默认策略集**（per-tenant 复制） |
| `memory-store`（file / sqlite） | 作为 **per-tenant 分区**的存储底座 |
| `authz.ts` / `approval.ts` | 升级为 **tenant-scoped RBAC + 审批** |
| `SkillRegistry` | 演进为 agent 内部的「能力包」机制，与 AgentCard 对齐 |

---

## 5. 演进路线图（分阶段，复用优先）

- **P0 — 基座成型（先让多 agent 跑起来）**
  - `AgentCard` 协议 + `Agent Registry`（本地 agent 注册 / 发现）
  - `Task Router`（单跳：分类 → 选 agent → 分发；先支持本地多 agent）
  - `TenantContext` + 数据 / 策略隔离（per-tenant 记忆分区 + per-tenant 护栏）
  - 复用 `RunQueue` 做按 agent 分发的最小改造

- **P1 — 编排增强（让多个 agent 协同）**
  - `Workflow Orchestrator`（DAG 状态机 + 多 agent handoff + 补偿回滚）
  - 跨 agent 链路追踪（`traceId` + 扩展 `HarnessEvent`）
  - `Plugin Manifest` + 热加载骨架

- **P2 — 生产化（让平台可运营）**
  - 插件市场 / 目录分发 + 版本依赖解析 + 隔离加载
  - 配额 / 计费 / 审计（per-tenant）
  - 行业合规画像（医疗等保 / 金融出境 / …）
  - per-job 隔离执行（容器 / worker_thread，呼应既有评估 P0）

---

## 6. 结论与建议

1. **是否具备作为统一基座平台的能力？**
   - 作为「单智能体执行引擎」：**已具备且扎实**（记忆 / 护栏 / 队列 / MCP / 可观测 / RBAC 都到位）。
   - 作为「多智能体调度 / 协调基座」：**当前不具备**，缺 agent 实体、跨 agent 路由、工作流引擎、租户 / 行业隔离模型。这是**架构级空白**，不是补几个函数能解决的。

2. **建议路径**：**演进而非重写**。现有可扩展性范式（接口 + 默认 + 工厂）、MCP 动态加载、类型化事件、redis 队列、护栏，正是基座平台的 plumbing。按 P0→P1→P2 路线，先把「Agent 注册 / 发现 + 路由 + 租户隔离」三件套补上，即可支撑「医美 / 金融 / 医疗 / 教育」多 agent 协同的 MVP。

3. **前置安全前提**：既有评估的 P0（**无 OS 级代码执行隔离**）仍是承载不可信多行业 agent 的硬前提；且**租户 / 行业隔离模型必须先于多行业上线**，否则医疗 PII 与金融数据会在同一进程 / 同一输出通道混流。

4. **最大杠杆点**：`AgentCard` + `Task Router` + `TenantContext` 三个模块的引入，能把「一个万能 harness」重构为「N 个领域 agent + 一个调度内核」，而底层 70% 的执行 / 安全 / 可观测代码可以原样复用。

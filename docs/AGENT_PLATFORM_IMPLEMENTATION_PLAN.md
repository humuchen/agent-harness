# 统一智能体调度基座 — 缺失能力实现计划（Plan & 实现方式）

> 配套 `docs/AGENT_ORCHESTRATION_PLATFORM_ASSESSMENT.md`（评估结论：当前是优秀的「单智能体执行引擎」，但缺「智能体 / 路由 / 租户 / A2A / 工作流」五大基座能力）。
> 本文件给出**具体落地计划**：对每个缺失能力，指明新增/修改的**精确文件与函数锚点**、**关键类型签名**与**实现方式**，并遵循评估的「演进而非重写」「复用 60–70% 资产」原则。
> 评估中已核实的代码锚点（均已对照源码确认）：
> - `packages/server/src/runner.ts:163` `assembleAgent()` —— 当前构建「万能 harness」，第 221 行 `tools.mergeFrom(mcpManager.liveRegistry())` 把**全部 MCP** 合并进每次 run。
> - `packages/server/src/run-queue.ts:93` `submit()` + `:372` `execute()` —— 仅 `sessionKey` 隔离，永远 `assembleAgent(job.mode, …)`，无任何 agent/domain/tenant 维度。
> - `packages/server/src/queue-backend.ts:22` `JobDescriptor` —— 仅 `mode/prompt/model/sessionKey/maxSteps/verify`。
> - `packages/core/src/guardrails.ts:70` 全局单例 `policy` + `:73` `configureGuardrails()` —— 非 per-tenant。
> - `packages/core/src/memory-store.ts:26` `MemoryStore` 接口 —— `load/save/delete/list(key)`，单字符串 key。
> - `packages/core/src/harness.ts:14` `HarnessEvent` / `:29` `HarnessOptions` —— 无 `agentId/workflowId/traceId`。

---

## 0. 总体原则与三个一等实体

- **演进不重写**：现有 `RunQueue` + redis 后端、`HarnessEvent`、`MCP placeholder`、`guardrails`、`memory-store`、`authz/approval`、`SkillRegistry` 全部作为「plumbing」原样复用。
- **新增三个一等实体**：`Agent`（领域智能体）、`Tenant`（租户/行业）、`Workflow`（多 agent 编排）。它们不是新进程，而是挂在既有 `AgentHarness` 之上的「装配配方 + 调度元数据」。
- **向后兼容**：所有新字段均为**可选**，缺省时退化为今天的「全局策略 + 单 sessionKey 记忆 + 万能 harness」。默认注册表里 seed 一个 `default` 通用 agent，使现有 UI 零改动可用。
- **特性开关**：用 `AGENT_REGISTRY` / `TASK_ROUTER` / `TENANT_ISOLATION` / `WORKFLOW_ENGINE` 环境变量分别开启，未开则降级为现有行为（「一切降级可用」）。

---

## 1. P0 — 基座成型（先让多 agent 安全跑起来）

### 1.1 ① 智能体注册与发现（Agent Registry & Discovery）

**目标**：把「agent」变成一等实体，具备 AgentCard 能力清单 + 可持久化注册表 + 按 domain/capability 发现。

**新增模块 `packages/core/src/agents/`**

- `types.ts` —— AgentCard 与配套类型：
  ```ts
  export type AgentTransport = 'local' | 'mcp' | 'a2a';
  export type IndustryDomain = 'medical-aesthetics' | 'finance' | 'healthcare' | 'education' | 'generic' | (string & {});
  export interface AgentCapability { id: string; version?: string; inputSchema?: Record<string, unknown>; outputSchema?: Record<string, unknown>; }
  export interface AgentHealth { status: 'healthy' | 'degraded' | 'down'; lastHeartbeat: number; load: number; }
  export interface AgentCard {
    id: string; name: string; domain: IndustryDomain; description?: string;
    capabilities: AgentCapability[]; transport: AgentTransport; endpoint?: string;
    version: string; owner?: string; health: AgentHealth;
    sla?: { p95LatencyMs?: number; maxConcurrency?: number };
    /** 本地 agent 的装配配方：assembleAgent 只挂这些，而非全部工具/MCP */
    assembly?: { systemPrompt?: string; skills?: string[]; mcpServers?: string[]; tools?: string[] };
  }
  ```
- `store.ts` —— `AgentStore` 接口（复用 `MemoryStore` 的「接口 + 默认实现 + 工厂」范式）：
  ```ts
  export interface AgentStore {
    register(card: AgentCard): Promise<void>;
    heartbeat(id: string, health: Partial<AgentHealth>): Promise<void>;
    deregister(id: string): Promise<void>;
    get(id: string): Promise<AgentCard | null>;
    list(): Promise<AgentCard[]>;
    query(filter: { domain?: IndustryDomain; capability?: string }): Promise<AgentCard[]>;
  }
  ```
  提供 `VolatileAgentStore`（默认）/ `FileAgentStore` / `SqliteAgentStore`（keyed by `agentId`），与 `memory-store.ts` 同构。
- `registry.ts` —— `AgentRegistry` 包裹 store，维护 capability → agentId 内存倒排索引，启动期 sweep 掉超时心跳（down）的 agent。
- `index.ts` —— barrel 导出。

**修改（精确锚点）**
- `packages/server/src/runner.ts:163` `assembleAgent()`：新增形参 `card?: AgentCard`。
  - 当 `card` 为 `undefined` → 行为完全不变（今天的全能 harness，向后兼容）。
  - 当 `card` 存在 → 按 `card.assembly` **收窄**工具集：`registerBuiltinTools` 只开 `assembly.tools`；`skillRegistry.registerMany(defaultSkills().filter(s => card.assembly.skills?.includes(s.id)))`；`tools.mergeFrom` 仅合并 `card.assembly.mcpServers` 指定的 MCP（需给 `mcpManager.liveRegistry()` 增加按 server 名过滤的能力，或在 merge 前过滤 entries）；系统提示词改用 `card.assembly.systemPrompt`。
- `packages/server/src/server.ts`：新增路由
  - `GET /api/agents`（支持 `?domain=&capability=` 过滤）、`GET /api/agents/:id`、`POST /api/agents`（注册/远端 A2A 自注册，P1 接入）。
  - `POST /api/run` 的 body 增加 `agentId?`（显式指定目标 agent，绕过路由）。
- `packages/core/src/index.ts`：导出 `agents`。

**测试**：`packages/core/test/agents.test.cjs`（register/heartbeat/deregister/query）、`packages/server/test/agents.test.cjs`（端点 + assembleAgent 收窄）。

### 1.2 ② 任务路由与分发（Task Router → capability-aware Dispatcher）

**目标**：把 `RunQueue` 从「统一 harness 队列」升级为「按能力选 agent 再分发」的调度器；引入 Intent Router + Agent Selector。

**新增模块 `packages/core/src/router/`**
- `intent.ts` —— `IntentRouter.classify(prompt): Promise<{ domain: IndustryDomain; intent: string; requiredCapabilities: string[] }>`。默认规则引擎（领域词典 + 关键词）；`INTENT_ROUTER=llm` 时用小模型/LLM 分类（复用 `createOpenRouterLLM`）。轻量、可缓存。
- `selector.ts` —— `AgentSelector.select(registry, intent, ctx): AgentCard | null`。评分 = 能力匹配度（capability 交集）× 健康度（1 - load）× SLA × 租户策略亲和（P0.3 的 `policyRef`）。取最高分；无候选返回 null（回退 default agent）。
- `router.ts` —— `TaskRouter.resolve(job)`：
  1. 若 `job.agentId` 显式 → 直接取 card；
  2. 否则若 `job.domain` → 过滤候选；
  3. 否则 `intent.classify` 再 `selector.select`。
  返回 `{ agentId, card }`。
- `index.ts` 导出。

**修改（精确锚点）**
- `packages/server/src/run-queue.ts:93` `submit(input)` 增加 `agentId?`、`domain?`、`tenantId?`、`workflowId?`、`traceId?`。
- `packages/server/src/queue-backend.ts:22` `JobDescriptor` 同步增加上述字段（保持 JSON 可序列化）。
- `packages/server/src/run-queue.ts:372` `execute()`：
  - 构建 `TenantContext`（P0.3）；
  - `const { card } = await router.resolve(job)`（开关 `TASK_ROUTER` 关闭时返回 default card）；
  - `assembleAgent(job.mode, onEvent, …, job.sessionKey, …, /* card */ card, /* tenantCtx */ tenantCtx)`；
  - 把 `agentId`/`workflowId`/`traceId` 注入 `run:meta` 事件。

**复用**：`RunQueue` 并发/看门狗/同会话串行化/`reclaimStale` 一行不改，仅 `execute` 内多一步 resolve。

**测试**：`packages/core/test/router.test.cjs`（classify/select/resolve，含显式 agentId 短路）、`run-queue` 现有测试不受影响（默认开关下行为不变）。

### 1.3 ③ 跨行业上下文隔离与数据安全（Tenant Isolation）

**目标**：引入 `TenantContext`，实现 per-tenant 记忆分区 + per-tenant 护栏策略 + 出网管控；租户身份锚定到认证，防止客户端自报 `sessionKey` 越界。

**新增**
- `packages/core/src/tenant.ts`：`TenantContext { tenantId: string; industry?: IndustryDomain; policyRef?: string }`；`resolveTenantContext(body, auth)` 辅助（从 `body.tenantId` + 已认证的 JWT sub/`authz` 身份派生，客户端不可伪造）。
- `packages/core/src/policy/engine.ts` —— `PolicyEngine`：
  ```ts
  class PolicyEngine {
    private perTenant = new Map<string, GuardrailPolicy>();
    private default: GuardrailPolicy;          // 沿用现有 resolveDefaultPolicy()
    setPolicy(tenantId, p): void;
    getPolicy(tenantId): GuardrailPolicy;       // 命中缓存否则 default
    /** 行业合规画像：医疗强制脱敏+审计、金融出境限制、教育放宽 */
    registerIndustryProfile(industry, policy): void;
  }
  ```
  全局单例 `policyEngine`（替代 `guardrails.ts` 里裸 `policy` 变量）。

**修改（精确锚点）**
- `packages/core/src/guardrails.ts:73` `configureGuardrails()` 改为「设置 default 策略」；`checkInput/checkOutput/checkToolArgs` 增加可选 `policy?: GuardrailPolicy` 形参（缺省读 `policyEngine.getPolicy(tenantId)` 或全局 default，向后兼容）。
- `packages/core/src/harness.ts:29` `HarnessOptions` 增加 `guardrailPolicy?: GuardrailPolicy`；harness 调用三个 check 时透传该 policy。
- `packages/core/src/memory-store.ts`：记忆分区**不改接口**，仅在调用侧构造复合 key —— `packages/server/src/runner.ts:136` `getSessionMemory()` 改为 `getSessionMemory(tenantCtx ? sanitizeKey(tenantCtx.tenantId) + '::' + sanitizeKey(sessionKey) : sessionKey, …)`。file/sqlite 后端天然按 key 分桶 → 医疗 PII 与金融数据落到不同文件/行。
- `packages/server/src/runner.ts:163` `assembleAgent` 增加 `tenantCtx?`，内部用 `policyEngine.getPolicy(tenantCtx.tenantId)` 注入 harness，并按租户策略给 `web_fetch`/`filesystem` 工具加 `allowedDomains`/`deniedDomains`（出网管控）。
- `packages/server/src/server.ts` `handleRun`：从 `authz` 校验结果取租户身份，构造 `TenantContext` 传入 `submit()`。

**测试**：`packages/core/test/policy.test.cjs`（per-tenant 覆盖 default）、`packages/server/test/tenant.test.cjs`（复合 key 分区 + 越界拒绝）。

### 1.4 复用 RunQueue 作为 dispatcher（小结）
P0.2 的修改即是「capability-aware dispatcher」的最小实现：redis 多实例、`reclaimStale`、同会话串行化全部复用，只新增「resolve 目标 agent」一步。**不新增独立 dispatcher 模块**。

---

## 2. P1 — 编排增强（让多个 agent 协同）

### 2.1 ⑤ 工作流编排与状态监控（Workflow Orchestrator）

**目标**：DAG/状态机引擎，支持顺序/并行/条件分支、多 agent handoff、checkpoint 续跑、失败补偿（解决评估 P1「副作用无回滚」）。

**新增 `packages/core/src/workflow/`**
- `types.ts`：
  ```ts
  export type StepState = 'pending' | 'running' | 'done' | 'failed' | 'compensated';
  export interface StepDef { id: string; agentRef: string | AgentCard; inputMapping: Record<string, string>; dependsOn?: string[]; compensate?: string; }
  export interface WorkflowDef { id: string; steps: StepDef[]; }
  ```
- `engine.ts` —— `DagEngine`：拓扑排序 → 并行执行无依赖 step；每个 step 用 `assembleAgent(card)` + `harness.run(input)`；step 状态持久化到 `WorkflowStore`；失败时对已完成 step 逆序执行 `compensate`（委托对应 agent 的补偿工具或回滚指令）；支持 `resume(workflowId)` 从 checkpoint 续跑。
- `store.ts` —— `WorkflowStore`（复用 `QueueBackend`/`MemoryStore` 接口范式，存 `WorkflowDef` + 每 step 状态）。

**修改**
- `packages/core/src/harness.ts:14` `HarnessEvent` 各变体加可选 `agentId?`/`workflowId?`/`traceId?`；`HarnessOptions` 加 `agentId?`/`workflowId?`/`traceId?`，`emit` 装饰事件。
- `packages/server/src/server.ts`：新增 `POST /api/workflows`（定义并运行）、`GET /api/workflows/:id`、SSE 进度；`run:meta` 与 `/api/metrics` 补充「第 N 步在哪个 agent、耗时、健康」视图。
- 可观测：`traceId` 贯穿所有 agent 调用，OTel span 跨 agent 关联（`telemetry.ts` 已有 `withSpan`）。

**测试**：`packages/core/test/workflow.test.cjs`（DAG happy path + 补偿回滚 + 续跑）。

### 2.2 ④ 统一通信协议与 A2A（Task Envelope + 远端 agent 入驻）

**目标**：定义 Task Envelope，桥接 MCP（工具级，已有）与 A2A（agent 级，新增），让异构远端行业 agent 以标准协议入驻。

**新增 `packages/core/src/a2a/`**
- `types.ts`：
  ```ts
  export interface TaskEnvelope { taskId: string; tenantId: string; traceId?: string; fromAgent: string; toAgent: string; input: unknown; inputSchema?: Record<string, unknown>; sla?: { timeoutMs?: number }; callback?: string; }
  export interface TaskResult { taskId: string; status: 'success' | 'failed'; output?: unknown; error?: string; }
  ```
- `transport.ts` —— `A2ATransport` 接口 + `LocalA2ATransport`（进程内直接 `assembleAgent`+`run`，用于同进程多 agent handoff）、`HttpA2ATransport`（`fetch` 远端 agent 的 `/api/a2a/tasks`）。

**修改**
- `packages/server/src/server.ts`：新增 `POST /api/a2a/tasks` —— 接收远端 agent 任务（自注册 AgentCard + 执行 + 回传 `TaskResult`）；`TaskRouter` 选中 `transport: 'a2a'` 的远端 agent 时，经 `HttpA2ATransport` 派发。
- `packages/client` + `openapi.ts`：扩展 `agents` / `tasks` / `workflows` 资源与类型。

### 2.3 插件框架骨架（Plugin Framework）

**目标**：Plugin Manifest + 生命周期 + 隔离加载骨架（完整市场留 P2）。

**新增 `packages/core/src/plugin/`**
- `manifest.ts` —— `PluginManifest { id; version; capabilities[]; dependencies[]; permissions[]; transport; entry }`。
- `loader.ts` —— `PluginLoader`：`install/enable/disable/upgrade` 生命周期；依赖解析；以**隔离**方式加载（新建 `worker_threads` 或 `child_process` + 本会话已落地的 OS 沙箱后端 `createSandboxExecutor({ backend: 'os' | 'container' })`），与核心进程不同堆同权限问题；manifest 的 `capabilities` 自动转成 `AgentCard` 注册进 Registry。

---

## 3. P2 — 生产化（让平台可运营）

| 项 | 实现方式 | 复用/新增 |
|---|---|---|
| 插件市场/目录分发 | 在 P1.3 `PluginLoader` 上加远程 registry 拉取 + 版本/依赖解析 + 签名校验 | 扩展 `plugin/` |
| 配额/计费/审计（per-tenant） | `PolicyEngine` 增 `quota`（QPS/并发/token/成本上限）；`/api/metrics` 按 tenantId 聚合；审计事件落 `tenantId` 维度日志 | 扩展 `policy/` + `telemetry.ts` |
| 行业合规画像 | 预置医疗等保 / 金融数据出境 / 教育放宽的 `GuardrailPolicy` 模板，注册进 `PolicyEngine.registerIndustryProfile` | `policy/` |
| **per-job 隔离执行** | `assembleAgent` 的 shell/工具执行统一走 `createSandboxExecutor({ backend: 'os' })`（本会话已实现的命名空间+seccomp+rlimit+caps），不可信跨行业 agent 强制容器/独立进程隔离 | 复用 `builtins/sandbox.ts` + `sandbox/` |

> 前置硬约束（评估第 3 节已强调）：**OS 级代码执行隔离（本会话已实现）必须先于不可信多行业 agent 上线**；且**租户/行业隔离模型（P0.3）必须先于多行业上线**，否则医疗 PII 与金融数据会在同一进程/输出通道混流。

---

## 4. 分阶段交付清单与验证策略

| 阶段 | 交付物（新增文件） | 修改锚点 | 验证 |
|---|---|---|---|
| **P0.1** | `core/src/agents/{types,store,registry,index}.ts` | `runner.ts:163` `assembleAgent(card?)`；`server.ts` `/api/agents`；`index.ts` | `agents.test.cjs`（注册/心跳/查询/装配收窄） |
| **P0.2** | `core/src/router/{intent,selector,router,index}.ts` | `run-queue.ts:93 submit`、`queue-backend.ts:22 JobDescriptor`、`run-queue.ts:372 execute` | `router.test.cjs`（分类/选择/显式 agentId 短路） |
| **P0.3** | `core/src/tenant.ts`、`core/src/policy/engine.ts` | `guardrails.ts:73`、`harness.ts:29`、`memory-store.ts`（复合 key 调用侧）、`runner.ts:136/163`、`server.ts` `handleRun` | `policy.test.cjs` + `tenant.test.cjs`（分区/越界） |
| **P1.1** | `core/src/workflow/{types,engine,store}.ts` | `harness.ts:14/29`（agentId/workflowId/traceId）、`server.ts` `/api/workflows` | `workflow.test.cjs`（DAG/补偿/续跑） |
| **P1.2** | `core/src/a2a/{types,transport}.ts` | `server.ts` `/api/a2a/tasks`、`client` + `openapi.ts` | a2a 端到端 smoke |
| **P1.3** | `core/src/plugin/{manifest,loader}.ts` | — | `plugin.test.cjs`（manifest→AgentCard 注册） |
| **P2** | 扩展 `plugin/`、`policy/`、`telemetry.ts` | 复用本会话 OS 沙箱 | 集成冒烟 + 配额/合规单测 |

**通用验证手段**（复用现有范式）
- 单测：`node --test test/*.test.cjs`（零依赖，require 编译后 `dist`，与 `os-sandbox.test.cjs` 同风格）。
- 编译：`tsc -p packages/core/tsconfig.json && tsc -p packages/server/tsconfig.json`（workspace 内 typescript@5.4.5）。
- 集成冒烟：`examples/` 新增 `multi-agent.ts`（注册医美/金融两个本地 agent → 经 router 分发 → 验证记忆/护栏分区）、`workflow-demo.ts`。
- 开关降级：每个新能力用 env 开关，关闭即今天行为，保证可灰度、可回滚。

---

## 5. 关键风险与依赖

1. **OS 沙箱是硬前置**：不可信跨行业 agent 必须 per-job 隔离（P2 复用本会话实现的 `backend:'os'`）。已落地，但需在 Linux 构建 helper（`pnpm --filter @agent-harness/core run build:native`）。
2. **租户模型先于多行业**：P0.3 不完成不得上线医疗/金融混合场景。
3. **序列化合规**：`JobDescriptor` / `TaskEnvelope` / `AgentCard` 必须保持纯 JSON 可序列化（当前已是），新增字段不得引入函数/类实例。
4. **性能**：Intent 分类与 Agent 选择需轻量（规则优先、结果缓存），避免每次 run 引入显著延迟；远端 A2A 调用需带 `sla.timeoutMs` 与熔断。
5. **向后兼容**：default 通用 agent + 全可选字段，确保现有 UI/CLI/测试零回归（现有 152/153 测试不应因 P0 改动而失败）。

---

## 6. 一句话落地顺序

**P0**：`AgentCard+Registry` → `TaskRouter+RunQueue 改造` → `TenantContext+PolicyEngine+记忆分区` → 复用 RunQueue 成 dispatcher；
**P1**：`Workflow DAG+跨 agent 追踪` → `A2A+TaskEnvelope` → `Plugin 骨架`；
**P2**：`插件市场+隔离加载` → `配额/计费/审计` → `行业合规画像` → `per-job OS 沙箱隔离`。
底层 70% 执行/安全/可观测代码原样复用，新增的是「agent/tenant/workflow 三个一等实体 + 调度内核」。

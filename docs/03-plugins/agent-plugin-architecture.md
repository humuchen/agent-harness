# 智能客服 Agent 插件化架构方案（非侵入式）

> 目标：在 `agent-harness` 现有 `core / server / webapp` 三层之上，把业务 Agent（如智能客服）从核心底座中剥离为**可插拔插件**，使 `core` 保持零业务耦合、可独立演进；业务插件在不修改 `core/server/webapp` 业务代码的前提下，复用既有的意图路由、记忆、工具注册、工作流、A2A 等基座能力。
> 本文仅提供**架构方案、模块划分图与接口规范**，不含实现代码。

---

## 0. 现状与核心结论

经代码核查，框架**已内置插件骨架**，本方案在其上叠加一层业务插件契约，而非另起炉灶：

| 现有基座能力 | 位置 | 本方案的复用方式 |
|---|---|---|
| `PluginManifest` / `PluginLoader` / `PluginRegistryClient` | `core/src/plugin/*` | 直接作为插件契约与加载器底座 |
| `AgentRegistry`（capability→agent 倒排索引、`query({domain,capability})`、`heartbeat`、`sweepStale`） | `core/src/agents/registry.ts` | 插件经 `enable` 把能力卡片注册进来，被 `TaskRouter` 选中 |
| `AgentCard` / `AgentAssembly`（systemPrompt / skills / mcpServers / tools） | `core/src/agents/types.ts` | 业务 Agent 的唯一声明形态 |
| `ToolRegistry`（内置 `registerCalculator(registry)` 等模式） | `core/src/tools.ts` | 插件镜像该模式注册 `search_faq` 等工具 |
| `IntentRouter` / `TaskRouter` | `core/src/router/*` | 插件贡献意图词典，路由引擎纳入 |
| `DagEngine`（WorkflowDef DAG 执行） | `core/src/workflow/*` | 插件注册会话状态机（WorkflowDef） |
| `HttpA2ATransport` / `TaskEnvelope`（A2A 协作） | `core/src/a2a/*` | 插件声明 `transport:'a2a'` 成为可协作节点 |
| `setAlertSink` / `emitAlert`（事件汇） + harness `onEvent` | `core/src` | 插件订阅 `handoff` / `run:meta` 等事件 |

**核心结论**：`core` 已提供「清单 → AgentCard → 注册表 → 路由」的通用闭环。本方案新增的是**一层业务插件契约（`PluginModule` + `PluginContext`）**与**薄薄的 server/webapp 扩展点**（业务无关），客服全部业务语义只存在于 `plugins/customer-service/`。

---

## 1. 架构边界（四层职责）

```
┌──────────────────────────────────────────────────────────────┐
│  Business Plugin 包（外置 · 仅此处含业务语义）                  │
│  AgentCard/Prompt · FAQ工具 · 会话状态机 · server路由 · web面板 │
└───────────────┬──────────────────────────┬───────────────────┘
                │ 调用扩展点（注册 API）      │ 调用扩展点（注册 UI）
                ▼                           ▼
┌─────────────────────────┐      ┌─────────────────────────────┐
│  Server 适配层（薄·无关） │      │  Webapp 适配层（薄·无关）     │
│  pluginBootstrap·server.ext│      │  PluginUIRegistry·角色门控   │
│  ctx 装配 · RBAC · SSE    │      │  registerTab/Panel·动态渲染  │
└───────────────┬───────────┘      └──────────────┬──────────────┘
                └────────────────┬─────────────────┘
                                 ▼
┌──────────────────────────────────────────────────────────────┐
│  Core 平台原语（稳定 · 零业务耦合 · 不出现任何业务词）            │
│  执行/记忆 · 能力注册 · 路由编排 · 插件基建 · 横切（事件/护栏/沙箱）│
└──────────────────────────────────────────────────────────────┘
```

| 层 | 职责 | 是否含业务语义 |
|---|---|---|
| **Core 平台原语** | harness 执行、Memory/MemoryStore、ToolRegistry、Intent/TaskRouter、AgentRegistry+A2A、WorkflowEngine、PluginLoader/Manifest/RegistryClient、事件汇、Guardrails、隔离沙箱 | **否**（通用契约 + 注册表） |
| **Server 适配层** | `pluginBootstrap()` 扫描 `plugins/` 调 loader；`server.ext` 路由挂载；把共享 `ToolRegistry/AgentRegistry/events/config` 注入 `ctx`；RBAC 动作声明；SSE 通道 | **否**（通用扩展点） |
| **Webapp 适配层** | `PluginUIRegistry`（`registerTab`/`registerPanel`）；从注册表动态渲染 Tab；角色门控 | **否**（通用扩展点） |
| **Business Plugin** | AgentCard、Prompt 策略、FAQ/订单/转人工工具、会话状态机、server 路由、web 面板 | **是**（全部业务在此） |

**边界红线**：`core/server/webapp` 三层的源码中**不得出现**「客服 / 退款 / FAQ / 转人工」等业务词；这些词只存在于插件包。三层只演进「通用扩展点」。

> **`packages/` 与 `plugins/` 的目录边界（补充说明）**：`plugins/` 放**业务插件**（含 `PluginManifest` + 业务装配 `PluginModule`，如 `medical-aesthetics-lead`）；`packages/` 放**可复用库**，包括跨插件共用的领域合规库。`backend/medical-ad-guard`（`@agent-harness/medical-ad-guard`）即属后者——它**不含 PluginManifest / AgentCard / 业务工作流**，只把医疗广告法违规模式注册进 core 的通用 `guardrails`，供客服/客资插件复用，因此按「可复用领域库」置于 `packages/`，**不违反**上述红线（core 中仅注释提及，无实际 import）。业务语义仍 100% 落在插件包内。

---

## 2. 插件接口契约

插件 = 一份 JSON 清单（`PluginManifest`，已存在、可序列化） + 一个 `entry` 导出的 `PluginModule`（业务装配逻辑）。

### 2.1 PluginContext（底座能力的注入面）[设计契约]

```ts
interface PluginContext {
  config: PluginConfig;                       // 注入的配置（env / file / secret）
  agentRegistry: AgentRegistry;              // register(card) → 进入路由候选
  tools: ToolRegistry;                       // register(name, schema, fn)
  router: RouterContribution;               // contributeIntent({domain, keywords, examples})
  workflow: WorkflowContribution;           // register(def: WorkflowDef)
  a2a: A2AContribution;                     // collaborate(remoteAgentId) / declareEndpoint
  events: PluginEventBus;                   // on('handoff'|'run:meta'|'tool'|'alert', h)
  server: ServerExtension;                  // route(method, path, handler, {role?})
  web: WebExtension;                        // registerTab({id,label,role,render})
  logger: PluginLogger;
}
```

### 2.2 PluginModule（插件生命周期钩子）[设计契约]

```ts
interface PluginModule {
  manifest: PluginManifest;
  // 注册发现（一次性声明）：注册 agent/tools/intent/workflow/routes/panels
  setup(ctx: PluginContext): void | Promise<void>;
  onStart?(ctx: PluginContext): void | Promise<void>;   // 启动（连外部系统）
  onStop?(ctx: PluginContext): void | Promise<void>;    // 停止（断开/释放）
  onUnload?(ctx: PluginContext): void | Promise<void>;  // 卸载（清理注册）
}
```

### 2.3 生命周期映射（对齐现有 PluginLoader 状态机）

| 状态 / 钩子 | 现有机制 | 本方案动作 |
|---|---|---|
| `install` | `loader.install()` 解析 `dependencies` | 登记为 `disabled`，不暴露给路由 |
| `enable` | `loader.enable()` 调 `sandbox` 钩子 → `toAgentCard` 注册 | 调 `module.setup(ctx)`（插件在此注册全部能力）；manifest.capabilities 同步成 AgentCard |
| `onStart` | —（新增钩子） | 业务启动（如预热 FAQ 索引、建外部连接） |
| `disable` | `loader.disable()` 从 Registry 注销 | 从路由候选移除；`onStop` 清理 |
| `upgrade` | `loader.upgrade()` 替换 manifest 并重注册 | 按原启用态热替换 |
| `unload` | —（新增钩子） | `onUnload` 反注册 routes/panels，释放资源 |

> `sandbox` 钩子（loader 已预留）在 `enable` 前调用，是真实 OS/容器隔离的加载点；`isolation` 级别（`none/local/os/container`）经 `resolveIsolationBackend` 收敛。

### 2.4 事件订阅契约 [设计契约]

```ts
type PluginEvent =
  | { type: 'run:meta'; intent?: string; agentId: string; decidedBy: string }
  | { type: 'handoff'; sessionId: string; reason: string }
  | { type: 'tool'; tool: string; args: unknown }
  | { type: 'alert'; level: 'info'|'warn'|'error'; message: string };
interface PluginEventBus { on(type: PluginEvent['type'], h: (e: any) => void): () => void; }
```
底座实现：`events` 是 core `setAlertSink/emitAlert` + harness `onEvent` 之上的一层统一门面，插件无需感知底层。

---

## 3. 底座能力复用（不修改 core）

所有复用都走 **core 已导出的公共注册 API**，插件只「调用」，不「改源码」：

- **意图路由（Intent Router）**：插件 `ctx.router.contributeIntent({ domain:'cs', keywords:['退款','退货','订单','物流','故障'], examples:[...] })`；`TaskRouter.resolve()` 在决策时纳入贡献词典，命中后选中 `cs-*` AgentCard。core 的 `DOMAIN_KEYWORDS` 机制升级为「可贡献式」注册表（仍是通用结构，不含业务词）。
- **记忆存储（Memory）**：插件 Agent 通过 `assembly` 或 harness `getSessionMemory(sessionKey)` 使用多轮窗口；与既有客服设计完全一致，**零改动**。
- **工具注册（ToolRegistry）**：`ctx.tools.register('search_faq', '检索FAQ…', {type:'object', properties:{query, topK}}, fn)`；命名含 `search` → 前端自动绿色检索卡片（复用 `RETRIEVAL_RE`/`isRetrievalTool`）。
- **工作流引擎（Workflow Engine）**：`ctx.workflow.register(def)` 提交 `WorkflowDef` 给 `DagEngine`/`WorkflowStore`；会话状态机 = 一个 `WorkflowDef`（退款/订单/技术分支 + 转人工补偿）。
- **A2A 协作**：插件 manifest `transport:'a2a', endpoint` 或 `ctx.a2a.collaborate(remoteAgentId)`，使其成为可被其它 agent 派发的协作者；`HttpA2ATransport` 负责跨主机投递。
- **统一发现**：上述能力最终都收敛为 `AgentCard.capabilities`，被 `AgentRegistry.query({capability})` 发现、被 `TaskRouter` 选中，**与核心 agent 走完全相同代码路径**（演进而非重写）。

---

## 4. 插件加载机制

### 4.1 目录规范

```
plugins/
  customer-service/
    manifest.json            # PluginManifest（id/version/capabilities/dependencies…）
    index.ts                 # export const module: PluginModule
    prompts/                 # AgentCard 装配（systemPrompt + assembly）
    tools/                   # search_faq / lookup_order / transfer_to_human
    workflows/               # cs-conversation.fsm.ts（WorkflowDef）
    server/                  # routes.ts（stats/feedback/handoffs）
    web/                     # admin.ts（ah-cs-admin 面板 + registerTab）
```
monorepo 亦可放 `packages/plugin-customer-service/`，由 workspace 软链到 `plugins/`。

### 4.2 静态声明式注册（启动期）

`server` 启动早期 `pluginBootstrap()` 扫描 `plugins/*/manifest.json` → `loader.install` → 若 `manifest.enabled` 或 env `PLUGINS_AUTO_ENABLE` 命中则 `enable` → 调 `module.setup(ctx)`。**零额外配置即可加载**。

### 4.3 动态热插拔（运行期）

`shell` 经 `POST /api/plugins/:id/enable|disable|upgrade` 调 loader，无需重启；SSE 推送插件状态变更。
安全语义：`disable` 即从 `AgentRegistry` 注销、移出路由候选，新会话不再命中；进行中会话跑完即退出，无中断。

### 4.4 依赖解析与版本隔离

- **依赖解析**：复用 `loader.resolveDependencies`（依赖须已 `install`）；新增 `peerDependencies.core`（插件声明兼容的 core 主版本）。
- **版本策略**：`PluginRegistryClient.resolveVersion` 已支持 `latest` / `^x.y.z` / 精确匹配；远端市场拉取带 `verifyManifest` 签名校验。
- **隔离级别**：`manifest.isolation`（`none/local/os/container`）+ `sandbox` 钩子做真实隔离；跨插件 API 漂移通过 `ctx` 版本化约束（core 主版本升 → 插件需升 `peerDependencies.core`）。
- **不可信远端**：声明 `transport:'a2a'` 且非本地插件，强制 `isolation:'container'` + 签名校验。

---

## 5. 实例化：智能客服插件拆解

`plugins/customer-service/` 的模块构成与接入映射：

| 插件内模块 | 内容 | 接入的扩展点（不修改 core） |
|---|---|---|
| `manifest.json` | id `customer-service`、version、`capabilities:['cs-refund','cs-order','cs-tech']`、`domain:'cs'`、`dependencies:['core']` | `PluginLoader` |
| `prompts/` | 4 张 AgentCard：`cs-orchestrator` + `cs-refund/order/tech`，`assembly.systemPrompt` 收窄 | `ctx.agentRegistry.register(card)` |
| `tools/search_faq.ts` | FAQ 检索（命名含 `search` → 绿色卡片） | `ctx.tools.register('search_faq', …)` |
| `tools/lookup_order.ts` `tools/transfer_to_human.ts` | 订单查询 / 转人工 | `ctx.tools.register(…)` |
| `workflows/cs-conversation.fsm.ts` | 「意图→处理→转人工」状态机 | `ctx.workflow.register(def)` |
| `server/routes.ts` | `GET /api/cs/stats`、`POST /api/chat/sessions/:id/feedback`、`GET/POST /api/cs/handoffs`；`events.on('handoff', …)` 写 HandoffQueue | `ctx.server.route(…)` + `ctx.events` |
| `web/admin.ts` | `ah-cs-admin` 面板（会话列表/详情/满意度/统计）+ Tab | `ctx.web.registerTab({id:'cs-admin', role:'cs:admin', render})` |

**结果**：客服业务的全部语义（Prompt、FAQ、状态机、路由、面板）100% 在 `plugins/customer-service/`；`core/server/webapp` 仅提供通用扩展点，**源码中无「客服/退款/FAQ」字样**。

---

## 6. 对现有三层的改动清单（最小化、业务无关）

| 层 | 改动 | 业务耦合 |
|---|---|---|
| **core** | 扩展 `plugin/`：新增 `PluginContext`/`PluginModule` 契约与 `RouterContribution`/`WorkflowContribution`/`ServerExtension`/`WebExtension`/`PluginEventBus` 接口及对应注册器 | **否**（仍通用） |
| **server** | 新增 `pluginBootstrap()`（扫描+enable）、`registerServerExtension()`、把共享 `ToolRegistry/AgentRegistry/events/config` 注入 `ctx`、`/api/plugins/*` 管理接口 | **否**（通用扩展点） |
| **webapp** | 新增 `PluginUIRegistry`（`registerTab`/`registerPanel`）+ `app.ts` 从注册表渲染 Tab + 角色门控 | **否**（通用扩展点） |
| **customer-service** | 整个 `plugins/customer-service/` 包 | **是**（全部业务） |

---

## 7. 收益与风险

**收益**
- `core` 稳定、可独立发版演进；业务按需插拔、互不污染。
- 多租户 / 多行业 Agent 并存（医疗、金融、客服同一底座）。
- 热更新不影响核心；远端不可信 Agent 经 A2A + 容器隔离托管。

**风险与对策**
- 一次性基建成本（bootstrap / 注册器 / 事件门面）——均通用、可复用，非业务债。
- 插件间 API 漂移 → `peerDependencies.core` + semver + `ctx` 版本化。
- 隔离强度依赖 `sandbox` 钩子落地（P2 真实 OS/容器加载），骨架层先用 `none/local` 兜底。
- 多副本会话一致性：插件复用 `ChatSession`/`Memory` 的共享后端（sqlite/redis），见既有部署方案。

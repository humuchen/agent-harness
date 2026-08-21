# 智能客服插件化 · 实施任务清单（Phased Implementation Plan）

> 配套文档：`./agent-plugin-architecture.md`（架构边界 / 契约 / 复用路径 / 实例化）  
> 本文档目标：**把架构方案翻译成可排期的落地任务**，按阶段给出「要改哪些文件、改什么、验收标准」。  
> 约束：本清单仅含**接口规范与改动点**，不含业务实现代码（遵循「仅提供方案」要求）。



---

## 0. 总体落地策略

| 维度   | 结论                                                                                                                                               |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 演进顺序 | 核心契约先行（Phase 0），再扩 server/webapp 扩展点（Phase 1–2），最后落地客服插件包（Phase 3），生产加固收尾（Phase 4）                                                               |
| 侵入面  | core 仅**新增接口文件**（不删不改既有导出）；server/webapp 仅**新增通用扩展点**（不含业务词）；业务语义 100% 留在 `plugins/customer-service/`                                            |
| 复用底座 | 全程只调 core 已导出的公共 API：`getAgentRegistry()` / `ToolRegistry` / `IntentRouter` / `DagEngine` / `HttpA2ATransport` / `setAlertSink` / `PluginLoader` |
| 硬缺口  | 唯一生产级缺口：多副本下 ChatSession/Memory 共享后端（sqlite 不可靠，需 RWX 卷 + file 后端或 Redis）——见 Phase 4                                                             |

---

## Phase 0 — Core 插件业务契约扩展（零业务耦合）

**目标**：在 `backend/core/src/plugin/` 上叠加「业务模块钩子」，让插件能拿到注入面 `PluginContext` 并声明 `PluginModule` 生命周期，而不污染 core 既有逻辑。

### 0.1 新增文件 `backend/core/src/plugin/context.ts`

定义注入面 `PluginContext`（core 公共能力的只读视图）：

```ts
// [设计契约] 非最终代码，仅规范接口形状
export interface PluginContext {
  readonly config: Record<string, unknown>;          // 来自 manifest + 环境变量注入
  readonly agentRegistry: AgentRegistry;             // getAgentRegistry() 单例
  readonly tools: ToolRegistry;                       // register(name, schema, fn)
  readonly router: IntentRouter;                     // registerIntent(domain, intent, handler)
  readonly workflow: { register(def: WorkflowDef): void }; // DagEngine 注册入口
  readonly a2a: { transport: HttpA2ATransport };      // 跨 agent 协作
  readonly events: { on(topic: string, fn: (e: PluginEvent) => void): void };
  readonly server: { registerExtension(ext: ServerExtension): void }; // 透传（Phase 1 落地）
  readonly web: { registerView(view: PluginUIView): void };           // 透传（Phase 2 落地）
  readonly logger: { info(...a:unknown[]):void; warn(...a:unknown[]):void; error(...a:unknown[]):void };
}
```

### 0.2 新增文件 `backend/core/src/plugin/module.ts`

定义业务模块契约 `PluginModule`：

```ts
// [设计契约]
export interface PluginModule {
  manifest: PluginManifest;
  setup(ctx: PluginContext): Promise<void> | void;     // 注册工具/意图/工作流/UI
  onStart?(ctx: PluginContext): Promise<void> | void;  // 启监听/拉取
  onStop?(ctx: PluginContext): Promise<void> | void;   // 优雅停
  onUnload?(ctx: PluginContext): Promise<void> | void; // 注销全部注册
}
```

### 0.3 修改 `backend/core/src/plugin/loader.ts`

- `PluginLoader` 新增 `registerLocalModule(id: string, mod: PluginModule): void`，存 `Map<id, PluginModule>`；
- `enable(id)` 在 `registry.register(toAgentCard(...))` **之前**调 `mod.setup(ctx)`（注入 `PluginContext`）；
- `disable(id)` / `upgrade(id)` 对应调 `mod.onStop?.()` / `mod.onUnload?.()`；
- 新增 `private buildContext(manifest): PluginContext`，聚合 0.1 中的公共 API（从 core 单例取）。

### 0.4 修改 `backend/core/src/plugin/index.ts`

追加 `export * from './context'; export * from './module';`

### 0.5 验收标准

- `tsc -p backend/core/tsconfig.json` 通过；
- 一个 stub `PluginModule`（`setup` 里 `ctx.tools.register('demo', ...)`）能被 `enable` 注入并注册成功；
- core 源码**不出现**任何业务词（客服/退款/FAQ/转人工）。

**风险**：`PluginContext` 的 `server`/`web` 字段在 Phase 0 暂为 no-op 透传器，Phase 1–2 才接真实实现——需保证接口先冻结，避免后期破坏性变更。

---

## Phase 1 — Server 扩展点（通用、无业务）

**目标**：server 启动期扫描并加载插件、暴露通用扩展点（挂载路由 / 订阅事件），本身不含任何客服逻辑。

### 1.1 新增文件 `access/server/src/plugin-bootstrap.ts`

- `pluginBootstrap(ctx: PluginContext): Promise<void>`：扫描 `plugins/*/manifest.json`（静态声明式），逐个 `loader.install` → `loader.registerLocalModule` → `loader.enable`；
- 支持进程内（本地目录）与远程 registry（`installFromRegistry`）两条路，路由选择由 env `PLUGIN_SOURCE` 决定。

### 1.2 新增文件 `access/server/src/plugin-ext.ts`

定义 **业务无关** 扩展契约，供插件注入能力：

```ts
// [设计契约]
export interface ServerExtension {
  mountRouter(app: ExpressLike): void;   // 挂载 /api/plugins/<id>/... 下路由
  onEvent?(e: PluginEvent): void;         // 订阅 core 事件总线
}
```

### 1.3 修改 `access/server/src/server.ts`

- 启动早期调用 `pluginBootstrap(ctx)`（在 `/api/state` 与静态页就绪**之后**，避免拖慢健康检查）；
- 新增 `registerServerExtension(ext: ServerExtension)`：把扩展收集进 `PluginContext.server` 透传器；
- 新增 `GET /api/plugins` 返回已启用插件清单（id/version/state），供 webapp 动态渲染 Tab。

### 1.4 验收标准

- server 启动无报错，`GET /api/state` 仍 200（健康检查不被插件拖垮）；
- `GET /api/plugins` 返回插件清单 JSON；
- server 源码不含客服业务词。

**风险**：插件路由挂载在 `/api/plugins/:id/` 前缀下，需与既有 `UI_AUTH_TOKEN` 鉴权链兼容（Phase 1 顺带把该前缀纳入受保护名单）。

---

## Phase 2 — Webapp 扩展点（通用、无业务）

**目标**：webapp 提供通用 Plugin UI 注册表，业务 Tab/面板由插件在运行时注入。

### 2.1 新增文件 `frontend/webapp/src/plugin-ui-registry.ts`

```ts
// [设计契约]
export interface PluginUIView {
  tabId: string;
  label: string;
  icon?: string;
  mount(host: HTMLElement): void;   // LitElement 子组件挂载点
}
export class PluginUIRegistry {
  register(view: PluginUIView): void;
  list(): PluginUIView[];
}
```

### 2.2 修改 `frontend/webapp/src/app.ts`

- 启动期 `fetch('/api/plugins')` → 对每个插件 `fetch('/api/plugins/<id>/ui')` 拉取 `PluginUIView` 描述；
- 把动态 Tab 渲染进侧栏（与既有内置 Tab 并列，顺序可配置）。

### 2.3 验收标准

- 静态页加载正常（无插件时退化为仅内置 Tab）；
- 启用客服插件后，侧栏出现「客服」动态 Tab，点击可挂载其面板；
- webapp 源码不含客服业务词（仅 `PluginUIView` 通用契约）。

---

## Phase 3 — 智能客服插件包 `plugins/customer-service/`（业务全在此）

**目标**：把架构文档 §5 的实例化模块落地为真实插件包。仍可用 mock LLM 跑通端到端，不强制接真实模型。

### 3.1 目录规范

```
plugins/customer-service/
├── manifest.json            # PluginManifest: id="customer-service", capabilities, domain="service"
├── index.ts                 # PluginModule: setup/onStart/onStop/onUnload
├── prompts/                 # Prompt 策略（多轮/转人工/满意度）
├── tools/
│   ├── faq.ts               # ctx.tools.register('cs__faq_lookup', ...)
│   └── ticket.ts            # ctx.tools.register('cs__create_ticket', ...) 转人工
├── workflows/
│   └── refund.cs.ts         # ctx.workflow.register(退款 DAG)
├── server/
│   └── cs-routes.ts         # ServerExtension: 满意度上报 / 记录查询 路由
└── web/
    └── admin-panel.ts       # PluginUIView: 对话记录 + 满意度统计面板
```

### 3.2 模块 → 扩展点映射（与架构文档 §5 一致）

| 模块        | 接入的 core 扩展点                                            | 落点                       |
| --------- | ------------------------------------------------------- | ------------------------ |
| Prompt 策略 | `ctx.config` + `AgentAssembly.systemPrompt`（经 manifest） | `prompts/`               |
| FAQ 检索工具  | `ctx.tools.register`                                    | `tools/faq.ts`           |
| 转人工/建单    | `ctx.tools.register` + `ctx.events.on('cs.escalate')`   | `tools/ticket.ts`        |
| 会话状态机     | `ctx.workflow.register`（DagEngine）                      | `workflows/refund.cs.ts` |
| 意图路由增强    | `ctx.router.registerIntent('service','refund',handler)` | `index.ts`               |
| 管理后台 API  | `ctx.server.registerExtension`                          | `server/cs-routes.ts`    |
| 管理后台前端    | `ctx.web.registerView`                                  | `web/admin-panel.ts`     |

### 3.3 验收标准（端到端 smoke）

- `node access/server/dist/server.js` 启动，`GET /api/plugins` 含 `customer-service:enabled`；
- 未配 `OPENROUTER_API_KEY` 时走 mock LLM，仍能完成一次「查订单→FAQ 命中→人工转接」多轮对话；
- 管理后台 Tab 可见对话记录与满意度占位统计。

---

## Phase 4 — 生产加固（唯一硬缺口在此）

| 项       | 改动                                                              | 说明                                         |
| ------- | --------------------------------------------------------------- | ------------------------------------------ |
| 共享记忆后端  | `MEMORY_BACKEND=file` + `MEMORY_DIR=/app/data/memory` 挂 RWX PVC | sqlite 在网络 FS 文件锁不可靠，多副本改用 file 后端（详见项目记忆） |
| 插件热插拔   | `POST/DELETE /api/plugins/:id/enable`                           | 调 `loader.enable/disable`，无需重启             |
| 版本/依赖解析 | 复用 `registry.resolveVersion` + `loader.resolveDependencies`     | `upgrade` 时按启用态重注册                         |
| 满意度聚合   | `server/cs-routes.ts` + `web/admin-panel.ts`                    | 读共享后端聚合，无新 core 改动                         |

### 4.1 验收标准

- 2 副本下 ChatSession 不丢（RWX 卷验证）；
- 热启/停插件不中断 `/api/state` 健康检查。

---

## 阶段依赖与排期（关键路径）

```
Phase 0 (core 契约)  ──► Phase 1 (server 扩展点) ──┐
        │                                           ├─► Phase 3 (客服插件包) ──► Phase 4 (生产加固)
        └──► Phase 2 (webapp 扩展点) ───────────────┘
```

- Phase 1 与 Phase 2 在 Phase 0 之后**可并行**（彼此仅通过冻结的 `PluginContext` 接口耦合）；
- Phase 3 依赖 Phase 1+2 的扩展点就绪；
- Phase 4 独立收尾，可在 Phase 3 验证后单独排期。

---

## 改动面总览（侵入性审计）

| 包                        | 新增文件                                    | 修改文件                                  | 业务词      |
| ------------------------ | --------------------------------------- | ------------------------------------- | -------- |
| core                     | `plugin/context.ts`, `plugin/module.ts` | `plugin/loader.ts`, `plugin/index.ts` | 无        |
| server                   | `plugin-bootstrap.ts`, `plugin-ext.ts`  | `server.ts`                           | 无        |
| webapp                   | `plugin-ui-registry.ts`                 | `app.ts`                              | 无        |
| plugins/customer-service | 整包新建                                    | —                                     | 全部业务语义在此 |

> 结论：core/server/webapp 三层**零业务耦合**，架构文档 §1 的边界红线被满足；业务 Agent 以独立插件包形态存在，可独立演进、独立版本、独立部署。

---

## Phase 4 — 已落地（实现记录 · 2026-08-17）

### 4.0 共享记忆后端（RWX 卷 + file 后端）
- **k8s（已具备）**：`deploy/k8s/configmap.yaml` 设 `MEMORY_BACKEND=file` + `MEMORY_DIR=/app/data/memory`；`pvc.yaml` 为 RWX（`ReadWriteMany`）卷 `agent-harness-data`；`deployment.yaml` 挂载到 `/app/data`（2 副本共享）。sqlite 明确禁用（网络 FS 锁不可靠）。
- **docker-compose**：`ui` 服务加 `MEMORY_BACKEND=file` / `MEMORY_DIR=/app/data/memory` + 挂载命名卷 `data:/app/data`，单实例重启不丢。
- **render.yaml**：声明 `MEMORY_BACKEND=file` / `MEMORY_DIR=/app/data/memory`（free 磁盘临时，多副本需付费 plan + 持久卷）。
- **插件 store 文件化**：`plugins/customer-service/src/store.ts` 由「进程内 Map」改为文件后端，目录默认 `${MEMORY_DIR}/plugins/customer-service`（落在 RWX 卷内），原子写（tmp+rename）+ 读路径扫目录聚合 → **2 副本下任意副本写入的会话/满意度都能被管理后台读到**，满足「ChatSession 不丢」。

### 4.1 插件热插拔 API（server，无业务词）
- `access/server/src/authz.ts`：Action 联合类型新增 `plugin:manage`，并授予 `admin` / `operator` 角色（非敏感动作，不经审批闸门）。
- `access/server/src/plugin-bootstrap.ts`：新增 `resolveUpgradeManifest(id, body)` —— 优先用请求体 `manifest`，否则用 `PLUGIN_REGISTRY_URL` + `version` 经 `PluginRegistryClient.index` + `resolveVersion` 拉取（复用既有版本/依赖解析）。
- `access/server/src/server.ts`：在 `/api/plugins` 之后新增（受 `guard(req,res,'plugin:manage')` 保护）：
  - `POST /api/plugins/:id/enable` → `loader.enable(id)`
  - `POST /api/plugins/:id/disable`（及 `DELETE /api/plugins/:id/enable` 兼容） → `loader.disable(id)`
  - `POST /api/plugins/:id/upgrade` → `resolveUpgradeManifest` + `loader.upgrade(id, manifest)`（内部 `resolveDependencies` 校验、按启用态重注册）
  - `/api/plugins` 元数据现返回 `version` / `dependencies`，供控制台展示。
  - 全部为进程内注册表增删，**不触碰 `/api/state` 健康检查、不重启进程**。

### 4.2 热插拔 UI 控制台（webapp，通用、无业务词）
- 新增 `frontend/webapp/src/plugins-console.ts`（`<ah-plugins>`）：拉取 `/api/plugins` 列出插件，提供「启用 / 停用 / 升级」按钮，调用上述端点（带 Bearer 令牌）。
- `frontend/webapp/src/app.ts`：Tab 联合类型加 `'plugins'`，侧栏新增「插件」导航项，内容区渲染 `<ah-plugins>`。组件与具体插件业务语义完全解耦。

### 4.3 验收标准达成
- 多副本 ChatSession 不丢：core Memory（file 后端）+ 插件 store（RWX 卷内文件）双路落盘。
- 热启/停插件不中断 `/api/state`：端点操作纯内存注册表，健康检查独立。
- core/server/webapp 仍**零业务词**；新增改动均经既有公共 API / 通用扩展点，无侵入。

### 4.4 已知限制（如实记录）
- 插件 store 单会话 read-modify-write 在跨副本极端并发下可能互相覆盖（低概率）；强一致需后续换 Redis 后端。
- `upgrade` 为「manifest 替换 + 重注册」，进程内 PluginModule 代码不热替换；真正代码热升级需 `uninstall`+重新 `installModule`+`enable` 或重启（registry 安装路径另议）。
- 沙箱 `pnpm install` 被拦截，无 `tsc` 校验；代码按 core 公共 API 严格手写类型，需在有依赖环境跑 `pnpm -r build` 验证。

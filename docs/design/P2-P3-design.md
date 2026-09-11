# P2 / P3 设计方案（企业级 Agent 平台补齐路线图）

> 本文档对应路线图中的 **P2（增强）** 与 **P3（品牌）** 阶段。
> 路线图要求：**P0、P1 优先实施，结束后 P2、P3 给出设计方案**（不立即实现）。
> 因此本文档为**设计规格**，不含实现代码；各条目均给出目标、现状、架构、关键接口、实施阶段与风险，供后续落地评审。

## 0. 统一架构约定（所有 P2/P3 条目共同遵循）

为保证与 P0/P1 已交付能力一致、避免架构漂移，后续实现必须复用既有铁律：

1. **分层零耦合**：框架原语留在 `core`；业务能力落 `access/server`，以「**接口 + 默认实现 + 组合工厂**」形式存在（参考 `org.ts` / `artifact-store.ts` / `data-source.ts`）。
2. **路由与鉴权**：新增 HTTP 端点必须在 `server.ts` 的请求分发链中注册，并用 `guard(req, res, '<action>')` 保护；权限先在 `authz.ts` 的 `Action` 联合类型与 `DEFAULT_MATRIX` 中声明。
3. **前端组件**：每个能力一个 LitElement 自定义元素（`ah-*`），通过 `authedFetch`（`./api`）消费受保护端点；在 `main.ts` 注册、在 `app.ts` 的 `Tab` 联合类型 + `TABS` 数组 + 渲染区挂载；webapp **不得** `import` server 内部类型（类型在 webapp 侧桥接，参考 `org-types.ts`）。
4. **可测试性**：后端默认实现以「文件 / 内存 / 外部只读」为底座，暴露 `getXxx()` / `setXxx()` 工厂供单测注入；CJS 单测走 `node --test test/*.test.cjs`（需先 `pnpm --filter @agent-harness/server run build` 产 `dist/`）。

---

## 1. P2-1 桌面端（Desktop Client）

### 目标
为「对话 / 工作台 / 审计 / 组织」等控制台提供原生桌面外壳，获得：系统托盘常驻、原生通知、离线缓存、Deep Link 唤起、文件拖拽上传归档到「成果物档案库」（P1-5）。

### 现状
当前仅 `vite` 构建的纯 Web SPA（`frontend/webapp`），无原生外壳；所有能力已可在浏览器使用。

### 设计方案
- **技术选型**：采用 **Tauri 2.x**（Rust + WebView）而非 Electron——包体更小、原生能力通过 Rust 命令暴露，契合本项目「最小依赖、安全优先」基调；若团队更熟 Electron 亦可，但需评估体积与供应链风险。
- **架构**：
  - `desktop/` 新 workspace：`src-tauri/`（Rust 命令：`notify`、`open_file`、`save_dialog`、`watch_dir`）+ `webview/`（复用 `frontend/webapp` 构建产物）。
  - Tauri 命令以 **接口 + 默认实现** 形式存在，便于单测（Rust 侧用 `cargo test`）。
- **与既有能力联动**：
  - 文件拖拽 → 调用 P1-5 `POST /api/artifacts`（base64 内容）完成落盘归档。
  - 原生通知 → 订阅 P1-2 审计事件 / IM 回调（P0-2）做系统级提醒。
  - 离线缓存 → Service Worker + Tauri 本地静态资源，弱网可用「只读」视图。

### 关键接口 / 文件（建议）
- `desktop/src-tauri/src/commands.rs`：`notify(title, body)` / `save_artifact(path)` / `pick_file()`。
- `desktop/tauri.conf.json`：窗口尺寸、托盘、Deep Link scheme（如 `piagent://`）。
- 复用：`frontend/webapp/dist`（构建产物直接被 Tauri 加载）。

### 实施阶段
1. Tauri 脚手架 + 加载既有 webapp；2. 系统托盘与通知命令；3. 文件拖拽→档案库；4. 离线缓存与自动更新。

### 风险 / 开放问题
- Windows/macOS/Linux 三端签名与公证成本；需明确目标平台优先级。
- Tauri WebView 版本差异对 Lit 组件兼容性需验证。

---

## 2. P2-2 策略编辑器（Policy Editor）

### 目标
在控制台内可视化编辑 **RBAC 角色-权限矩阵** 与 **策略文件**（如 `UI_ROLE_PERMISSIONS`、策略 JSON），实时校验并预览「某角色对某动作是否放行」，降低误配导致越权/锁死的风险。

### 现状
`authz.ts` 已有 `Action` 联合类型 + `DEFAULT_MATRIX` + `UI_ROLE_PERMISSIONS` 覆盖机制；但配置只能通过改环境变量 / 手写 JSON，无 UI 校验。

### 设计方案
- **后端**（落 `access/server/src/policy-editor.ts`）：
  - `interface PolicyStore { read(): Promise<PolicyDoc>; write(doc: PolicyDoc): Promise<void>; preview(role: Role, action: Action): Promise<boolean> }`。
  - 默认实现 `FilePolicyStore`：读写 `.data/policy.json`（含 `matrix` 与 `UI_ROLE_PERMISSIONS` 等价结构）；`preview` 复用现有 `Authorizer.can()` 逻辑。
  - 新端点：`GET /api/policy`（返回当前矩阵 + 全部 `Action` 清单）、`POST /api/policy`（校验后写入）、`GET /api/policy/preview?role=&action=`。
  - 新 `Action`：`policy:read` / `policy:write`（归入 `admin`/`operator`）。
- **前端**（`<ah-policy-editor>`，新增 Tab「策略」）：
  - 角色 × 动作 矩阵表格，单元格为开关；动作按模块分组（agent / mcp / workspace / audit / org / artifact / skill / datasource / sandbox / supplychain …）。
  - 编辑态「预览」面板：输入 `(role, action)` 即时显示放行/拒绝及命中规则来源。
  - 保存前进行 JSON Schema 校验（动作名必须 ∈ `Action` 联合类型，角色 ∈ `admin|operator|viewer`）。

### 关键接口 / 文件
- `access/server/src/policy-editor.ts`：`PolicyStore` / `FilePolicyStore` / `getPolicyStore()`。
- `access/server/src/authz.ts`：导出 `Action` 全量清单（已有）供 UI 渲染。
- `frontend/webapp/src/policy-editor.ts`：`<ah-policy-editor>`。

### 实施阶段
1. 后端 `PolicyStore` + 读取端点；2. 前端矩阵渲染；3. 预览与校验；4. 写入端点 + 审计留痕（写策略走 P1-2 审计）。

### 风险 / 开放问题
- 写错策略可能把自己锁在门外 → 必须有「写后 5 分钟可一键回滚」或「只允许扩权、缩权需二次确认」的护栏。
- `UI_ROLE_PERMISSIONS` 现有为单行 JSON 环境变量，需平滑迁移到文件态。

---

## 3. P2-3 Plan / 工作流协同显化（Plan & Workflow Collaboration）

### 目标
将「Plan 模式产物」（计划书 / 步骤树）与「工作流 DAG」以可视化、可多人协同的方式显化：实时光标、节点评论、版本 diff，便于人类在关键节点审批（呼应 P0 `approvals`）。

### 现状
`workflow-executor.ts` 已存在工作流执行；`audit` / `approvals` 机制就绪；但 Plan 产物缺少可视化，多人在同一计划上无协同视图。

### 设计方案
- **数据模型**（新增 `plan.ts`）：
  - `interface PlanNode { id; title; status: 'todo'|'doing'|'done'|'blocked'; assignee?; dependsOn: string[]; note? }`。
  - `interface PlanDoc { id; title; nodes: PlanNode[]; version; updatedBy; updatedAt }`。
  - `interface PlanStore { read(id): Promise<PlanDoc|null>; save(doc): Promise<void>; diff(aId,bId): Promise<PlanDiff> }`（默认 `FilePlanStore`，`.data/plans/`）。
- **协同传输**：复用既有 **SSE** 通道（`startSse` / `subscribeChatEvents` 同族）新增 `subscribePlanEvents(planId)`；前端用 `EventSource` 接收他人编辑 → 乐观更新 + 冲突以「最后写入 + 版本号」解决（MVP 不做 CRDT）。
- **端点**：`GET/POST /api/plans/:id`、`GET /api/plans/:id/diff?other=`、`GET /api/plans/:id/events`（SSE）。
- **前端**（`<ah-plan-board>`，Tab「计划」）：可拖拽节点卡片泳道、依赖连线、评论气泡、版本切换 diff 视图；审批动作复用 `POST /api/approvals`。

### 关键接口 / 文件
- `access/server/src/plan.ts`：`PlanStore` / `FilePlanStore` / `getPlanStore()`。
- 复用：`chat-bus.ts` 的 SSE 订阅范式；`run-queue.ts` 的 `unref` 定时器约定（后台心跳）。

### 实施阶段
1. Plan 数据模型 + 读写端点；2. 看板前端（无协同）；3. SSE 协同 + 光标/评论；4. 版本 diff + 审批联动。

### 风险 / 开放问题
- 实时协同一致性：MVP 采用乐观更新 + 版本号，是否需升级 CRDT（如 Yjs）待评估。
- 大计划（数百节点）的前端渲染性能需虚拟化。

---

## 4. P2-4 K8s ServiceMonitor（可观测性增强）

### 目标
为 Agent 平台各服务生成 **Prometheus `ServiceMonitor` CRD** 与抓取配置，使部署在 K8s 上的实例能被 Prometheus 自动发现并抓取指标（呼应 P1-1 可观测端点 `/metrics`）。

### 现状
`observability` 端点、`metrics:read` 权限已就绪；但缺少 K8s 原生接入描述。

### 设计方案
- **产出物（代码生成，非运行时依赖）**：
  - `deploy/` 下新增 `servicemonitor.yaml` 模板：每个服务一个 `ServiceMonitor`，`selector` 匹配服务 `Service` 标签，`endpoints` 指向 `/metrics`、拉取间隔 15s、配 `tlsConfig`（若启用 mTLS）。
  - 生成脚本 `scripts/gen-servicemonitor.mjs`：读取 `package.json` / `docker-compose*.yml` 的服务清单，渲染模板，落到 `deploy/monitoring/`。
- **校验**：`kubeconform` / `kubectl apply --dry-run=client` 校验产出合法性（CI 中跑，呼应 P1-8 供应链）。
- **配套**：Grafana dashboard JSON（`docs/02-deployment` 引用），面板映射 `jobs:read` / `errors:read` 类指标。

### 关键接口 / 文件
- `deploy/servicemonitor.yaml`（模板）、`scripts/gen-servicemonitor.mjs`。
- 复用：既有 `docker-compose.monitoring.yml` 的 Prometheus 栈。

### 实施阶段
1. 服务清单提取；2. ServiceMonitor 模板 + 生成脚本；3. Grafana 面板；4. CI 校验。

### 风险 / 开放问题
- 多实例（HPA）下 `ServiceMonitor` 仅描述发现规则，重复实例去重由 Prometheus 负责；需确认指标带 `instance`/`pod` 标签。
- 非 K8s 部署（裸机 / docker-compose）不消费此产物，需文档说明适用范围。

---

## 5. P2-5 IM 多实例状态（IM Multi-Instance Status）

### 目标
当平台在多个区域 / 租户部署多个 IM 机器人实例（飞书 / 钉钉 / 企业微信）时，在一处集中展示各实例的**健康、连接、回调吞吐、最后心跳、故障转移**状态。

### 现状
P0-2 已完成「单实例真实平台验证」（`ImBridge` + `createImRegistry` + `feishu/dingtalk/wecom` 适配器）；但缺少多实例的聚合状态视图。

### 设计方案
- **后端**（扩展 `im/` 模块，新增 `im-status.ts`）：
  - `interface ImInstanceStatus { id; platform: 'feishu'|'dingtalk'|'wecom'; region?; healthy: boolean; lastHeartbeat: string; callbacksTotal; errorsTotal; failover?: string }`。
  - `class ImStatusAggregator`：持有各 `ImBridge` 引用，周期性（已用 `unref` 定时器）采集心跳与计数；`snapshot(): ImInstanceStatus[]`。
  - 端点：`GET /api/im/status`（受 `metrics:read` 或新增 `im:status:read`）。
- **前端**（`<ah-im-status>`，Tab「IM 状态」或并入「可观测」）：表格 / 卡片展示每实例健康徽标、吞吐趋势（迷你 sparkline）、点击查看最近错误。
- **故障转移**：`ImBridge` 已有重推去重；多实例下由聚合器标记主/备，主实例失活自动切备（状态写入 `ImInstanceStatus.failover`）。

### 关键接口 / 文件
- `access/server/src/im-status.ts`：`ImStatusAggregator` / `getImStatusAggregator()`。
- 复用：`im/`（P0-2）、`run-queue.ts` 的 `unref` 定时器约定（后台采集不得阻止进程退出）。

### 实施阶段
1. 状态采集器 + 端点；2. 前端状态视图；3. 故障转移标记；4. 与 P1-2 审计联动（实例切换记审计）。

### 风险 / 开放问题
- 多实例身份隔离依赖 P0 的租户隔离（`tenantId`）；需明确「实例↔租户↔区域」映射配置来源。
- 高频心跳对指标端点的压力，需采样。

---

## 6. P3-1 PI Agent 品牌位（Branding Slot）

### 目标
提供可配置的品牌位：替换平台名称、Logo、主题色、登录页标语，支持企业白标（white-label），且不侵入业务代码。

### 现状
`frontend/webapp` 主题由 `theme/tokens.ts`（`getTheme` / `toggleTheme`）统一管理；`login.ts` 与 `app.ts` 含品牌文案但硬编码。

### 设计方案
- **品牌清单**（默认 `BRAND_DEFAULT`，可被文件 / 环境变量覆盖）：
  - `interface BrandConfig { productName; logoUrl?; faviconUrl?; primaryColor; loginTagline?; footer? }`。
  - 来源优先级：运行时 `GET /api/brand`（来自 `.data/brand.json` 或 `BRAND_*` 环境变量）> 编译默认。
- **后端**：`access/server/src/brand.ts` 暴露 `GET /api/brand`（无需鉴权或 `metrics:read`，属公开展示）；`brand.json` 由运维配置。
- **前端**：
  - `theme/tokens.ts` 增加 `applyBrand(cfg)`：把 `primaryColor` 写入 CSS 变量（`--ah-primary`）。
  - `app.ts` / `login.ts` 的品牌文案改为读取 `BRAND` 全局（启动时 `authedFetch('/api/brand')` 或在 index.html 注入）。
  - `<ah-brand-foot>` 渲染页脚品牌位。
- **安全**：`logoUrl` / `faviconUrl` 必须为同源或显式白名单域名，防钓鱼（渲染前校验协议为 `https` 且域名 ∈ 白名单）。

### 关键接口 / 文件
- `access/server/src/brand.ts`：`BrandConfig` / `getBrandConfig()`。
- `frontend/webapp/src/theme/tokens.ts`：扩展 `applyBrand`。
- `frontend/webapp/src/brand.ts`：`<ah-brand-foot>`。

### 实施阶段
1. 品牌配置模型 + `/api/brand`；2. 主题变量注入；3. 登录页 / 控制台品牌位替换；4. 白名单校验与多品牌（租户级）扩展。

### 风险 / 开放问题
- 品牌位与既有 `PI Agent` 命名一致性：需确认对外品牌名（文档中暂称「PI Agent 品牌位」）。
- 多租户场景下的按租户品牌隔离是否本期需要（建议留接口、默认单品牌）。

---

## 7. 落地优先级建议（P2/P3 内部）

| 优先级 | 条目 | 理由 |
|---|---|---|
| 高 | P2-2 策略编辑器 | 直接降低既有 RBAC 的运维风险，复用度最高 |
| 高 | P2-5 IM 多实例状态 | 承接 P0-2，企业多区域部署刚需 |
| 中 | P2-3 Plan 协同 | 协同价值高但实现复杂度最高，建议分阶段 |
| 中 | P2-4 K8s ServiceMonitor | 纯产出物 + 脚本，CI 友好，风险低 |
| 中 | P3-1 品牌位 | 白标需求常见，改动面可控 |
| 低 | P2-1 桌面端 | 依赖原生打包与签名，成本最高，可后置 |

## 8. 统一待办（进入实现期时）

1. 每个条目先建 `access/server/src/<x>.ts`（接口+默认实现+工厂）+ 单测，再补 `server.ts` 路由与 `authz.ts` 权限，最后前端 `ah-*` 组件 + `Tab` 挂载（严格遵循第 0 节约定）。
2. 所有新增端点默认进 `node --test` 单测；前端新组件过 `pnpm --filter @agent-harness/webapp run typecheck`。
3. 实现前先与本设计逐条对齐「接口签名」与「权限归属」，避免再次并行实现时的签名漂移（P1 并行实现已验证该流程可行，但需统一在集成阶段做 `tsc` 全量校验）。

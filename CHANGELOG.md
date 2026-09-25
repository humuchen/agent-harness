# Changelog

本项目遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/) 格式。

---

## [Unreleased] - 2026-09-25

### 📚 文档全量重新整合（多轮功能新增与修复后的总收口）

- **新增 3 份文档**：[`docs/01-architecture/plan-mode.md`](./docs/01-architecture/plan-mode.md)
  （计划模式全链路：澄清 → propose → DAG 执行 → 交付归档）、
  [`docs/02-deployment/database-backends.md`](./docs/02-deployment/database-backends.md)
  （sqlite/turso/MySQL/PostgreSQL 后端矩阵 + 方言层 + 租户数据分区 + 搬迁工具）、
  [`docs/02-deployment/hardening-2026-09-25.md`](./docs/02-deployment/hardening-2026-09-25.md)
  （2026-09-25 加固批次 18 项修复总账 + 新增环境变量表 + 探针速查）。
- **CHANGELOG 补记缺失批次**：计划模式与多步任务执行、Jev 决策模型接入、数据库多后端与
  租户数据分区、S3 工件存储与移动端壳（2026-09-18 ~ 09-24 期间落地但此前未入册）。
- **README 同步**：目录树补 `mobile/`；内置工具表补 `fs_write` / `doc_export` / `jev_decide`；
  护栏章节更新 Jev 语义打分已接入；测试规模（core 约 630 用例 / 85 文件）、server 规模
  （约 90 源文件 / routes/ 18 模块）、CI/CD 四作业描述（gitleaks / Syft SBOM / e2e / nightly）；
  新增「计划模式」「文件导出与交付闭环」「工件存储」「数据库后端」「移动端」章节。
- **docs/README.md 索引全量化**：从 5 类扩展到 10 目录（补 `07-rag` / `08-others` / `design` /
  `proposals` / `test`），补登记 `k8s-upgrade-rollback-runbook.md`、`plugin-sandbox-design.md`
  等此前遗漏文档；仓库结构快照刷新。
- **失效链接修复**：`docs/test/P1~P3-SUMMARY.md` 归档时遗留的 14 处相对链接全部修复
  （根目录迁移导致的 `./` 前缀失效、已移除文件的链接改为纯文本）。
- **一致性校验**：全仓 56 份文档相对链接 0 坏链；旧表述（测试计数、SBOM 未集成、探针路径等）无残留。

### 🔒 安全加固与稳定性收口（四维能力评估后的 18 项修复）

全项目「健壮 / 稳定 / 安全 / 自愈」四维代码审计（纯源码实证）后，对 12 项 P1 + 6 项结构性问题
逐一修复；完整清单与文件坐标见 [`docs/02-deployment/hardening-2026-09-25.md`](./docs/02-deployment/hardening-2026-09-25.md)。

**安全**

- **越权修复（IDOR）**：`/api/artifacts` 列表 / 读取 / 删除按 owner 过滤（admin 豁免），
  归属不符统一 404 不泄露资源存在性——此前任意 viewer 可读所有用户的 Agent 产出物、
  operator 可删他人工件（`routes/collab-routes.ts`）。
- **可信代理网段**：新增 `access/server/src/trusted-proxy.ts`（零依赖 CIDR 匹配，IPv4 掩码 +
  IPv6 展开/映射折返）；`clientIp()` 仅当 TCP 对端落在 `TRUST_PROXY_CIDRS` 内才采信
  `cf-connecting-ip` / `X-Forwarded-For`，直连部署下伪造头不再能绕过 IP 限流（缺省仅信任回环，
  compose 缺省含 docker 网段）。
- **MCP 运行时接入校验**（`mcp-manager.ts`）：`serverUrl` 经 core `resolveHostIsPrivate` 做
  DNS 级私网黑名单（防元数据端点 SSRF）+ 仅 http/https + `command` 白名单
  （`MCP_ALLOWED_COMMANDS`）+ args shell 元字符拒绝；启动期 env 配置不受限；
  内网 MCP 可显式 `MCP_ALLOW_PRIVATE_SERVER_URL=on`；被拒配置不落库。
- **忘记密码凭证交付补齐**：HTTP 回显门禁（`PASSWORD_RESET_INLINE_TOKEN`，默认带外）此前已在
  路由层落地；本轮补齐签发事件日志 `auth.reset_token_issued`（不含凭证本体，注明查
  `password_resets` 表转交）、前端透传服务端 `message` 提示、`.env.example` 部署文档。
- **供应链**：Dockerfile 锁文件校验失败不再静默降级 `--no-frozen-lockfile`（`STRICT_LOCKFILE=0`
  为显式逃生门）；compose 补 `no-new-privileges` + `cap_drop: ALL`（与 k8s securityContext 对齐）。
- **插件密钥收窄**：`OPEN_API_KEY` 不再无条件注入所有插件（改 `PLUGIN_SHARE_LEGACY_LLM_KEY=on`
  显式开关）；插件回调本机 API 改注入专属凭证 `ADMIN_API_KEY`（`reminders-trigger` 优先读取）。

**稳定**

- **共享队列提交语义收紧**：`submit` 异步化；Redis 模式下落盘（`append`）失败同步返回
  **503**（`QueuePersistError`）并回滚资源——此前仅 `console.error`，客户端拿到 jobId 但任务
  永远不被执行；单实例模式维持「失败仅影响崩溃重放」语义。
- **跨实例幂等**：`idempotencyKey` 去重从进程内 Map 扩展为两层（Redis `SET NX PX`，
  `runq:idem:<key>`，TTL `RUN_QUEUE_IDEM_TTL_MS` 默认 30 分钟，终态主动释放）；
  重复提交返回 **409**（`QueueDuplicateError`）+ 既有 jobId，其事件经事件桥对任意实例可见。
- **僵尸任务周期回收**：`reclaimStale` 从「仅启动时一次」改为周期执行
  （`RUN_QUEUE_RECLAIM_INTERVAL_MS` 默认 60s），claim/ack 之间崩溃的任务不再滞留 processing。
- **启动期**：端口占用（EADDRINUSE）给出可操作提示并告警；`AH_STARTUP_CRITICAL=1` 时
  启动迁移失败阻断启动（不再带旧 schema 接流）。

**自愈（探针与告警接线）**

- **探针统一切换**：k8s readiness → `/health/ready`（真实探测 DB `SELECT 1` / Redis PING /
  内存水位，未配置的依赖自动跳过）、liveness → `/health/live`；Dockerfile HEALTHCHECK、
  docker-compose healthcheck、render.yaml 同步——此前全部打在不探测依赖的 `/api/state` 上，
  Redis 宕机时 readiness 仍 200。k8s redis Deployment 补 liveness/readiness（redis-cli PING）。
- **告警幽灵指标修正**：prod overlay `alerts.yaml` 此前引用从未导出的 `llm_call_*` /
  `harness_job_started_seconds`（两条告警永不触发），改用 `harness_*` 组合表达式
  （`HarnessRunFailureRateHigh` 失败率 / `HarnessProcessingStuck` 处理滞留）。
- **CI 修复与补强**：nightly 回滚演练作业缩进错误导致整个 workflow 无法解析（`schedule` 触发器
  移至 workflow 级 `on:`）；e2e 作业纳入 `load-test` / `capacity-benchmark`。

**健壮**

- **损坏 JSON 统一处置**（新增 `backend/core/src/store-safety.ts`）：记忆 / 工作流检查点 /
  AgentCard 解析失败统一「结构化告警 + 坏文件隔离改名（`.corrupt-<ts>`）+ 空状态继续」，
  不再静默当空数据；RAG 索引损坏从启动崩溃循环收敛为同一策略（rag 为 stdlib-only，内联等价实现）。
- **RAG 嵌入超时**：两处 `fetch` 加 `AbortSignal.timeout(RAG_EMBED_TIMEOUT_MS)`（默认 60s）——
  embed-server 挂起时不再耗尽 ingest worker 池。
- **memo 插件 DB 初始化自愈**：`ensureDb()` 失败重置缓存（此前 rejected promise 永久缓存）。
- **前端全局错误兜底**：webapp 挂 `error` / `unhandledrejection` 监听（去重提示 +
  `window.__ahClientErrors` 环形缓冲）。
- **清理误删防护**：`cleanup-retention` 不再按龄删除活跃的 `telemetry-metrics.json`。

---

### ✨ 文件导出与交付闭环（报告可交付真实 PPT / Excel）

报告生成此前只能产出 markdown 文本（计划交付文档），PPT / Excel 无法落成真实文件——
工具面无写文件能力、无格式生成器、二进制文件也进不了「📎 交付文件」区。本轮补齐三段闭环：

- **`builtin__fs_write`**（core `builtins/filesystem.ts`）：沙箱内写文件（utf-8 文本 / base64 二进制），
  父目录自动创建，复用 `safe/safeReal` 防路径逃逸，2MB 上限；返回相对 realRoot 路径可直接用于后续工具调用。
- **`builtin__doc_export`**（core `builtins/docexport.ts`）：结构化数据 → 真实文件，落到沙箱 `exports/` 目录。
  `xlsx`（exceljs，sheets=[{name, rows}]）、`pptx`（pptxgenjs，slides=[{title, bullets, notes?}]）、
  `csv`（零依赖 RFC4180，对象数组自动补表头）。exceljs / pptxgenjs 以 core **optionalDependencies** 声明
  （与 OpenTelemetry 同款「可选即降级」先例），缺失时返回带安装指引的可操作错误。
- **`builtin__deliver_file`**（server `deliver-file.ts`）：把沙箱内已生成文件注册进 artifact-store，
  runId 从 sessionKey 推导（plan 步骤 `wf:<workflowId>:<stepId>` → workflowId，与 plan-artifacts 同键），
  使 xlsx / pptx / csv 出现在「📎 交付文件」区可预览 / 可下载；owner 经 runWithUser 上下文归属登录用户；
  体积上限 `DELIVER_FILE_MAX_BYTES`（默认 10MB），realpath(root) 前缀基准防 symlink 逃逸。
- **技能与提示词配合**：core 技能新增 `doc-export`（触发词 ppt/excel/xlsx/csv/导出/交付文件…，
  指引「生成 → deliver_file 交付 → 正文列文件名」标准链路与降级策略）；
  planner 提示词新增 4b「文件交付对齐」（含 PPT/Excel 目标时拆「生成交付文件」任务）；
  workflow-executor step prompt 对文件类任务追加交付指引。
- **测试**：core 新增 `fs-write.test.cjs`（5 例）、`doc-export.test.cjs`（6 例，可选依赖缺失自动 skip）；
  server 新增 `deliver-file.test.cjs`（5 例，纯函数 + 端到端注册往返）。
  修复 `plan-propose.test.cjs` 遗留失败（0e2b9e9 起调研循环改 LLM 驱动后 mock 未同步）、
  `skills.test.cjs` 技能数断言（5 → 6）。

---

### ✨ 计划模式与多步任务执行（2026-09-18 ~ 09-24 多批次迭代）

Chat 内「规划-执行-交付」多步任务形态，分层：core 契约/解析/映射（`plan.ts` + `plan-propose.ts`）、
server 透传/落盘/事件桥/归档（`plan-routes` / `plan-store` / `plan-bus` / `plan-verify` / `plan-artifacts`）、
webapp 全部 UI 语义。完整链路见 [`docs/01-architecture/plan-mode.md`](./docs/01-architecture/plan-mode.md)。

- **规划**：需求澄清分支（候选选项点选 / 逐题作答）、两段式 propose 管线（实时活动 + 计时）、
  规划模式步数与工具调用限制、长输入放宽；计划树可确认可编辑，任务支持 `requireApproval`
  人工审批门（波次前暂停 → 放行续跑）。
- **执行**：计划桥按 DAG 形状自动决策串/并行并支持有界并发（此前默认全串行）；显式取消 +
  断连自愈（断连中止引擎运行、清理思考面板残留）；验收词软门禁（P4.5 确定性结果断言零 LLM
  成本拦跑题/空/截断产出，P4.7 收敛「告知词 = 断言词」）；失败/中断状态落盘，重开不从头重跑。
- **交付**：各 step 产出归档为可下载工件（`kind=plan-step-output`）；计划任务可合并交付文档；
  终止后归档汇总交付报告；执行详情截断上限放宽至 20 万字。
- **可观测**：`jev:call` 旁路事件上报 Jev 调用、调用统计与状态自检接口（`scripts/jev-e2e.cjs`
  端到端验证）；chat-trace Token 用量口径修正为整轮累计。
- **UI**：思考面板（钉底滚动/归因/执行详情）、侧边栏布局与折叠动效、移动端下拉刷新与顶栏刷新、
  消息编辑重发。

### ✨ Jev 决策模型接入（TypeSafe「System One」）

Jev 不是文本生成型 LLM，而是接收「程序状态 + 带类型结构化问题（Choice/Score/Noul）」、
返回带校准概率决策的模型。作为**内置决策工具**接入（`builtins/typesafe-jev.ts`）：

- `builtin__jev_decide` 工具（LLM 主动调用）+ `jevDecide()` 异步客户端（护栏 / 路由 / RAG /
  上下文压缩等子系统在 LLM 之外直接调用），两者共用 HTTP 调用与凭据解析
  （显式参数 > 运行级 BYOK > `TYPESAFE_API_KEY`，未配置自动回落旧逻辑）。
- 护栏注入检测接入 Jev 语义打分（`registerInjectionScorer()` 首个真实实现）。
- `jev:call` 旁路事件接入可观测性；`scripts/jev-smoke.cjs` / `jev-e2e.cjs` / `jev-als-repro.cjs` 验证脚本。

### ✨ 数据库多后端与租户数据分区（2026-09-24）

- **统一数据库适配器**（`db-adapter.ts` + `db-dialect.ts` 方言层）：`DB_BACKEND` 切换
  `sqlite`（默认，零依赖）/ `turso`（`@libsql/client` 可选依赖，失败自动降级）/ `mysql` /
  `postgres`（`mysql2` / `pg` 驱动，`DATABASE_URL` scheme 必须匹配，配置错误 **fail-fast**
  不静默降级）；SQLite 方言 SQL 在适配器出口自动翻译为目标方言，store 层零改动。
- **租户数据分区**：`TENANT_DATA_ZONE` 使 sqlite 库按合规域物理分文件（`./data/<zone>/app.db`），
  与 `ComplianceProfile.dataResidency`、审计 `dataZone` 联动；配额引擎多副本闭环与租户表接线。
- **搬迁与运维工具**：`scripts/db-copy.cjs`（sqlite ↔ turso 双向复制）、`db-migrate.cjs`、
  `smoke-db.cjs`；turso 降级实例缓存键并入本地文件名，修复跨 store 数据串库缺陷。
- 详见 [`docs/02-deployment/database-backends.md`](./docs/02-deployment/database-backends.md)。

### ✨ 工件存储 S3 化与移动端壳（2026-09-20 前后）

- **S3 兼容对象存储工件后端**（`artifact-store-s3.ts`）：与本地版同契约，支持 AWS S3 /
  Cloudflare R2 / MinIO / Render Object Storage；SigV4 签名手写（node:crypto）零 SDK 依赖，
  仅需 GetObject / PutObject / DeleteObject 三个权限；工件 md 预览渲染。
  环境变量：`S3_BUCKET` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` / `S3_ENDPOINT` /
  `S3_REGION` / `S3_FORCE_PATH_STYLE`。
- **移动端**（`mobile/`）：Capacitor 包裹 webapp 构建产物的 iOS / Android 壳——推送通知
  （FCM/APNs）、`piagent://` Deep Link、相机/相册上传、Face ID / 指纹快捷登录、TTL 离线缓存
  （见 `mobile/README.md`）。
- **运行时健壮性**：harness 动态工具选择首轮发子集并智能兜底；BYOK 凭据透传子智能体；
  医美插件新增定时调度器与对客触达、内容生产 / AB 分流 / 咨询师辅助三能力（见
  `docs/04-agents/medical-aesthetics-rollout-checklist.md`）。

---

## [0.3.0] - 2026-09-03

### 📚 文档

全量刷新项目 `*.md` 文档以匹配当前架构与各模块功能（此前文档滞后于多轮代码改动）：

- **README.md**：目录树补齐 3 个业务插件（`customer-service` / `medical-aesthetics-lead` / `memo`）、`skills/`、`migrations/`、`scripts/`、`data/`、额外 `docker-compose*.yml`；核心模块清单补全 `router/` `policy/` `quota/` `workflow/` `a2a/` `plugin/` `sandbox/` `skills/` `builtins/` `subagent/` `teams/` 等；server 源文件由 5 个示例扩写为约 45 个的接入层说明。
- **修正失效声明**：`.github/workflows/docker.yml`（镜像推送）与 CI 的 SBOM / Dependency Review 作业均不存在——实际仅 `ci.yml`（lint → `pnpm -r build` → `pnpm -r test` → `pnpm audit --audit-level=high`）。
- **测试计数**：core `101 用例` → 约 `371`（52 测试文件）；全仓约 `681` 用例。
- **RAG 服务**：描述由「stdio MCP Server」更正为「默认 HTTP（`/v1/retrieve`、`/v1/ingest`），可选 MCP stdio，零运行时依赖」。
- **新增章节**：「业务插件（Plugins）」与「接入层扩展能力（账户 / OAuth / BYOK / 插件市场 / 多会话）」；基座子系统表补 `subagent/` 与 `teams/`。
- **`docs/01-architecture/execution.md`**：主循环默认步数 `12` → `24`。
- **落地状态更正**：`docs/03-plugins/customer-service-agent-modules.md` 标「已实现」（19 源文件、SQLite、4 工具 `ticket`/`kb`/`order`/`handoff`）；`docs/01-architecture/user-provider-key-design.md` BYOK 标「已实现」；`docs/05-analysis/架构落地缺口分析.md` 天气工具缺口更正为已实现（`builtins/weather.ts`）。

### ✨ 架构演进（本轮文档补齐；能力此前已随代码落地）

- 接入层 `access/server` 已落地账户密码登录、OpenRouter OAuth PKCE、BYOK per-run 凭据注入、插件市场 Registry、多会话 Chat + 跨设备 SSE 同步、备忘提醒总线、配置热更新、K8s 健康探针、日志脱敏、副本选择器。
- 核心 `backend/core` 多智能体基座补 `subagent/`（`SubAgentManager` + `delegate_task`）与 `teams/`（`Team`/`TeamManager`）。

---

## [0.2.2] - 2026-08-21

### 🐛 修复（medical-aesthetics-lead 转人工）

- **Bug**：用户在线上预约系统不可用时被 agent 口头承诺「提交给客服人员」，但转人工队列为空——agent 只输出自然语言、未调 `lead_handoff`，客资未落库。
- **提示词加固**（`src/prompts.ts`）：新增「转人工与预约失败的强约束」——`consultation_book` 返回 `ok:false`（NOT_CONFIGURED/CONFLICT/UPSTREAM_* 等）时必须 `lead_handoff`，reason 透传 `booking-failed:<code>` 与院区/日期/时段；禁止只口头承诺、禁止编造未配置跟进方式（短信/电话回访）、禁止失败后盲目重试；handoff 前先 `lead_qualify` 落库画像。
- **硬兜底**（`src/tools/book.ts`）：非 `INVALID_ARGUMENT` 的 booking 失败，工具层自动触发 `lead_handoff` 落库并回灌 `autoHandoff` 字段给模型据实回复——即使模型不遵守提示词，客资也一定进队列（幂等 upsert）。
- **测试/评测**：新增 `test/prompts.test.cjs`（6 例，提示词规则回归保护）、`test/hardoff.test.cjs`（4 例，NOT_FOUND 自动转人工 / INVALID_ARGUMENT 不触发 / 成功不触发 / 幂等）；`scripts/booking-fail-eval.cjs` 真实模型评测（`pnpm --filter @agent-harness/medical-aesthetics-lead run eval:booking`）——预约失败场景断言临时库 `handed_off=1` ≥1、回复如实提及转交且不编造跟进方式，EVAL_PASS。
- 验证：插件 `node --test test/*.test.cjs` **22/22 全绿**。

---

## [0.2.1] - 2026-08-21

### 🔄 变更（medical-aesthetics-lead 知识检索迁移至外部 RAG）

- 医美插件知识检索由静态 `knowledge/` 母版切换为外部 RAG 服务（`services/rag`）：
  - 新增 `scripts/rag-ingest.cjs`，将（已下线的）`knowledge/` 母版灌入 RAG 向量库，产出 `rag-store.json`（gitignored，运行期唯一持久化知识源）。
  - `project_kb_search` 在 `MA_RAG_BASE_URL` 已配时优先走 RAG `/v1/retrieve`，合规闸门（compliantCopy / reviewed）在 RAG 元数据上保留；未配回退 `ma_project` 本地库。
  - 删除 `knowledge/` 目录与依赖它的 `kb-seed/kb-eval/kb-export/kb-validate.cjs`；保留 `kb-smoke.cjs`。
  - `.env.example` 新增 `MA_RAG_*` 与 RAG MCP 注册示例；相关文档（CONFIG / REFACTOR / DATABASE_SCHEMA / agent 设计 / RAG 设计）已同步。

---

## [0.2.0] - 2026-08-20

### ✨ 新增功能（多智能体基座子系统）

在单智能体闭环之上落地多智能体基座，全部以「接口 + 默认实现 + 组合工厂」范式存在，server 已接入运行链路：

- 智能体注册与发现（`agents/`）：`AgentCard` + `AgentRegistry` + `AgentStore`（volatile/file/redis）
- 任务路由（`router/`）：`IntentRouter` + `AgentSelector` + LRU 缓存 LLM 意图分类 + 规则回退
- 租户隔离（`tenant.ts`）：复合记忆 key、认证身份优先、`REQUIRE_TENANT` 门禁
- 策略引擎（`policy/`）与配额引擎（`quota/`）：行业策略画像预选 + 租户级并发准入
- 工作流编排（`workflow/`）：`DagEngine` DAG 执行 + 补偿 + `WorkflowStore`
- A2A 协议（`a2a/`）：Local/Http 传输，跨主机 `/api/a2a/tasks` 派发
- 插件框架（`plugin/`）：`PluginManifest` → `PluginLoader`（验签/升级）→ `PluginRegistryClient`
- OS 级沙箱（`sandbox/`）：Linux 命名空间/seccomp，非 Linux 降级为硬化本地进程
- 审计（`audit.ts`）、特性开关（`feature-flags.ts`）、统一错误日志（`errorlog.ts`）

### 🔐 安全加固（本轮审查修复）

- `/api/chat/sessions*` 多会话聊天 CRUD 补齐 RBAC 鉴权（新增 `chat:read`/`chat:write`/`chat:delete`）；`GET /api/env` 新增 `env:read`
- 插件市场 `registry-server` 补发布鉴权（`REGISTRY_TOKEN`）、插件包下载端点（`GET /plugins/*.tar.gz`）、CORS 白名单（`REGISTRY_CORS_ORIGIN`）

### 🐛 修复

- 插件版本排序改用语义化比较（`cmpVersion`），修复 `localeCompare` 导致 `latestVersion` 计算错误
- 插件市场元数据改为原子写（临时文件 + rename），下载计数改为内存聚合 + 定期落盘，避免每请求整文件重写

### 🔧 工程改进

- `feature-flags` 框架接线到真实功能：`contextCompression` 经 `isEnabled()` 判定，新增 `GET /api/features`（`policy:read`）
- `examples/` 补齐 `workflow` / `multi-agent` / `os-sandbox` 入口脚本

### 📚 文档

- 根 `README.md` 新增「基座子系统」总览
- `docs/03-plugins/customer-service-*` 标注为「设计稿（未落地）」；插件架构文档补充 `packages/` vs `plugins/` 目录边界说明

---

## [0.1.0] - 2026-08-19

### ✨ 新增功能

#### 核心架构

- 三层插件化架构(Core层、Server层、Webapp层)
- pnpm monorepo工作区管理(7个包)
- RBAC鉴权系统(admin/operator/viewer)
- 审批工作流(InMemoryApprovalPolicy)
- 多队列后端支持(Memory/File/Redis)

#### 医疗客资插件

- 线索资质评估与留资
- 号源管理与预约系统
- 事务级防超卖机制
- 线索阶段单调推进(不回退)
- 知识库检索服务
- 发件箱投递系统
- 看板统计与漏斗分析

#### 医疗广告合规护栏

- 5大合规规则拦截
  - 绝对化承诺检测
  - 诊断话术拦截
  - 术前术后对比过滤
  - 固定价承诺拦截
  - 贬低同业检测
- 知识库查空硬拦截

### 🧪 测试覆盖

#### P0 测试 (96%通过率)

- Server包单元测试(44/44通过)
  - RBAC鉴权测试
  - 审批工作流测试
  - 队列后端测试
- 医疗广告合规测试(21/21通过)
  - 5大规则覆盖
  - 知识库拦截测试
- 插件E2E测试(7/8通过,87.5%)
  - 完整业务链路测试
  - 号源防超卖测试
  - 线索阶段不回退测试

#### P1 测试

- API集成测试(5个核心端点)
  - `/api/state` 系统状态
  - `/api/v1/run` Job生命周期
  - `/api/v1/approvals` 审批工作流
  - `/api/v1/eval` 评估端点
  - `/` 健康检查
- 性能/负载测试脚本
  - 支持并发控制
  - P50/P95/P99百分位统计
  - 详细报告生成
- Webapp构建验证

### 🔧 工程改进

#### TypeScript配置

- 统一继承`tsconfig.base.json`
- CLI包减少8行重复配置
- 所有包配置一致性提升

#### 脚本工具

- `pnpm test:load` - 默认负载测试
- `pnpm test:load:heavy` - 重压测试(50并发/500请求)
- `pnpm test` - 全量测试套件

### 📚 文档

#### 架构文档

- `docs/01-architecture/` - 架构设计
  - architecture.md - 系统架构
  - execution.md - 执行流程
  - modules.md - 模块说明
- `docs/02-deployment/` - 部署指南
  - docker-deploy-guide.md - Docker部署
  - k8s-deploy-guide.md - K8s部署
  - multi-instance-runbook.md - 多实例运行
- `docs/03-plugins/` - 插件开发
  - agent-plugin-architecture.md - 插件架构
  - customer-service-agent-design.md - 客服Agent设计
- `docs/04-agents/` - Agent设计
  - medical-aesthetics-lead-agent.md - 医美客资Agent

#### 改进计划

- IMPROVEMENT-PLAN.md - 项目改进计划
- P0-SUMMARY.md - P0完成总结
- P1-SUMMARY.md - P1完成总结

### 🚀 部署

#### Docker

- 多阶段构建优化
- docker-compose.yml - 单机部署
- docker-compose.redis.yml - Redis支持
- Dockerfile - 生产镜像

#### Kubernetes

- 完整K8s配置(deploy/k8s/)
  - deployment.yaml - 部署配置
  - service.yaml - 服务配置
  - ingress.yaml - 入口配置
  - hpa.yaml - 自动扩缩容
  - configmap.yaml - 配置管理
  - secret.yaml - 密钥管理
- kustomize支持(deploy/overlays/local/)

### 📦 技术栈

- **运行时**: Node.js 22.x
- **包管理**: pnpm 11.9.0
- **TypeScript**: 5.4.5
- **框架**:
  - Vite 5.4.11 (Webapp)
  - Lit 3.2.1 (前端组件)
- **数据库**: SQLite (better-sqlite3)
- **缓存**: Redis (ioredis 5.4.1, 可选)
- **MCP SDK**: 1.12.1

### ⚠️ 已知问题

- 插件E2E测试1个失败用例(线索阶段不回退测试偶尔失败)
- 插件市场registry server未实现(仅接口层)

### 📋 待办事项

> 注：以下大部分已在本仓库后续演进中落地，勾选项见下（详见 [0.2.0] 与代码现状）。

#### P2 - 开发者体验

- [ ] 示例代码注释完善
- [x] 插件开发脚手架（`scripts/create-plugin.cjs`）
- [x] 错误码文档（`docs/error-codes.md`）

#### P3 - 架构增强

- [x] 健康检查端点标准化（`health.ts` + `/health/live`、`/health/ready`）
- [x] 特性开关框架（`feature-flags.ts`，已接线 `/api/features`）
- [x] 数据迁移脚本（`migrations/` + `scripts/db-migrate.cjs`）

---

## 格式说明

- `✨ 新增功能` - 新功能
- `🐛 修复` - Bug修复
- `🔧 工程改进` - 代码质量、工具链等
- `📚 文档` - 文档更新
- `🚀 部署` - 部署相关
- `⚠️ 已知问题` - 已知限制
- `📋 待办事项` - 计划中的工作

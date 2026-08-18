# Agent Harness · 系统架构（权威总览）

> 本文档为当前实现的**单一权威架构说明**，覆盖：系统分层与职责、端到端业务流（启动 → 完整闭环）、部署与配置、核心模块协作关系。
> 配套图示：`./diagrams/architecture.svg`、`./diagrams/execution-flow.svg`、`./diagrams/module-dependency.svg`。
> 历史专项分析（能力评估 / 行业对接 / 单智能体闭环）见 `../05-analysis/industry-integration-readiness.md`、`../05-analysis/single-agent-closed-loop.md`，均基于**同一份已落地代码**。

---

## 0. 一句话定位

`agent-harness` 是一个 **pnpm monorepo** 形态的「智能体调度基座」：在单智能体执行引擎之上，落地了**智能体注册发现、任务路由分发、跨行业租户隔离、统一 A2A 协议、工作流编排、插件框架、OS 级沙箱隔离、配额计费与审计**等统一基座能力。对外服务能力由 `packages/server` 的 HTTP+SSE 进程提供。设计目标：单一可替换 LLM 契约、零硬运行时依赖（OTel/K8s/Redis 缺失即降级）、工具错误自愈、护栏先行、一切降级可用。

---

## 1. 分层架构与各层职责

```
┌──────────────────────────────────────────────────────────────────────┐
│  接入层 (packages/server · HTTP+SSE API + Webapp SPA + CLI)            │
│  /api/run · /api/agents · /api/workflows · /api/a2a/tasks · 鉴权/RBAC │
├──────────────────────────────────────────────────────────────────────┤
│  路由编排层 (core: router/ · workflow/ · a2a/)                          │
│  resolveTask() 意图分类+能力评分选 agent · DagEngine DAG 编排+补偿       │
├──────────────────────────────────────────────────────────────────────┤
│  智能体层 (core: agents/)                                              │
│  AgentCard 声明域/能力/隔离/装配(工具·技能·MCP·提示词) · AgentRegistry   │
├──────────────────────────────────────────────────────────────────────┤
│  基座服务层 (core: tenant · policy · quota · audit · sandbox · plugin)  │
│  租户隔离 · 行业合规护栏 · 配额计费 · 审计 · OS/容器隔离 · 插件/市场     │
├──────────────────────────────────────────────────────────────────────┤
│  执行后端层 (core: harness · tools · memory · guardrails · llm · integrations) │
│  AgentHarness.run 主循环 · 工具注册表 · 记忆 · 三层护栏 · LLM 适配器 · MCP/Env │
└──────────────────────────────────────────────────────────────────────┘
```

### 1.1 包职责与依赖方向

| 包 | 入口 | 职责 | 关键依赖 |
|---|---|---|---|
| `@agent-harness/core` | `dist/index.js` | 框架 + 基座原语：harness / tools / memory / guardrails / telemetry / llm / integrations / builtins / skills / **agents / router / tenant / policy / workflow / a2a / plugin / sandbox / quota / audit** | 仅 Node 内置 + `@modelcontextprotocol/sdk`（硬依赖） |
| `@agent-harness/server` | `dist/server.js` | 组合根：HTTP+SSE 仪表盘、运行队列、MCP 管理、环境治理、RBAC/审批/评估/留存、Agent/Workflow/A2A 端点 | core |
| `@agent-harness/webapp` | Vite 产物（同源托管） | Lit SPA，消费 client SDK | client |
| `@agent-harness/client` | `dist/index.js` | 零依赖 HTTP+SSE 客户端，对 `/api/v1` 建模（含 listAgents/getAgent/sendTask/streamWorkflow） | 仅调 server HTTP API，不 import core |
| `@agent-harness/cli` | `dist/cli.js` (`bin: ah`) | 运维/CI 命令行（run/stream/approvals/workflow） | client |
| `examples` | 多个 `.ts` | 示例：basic / chat / multi-agent / workflow-demo / medspa-agent / os-sandbox … | core |

**依赖方向**：`server → core`，`webapp → client → server(/api/v1)`，`cli → client`，`examples → core`。
**构建拓扑**（`pnpm -r build` 按 workspace 拓扑）：`core → client → server → webapp / cli → examples`。跨包 tsconfig `paths` 指向兄弟包 `dist/index.d.ts`，故必须先构建被依赖方。

### 1.2 外部集成

| 集成 | 位置 | 必填 | 说明 |
|---|---|---|---|
| **OpenRouter** | `core/src/llm/openrouter.ts` | 可选（默认 LLM） | 需 `OPENROUTER_API_KEY`；基于原生 fetch，零额外 npm 依赖 |
| **OpenAI** | `core/src/llm/openai.ts` | 可选 | `createFailoverLLM` 的 secondary；需 `OPENAI_API_KEY` |
| **Harness.io 环境平台** | `core/src/integrations/harness-client.ts` | 可选 | 无 key 时 dry-run；`ENV_PLATFORM=harness` 默认 |
| **MCP 服务** | `core/src/integrations/mcp/placeholder.ts` | SDK 为硬依赖 | `@modelcontextprotocol/sdk`；配即激活（stdio/SSE/StreamableHTTP） |
| **Kubernetes** | `core/src/integrations/k8s-env-platform.ts` | 可选 | `@kubernetes/client-node`（optional）；`ENV_PLATFORM=k8s` |
| **OpenTelemetry** | `core/src/telemetry.ts` | 可选 | `@opentelemetry/api`（optional）；缺则降级为内存快照 |
| **Redis** | `server/src/queue-backend.ts`、`core/src/agents/store.ts` | 可选 | `ioredis`（optional）；多副本运行队列 + AgentStore 后端 |

---

## 2. 核心模块与协作关系

### 2.1 执行后端层（core，可独立用于单智能体）
- **`harness.ts`** — `AgentHarness` + `run()` 主循环（自动闭环核心，详见 §3）。
- **`tools.ts`** — `ToolRegistry`（register/schemas/has/call/unregister/mergeFrom），所有工具（内置/MCP/skill）注册进同一注册表。
- **`memory.ts` + `memory-store.ts`** — `Memory` 运行时（窗口/长期笔记/摘要器/load·save）+ `Volatile/File/Sqlite` 三种持久化后端。
- **`guardrails.ts`** — 输入/输出/工具参数三层护栏 + PII 脱敏 + 出网管控（`checkEgress`）。
- **`llm/`** — `openrouter`（默认）、`openai`、`failover`（熔断器）、`shared`（共用请求/解析）、`pricing`（单价表）。
- **`builtins/*`** — 内置工具（filesystem/webfetch/datetime/calculator/shell），`builtin__` 前缀；shell 支持 human-in-the-loop 确认（`shell-approval`）。
- **`skills/*`** — `SkillRegistry` + `builtin__use_skill` 元工具 + 触发词预激活。
- **`integrations/*`** — MCP 连接管理器（`mcp/placeholder.ts`）、环境平台（`env-platform.*`、`harness-client.ts`）、本地/k8s 后端。

### 2.2 智能体层（core：`agents/`）
- **`agents/types.ts`** — `AgentCard`（域/能力/transport/isolation/assembly：工具·技能·MCP·提示词）、`makeDefaultAgentCard()`、`DEFAULT_AGENT_ID`。
- **`agents/registry.ts`** — `AgentRegistry`（capability→agentId 倒排索引、heartbeat、sweepStale；进程内单例 `getAgentRegistry()` 首次访问 seed default agent）。
- **`agents/store.ts`** — `AgentStore` 接口 + `Volatile/File/Sqlite/Redis` 实现（`createAgentStoreFromEnv` 按 `AGENT_STORE` 解析）。

### 2.3 路由编排层（core：`router/` · `workflow/` · `a2a/`）
- **`router/`** — `IntentRouter`（默认 rule 关键词 + `INTENT_ROUTER=llm` 小模型分类）、`AgentSelector`（`scoreAgent` 纯函数：域×能力×健康×SLA×租户亲和）、`TaskRouter.resolve()`（显式 agentId > 显式 domain > classify+select > fallback default；`TASK_ROUTER=off` 仅留显式寻址+兜底）。
- **`workflow/`** — `DagEngine`（拓扑分层并行 + 失败逆序 `compensate` + `resume()` 检查点续跑；`validateWorkflow()` 成环/缺依赖 fail-fast）。
- **`a2a/`** — `TaskEnvelope`/`TaskResult` + `LocalA2ATransport`（进程内 handoff）/ `HttpA2ATransport`（fetch 投递 `/api/a2a/tasks`，SLA 超时 + 失败降级）、`dispatchAgentTask` 按 card 选传输。

### 2.4 基座服务层（core：`tenant` · `policy` · `quota` · `audit` · `sandbox` · `plugin`）
- **`tenant.ts`** — `TenantContext` + `resolveTenantContext`（认证身份优先，防伪造越界）+ `tenantSessionKey`（复合记忆 key 物理隔离）。
- **`policy/engine.ts`** — `PolicyEngine`（default + per-tenant 浅合并 + `applyIndustryProfile` 行业画像）；内置 `finance`(denylist+`*` 默认禁出网)、`medical-aesthetics`/`healthcare`(高敏注入+强 PII)、`education`(放宽) 四套画像。
- **`quota/engine.ts`** — `QuotaEngine`（QPS 令牌桶 + 并发信号量 + token/cost 窗口硬限，per-tenant）。
- **`audit.ts`** — tenantId 维度审计，可插拔 sink。
- **`sandbox/`** — `SandboxExecutor` 抽象；`Local`/`Container`(docker/podman)/`OS`(原生 C helper，命名空间+seccomp+capabilities+rlimit) 三态后端 + 降级；`resolveIsolationBackend` 决策链（card→租户策略→env）。
- **`plugin/`** — `PluginManifest` + `PluginLoader`(install/enable/disable/upgrade + 依赖解析 + `capabilities` 自动转 AgentCard) + `signature`(HMAC/Ed25519 验签) + `registry`(远程 registry 拉取)。

### 2.5 业务层（server，核心零耦合）
均通过「接口 + 默认实现 + 组合工厂」存在，core 不感知业务逻辑：

| 模块 | 职责 |
|---|---|
| `server.ts` | 组合根 / HTTP+SSE 路由 / 启动装配 / 优雅停机 |
| `runner.ts` | 按模式（mock/real/real-mcp）组装 agent（`assembleAgent(card?, tenantCtx?, sandboxBackend?)` 收窄工具集） |
| `run-queue.ts` + `queue-backend.ts` | 运行队列（Memory/File/Redis 后端，多副本必须 `REDIS_URL`） |
| `agent-run.ts` | `runAgentTask` 单一入口（workflow/a2a/run-queue 共用 assemble+run） |
| `mcp-manager.ts` | 多 MCP server 单例（共享注册表） |
| `authz.ts` / `sso.ts` | RBAC 矩阵 + 身份源（token/oidc/proxy） |
| `approval.ts` | 审批工作流（`SENSITIVE_ACTIONS`：含 `agent:run:real`/`real-mcp`，bypass 角色默认 admin） |
| `eval.ts` / `verification.ts` | RunRecord 还原 + 评估器 / 三大能力自验证 |
| `retention.ts` / `openapi.ts` | 留存/出境策略 + OpenAPI 契约 |

### 2.6 模块协作时序（一次 `POST /api/run`）

```
客户端 → server.handleRun
  → guard() 鉴权(RBAC) + approval 闸门(agent:run:real 需工单，mock 免审)
  → submit() 写入 RunQueue(QueueBackend)
worker(RunJob) → execute():
  → resolveTenantContext(tenantId) 派 tenantCtx
  → getTaskRouter().resolve(job) 解析目标 AgentCard
       (显式 agentId → 域过滤+评分 → classify → fallback default)
  → assembleAgent(card, tenantCtx, sandboxBackend) 收敛工具/技能/MCP/提示词 + 注入 per-tenant 护栏
  → quotaEngine.admit(tenantId) 配额准入
  → harness.run(input):
       输入护栏 → 记忆 load → 主循环(LLM↔工具↔自愈) → 输出护栏
       → verify 门禁(可选,未过则重跑自愈) → 记忆 save → PII 脱敏
  → quotaEngine.release() + audit 审计
SSE: run:start/step/llm/tool/cost/guardrail/verify/run:end 全程事件流
```

---

## 3. 端到端业务流程：从启动到完整闭环

### 3.1 进程启动（server.ts 装配顺序）
1. `secrets.ts` 装配密钥（env > `SECRETS_FILE` > `.env`）。
2. 顶层读取全部 env（PORT/HOST/`UI_AUTH_TOKEN`/`AUTH_PROVIDER`/`INTENT_ROUTER`/`AGENT_STORE`/`AGENT_AUTO_VERIFY` …）。
3. `mcpManager.init()`（line 206）连接预配置 MCP。
4. `getAgentRegistry()` 首次访问 seed 默认通用 agent；`createAgentStoreFromEnv()` 按 `AGENT_STORE` 选 AgentStore（file/sqlite/volatile/redis）。
5. `policyEngine.registerIndustryProfiles()`（line 1204）注入 finance/medical/healthcare/education 合规基线。
6. `resolveIntentMode()` 决定意图路由（rule/llm/auto）。
7. `isTenantRequired()` 决定 `REQUIRE_TENANT` 强制隔离门禁。
8. `server.listen(PORT, HOST)` 开始接流（listen 前完成注册，杜绝「请求早于就绪」竞态）。

### 3.2 单次 run 自动闭环（执行/数据面）
`AgentHarness.run()`（harness.ts:141）是纯自动循环，路径内**无人工节点**：
`输入护栏 → 记忆 load → 主循环（≤ maxSteps=12，LLM↔工具↔错误自愈） → 输出护栏 → 可选 verify 重跑自愈 → 记忆 save → PII 脱敏返回`。超时（`timeoutMs`）/预算（`tokenBudget`/`costBudget`）熔断保证收口；工具异常作为 tool message 回灌模型自愈。

### 3.3 多步骤工作流闭环
`POST /api/workflows` → `DagEngine.run()`：拓扑分层并行 + 失败逆序补偿 + 检查点续跑；**全自动无人工节点**，且 `workflow:run` 不在审批敏感清单。

### 3.4 跨智能体（A2A）
`POST /api/a2a/tasks` 接收远端任务（card 自注册 + 仅本地 agent 执行 + 回传 `TaskResult`）；run-queue 路由到 `transport:'a2a'+endpoint` 时经 `HttpA2ATransport` 跨主机派发，成功即返回、失败降级本地默认 harness。

### 3.5 闭环的断点（需人/外部接力，均非结构缺失）
- **A 提交闸门**：`agent:run:real`/`real-mcp` 需审批工单（除非 bypass 角色 / 自动过审策略）；`agent:run:mock` 天然闭环。
- **B 跨 run 记忆**：默认 `MEMORY_BACKEND=volatile` 关闭，需 file/sqlite 才跨 run 保留。
- **C shell 确认**：仅 `SHELL_REQUIRE_CONFIRM` 影响 shell 内置工具，行业 agent 多走 MCP 不受影响。
- **D 自检门禁**：`verify` 可选，需注入 `Verifier` 才有质量闭环。
- **E 外部动作**：落地外系统取决于领域 MCP 工具是否齐全/幂等。
> 详见 `../05-analysis/single-agent-closed-loop.md`。

---

## 4. 部署文档

### 4.1 环境依赖
- **Node ≥ 22.13**（引擎要求 22.x；官方运行/构建镜像锁 Node 22）。
- **pnpm ≥ 10**（构建期；生产镜像用 pnpm@10 兼容 Node 22.5 基础镜像，官方环境用 pnpm@11.9）。
- **可选**：Redis（多副本共享运行队列 + AgentStore redis 后端）、Docker（容器化）、Kubernetes（生产弹性）、libseccomp/libcap + 构建工具链（OS 沙箱原生 helper，缺失自动降级）。

### 4.2 构建与运行步骤
```bash
# 本地开发
pnpm install
pnpm -r build          # 拓扑序：core → client → server → webapp/cli → examples
pnpm server            # node packages/server/dist/server.js

# 容器化（多阶段镜像，非 root 运行；HEALTHCHECK → /api/state）
docker build -t agent-harness:local .
docker run -p 4173:4173 \
  -e OPENROUTER_API_KEY=sk-or-... -e UI_AUTH_TOKEN=change-me \
  -e REDIS_URL=redis://redis:6379 \
  agent-harness:local

# 云服务（Render Blueprint）
#   push 到 GitHub(dev) → Render 选 render.yaml → build: pnpm install --no-frozen-lockfile && pnpm -r build
#   start: node packages/server/dist/server.js  →  healthCheckPath: /api/state
```

### 4.3 部署形态选择
| 场景 | 路径 | 文档 |
|---|---|---|
| 本机试用 / 演示 | Compose 内存模式（密钥留空即 Mock） | `../02-deployment/docker-deploy-guide.md` §2 |
| 内网多人低并发 | Compose + Redis + 鉴权 overlay | `../02-deployment/docker-deploy-guide.md` §3、§9 |
| 外部多人 / 高可用 | Kubernetes（kustomize base + overlays/local） | `../02-deployment/k8s-deploy-guide.md` |

> K8s 关键坑（已修复）：健康检查必须为 `/api/state`（非 `/api/v1/state`）；Redis 必须带密码否则多副本走内存队列；记忆持久化用 RWX 卷挂 `/app/data` + `MEMORY_BACKEND=file`。详见 `../02-deployment/k8s-deploy-guide.md`。

### 4.4 配置说明（核心环境变量）
| 分类 | 变量 | 默认 | 说明 |
|---|---|---|---|
| 服务 | `PORT` / `UI_HOST` | 4173 / 0.0.0.0 | 监听端口 / 地址 |
| 鉴权 | `AUTH_PROVIDER` | token | token / oidc / proxy |
| 鉴权 | `UI_AUTH_TOKEN` / `UI_TOKENS` | 空 | 承载令牌；非空即强制鉴权 |
| LLM | `OPENROUTER_API_KEY` | 空(Mock) | 真实 LLM；空则用 Mock |
| LLM | `OPENAI_API_KEY` / `LLM_FAILOVER` | 空 / 非 false | OpenAI 故障转移 secondary |
| 环境平台 | `HARNESS_API_KEY` | 空(dry-run) | Harness.io 环境流水线 |
| MCP | `MCP_SERVER_URL` | 空 | 预连远程 MCP |
| 记忆 | `MEMORY_BACKEND` / `MEMORY_DIR` / `MEMORY_SQLITE_FILE` | volatile | volatile/file/sqlite |
| Agent 注册表 | `AGENT_STORE` / `AGENT_STORE_REDIS_URL` / `REDIS_URL` | volatile | volatile/file/sqlite/redis |
| 运行队列 | `RUN_QUEUE_BACKEND` / `RUN_QUEUE_FILE` | memory | memory/file/redis |
| 路由 | `INTENT_ROUTER` | rule | rule / llm / auto |
| 路由 | `TASK_ROUTER` | on | off 仅显式寻址+兜底 |
| 隔离 | `REQUIRE_TENANT` | false | 行业 agent 无租户即拒绝 |
| 隔离 | `SANDBOX_BACKEND` / `HARNESS_NATIVE_STRICT` | 环境 | container / os / local |
| 自检 | `AGENT_AUTO_VERIFY` / `AGENT_VERIFY_MAX_RETRIES` / `AGENT_COMPLETION_CHECK` | false/0/false | 自动验证门禁 |
| 护栏 | `GUARDRAIL_SENSITIVITY` / `GUARDRAIL_MAX_INPUT` / `GUARDRAIL_SECRET_SCAN` / `GUARDRAIL_INJECTION_SCAN` / `GUARDRAIL_PII` | medium/20000/true/true/true | 全局护栏基线 |
| 配额/运维 | `RUN_CONCURRENCY` / `JOB_TIMEOUT_MS` / `RUN_JOBS_MAX` / `MAX_STEPS` / `MAX_TOKENS_PER_RUN` / `MAX_COST_PER_RUN` | 4/300000/500/12/∞/∞ | 并发/超时/步数/预算 |
| 审批 | `UI_APPROVAL_BYPASS_ROLES` | admin | 可绕过审批的角色 |
| Shell | `SHELL_ENABLED` / `SHELL_REQUIRE_CONFIRM` / `SHELL_ROOT` / `SHELL_WHITELIST` | true/false/cwd/空 | shell 工具开关与边界 |
| 审计/告警 | `AUDIT_LOG` / `ALERT_WEBHOOK_URL` / `RETENTION_DAYS_AUDIT` | 空 | 审计落盘 / 告警 / 留存天数 |

> 完整变量见 `../02-deployment/docker-deploy-guide.md`、`../02-deployment/k8s-deploy-guide.md` 及各 `.env.example`。

---

## 5. 优化建议（基于现状）

1. **生产完全闭环**：real 模式需配审批旁路（`TrustedAgentAutoApproval` 白名单）或走服务账号；务必设 `MEMORY_BACKEND=sqlite` + `AGENT_STORE=redis` + `REQUIRE_TENANT=true`（多行业上线前强制租户隔离）。
2. **横向扩展**：多副本必须 `RUN_QUEUE_BACKEND=redis` + `AGENT_STORE=redis`；记忆跨副本共享需 RWX 卷 + `MEMORY_BACKEND=file`（sqlite 在网络 FS 文件锁不可靠）。
3. **隔离加固**：跨行业不可信 agent 设 `AgentCard.isolation:'os'`（或 `container`），`resolveIsolationBackend` 会自动对跨行业升级最低隔离；OS 沙箱原生 helper 须在 Linux 构建（`build:native.sh`）并实测。
4. **质量门禁**：每个行业 AgentCard 注入领域 `Verifier`，开启 `AGENT_AUTO_VERIFY` 实现产出自愈闭环。
5. **可观测**：接入 OpenTelemetry Collector，用 `run:meta` 的 `agentId/workflowId/traceId/tenantId` 做跨 agent/跨 run 链路追踪与 byTenant 指标。
6. **插件治理**：启用 `plugin/registry` 远程 registry + `signature` 验签，避免运行时加载未签名 AgentCard；registry 持久化（已由 File/Sqlite/Redis 支撑）避免重启丢 agent。

---

## 6. 文档地图

| 文档 | 内容 |
|---|---|
| `./architecture.md`（本文件） | 架构总览 / 分层 / 业务流 / 部署 / 模块协作（权威） |
| `./modules.md` | 模块依赖图（core 内部分组 + 包级依赖） |
| `./execution.md` | `AgentHarness.run` 执行流逐段拆解 |
| `../02-deployment/deployment-index.md` | 部署决策树总入口 |
| `../02-deployment/docker-deploy-guide.md` / `../02-deployment/k8s-deploy-guide.md` | Compose / K8s 完整步骤 |
| `../05-analysis/industry-integration-readiness.md` | 行业智能体对接就绪度 |
| `../05-analysis/single-agent-closed-loop.md` | 单智能体完全闭环可行性 |
| `../02-deployment/os-sandbox.md` | OS 级沙箱设计 |
| `../02-deployment/mcp-services.md` | 远程 MCP 服务清单 |
| `../02-deployment/multi-instance-runbook.md` | 多实例运维手册 |

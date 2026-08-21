# Changelog

本项目遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/) 格式。

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

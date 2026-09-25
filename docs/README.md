# 项目文档中心（docs/）

本目录集中存放 agent-harness 的全部文档，按**主题/功能模块**组织为 `01-architecture`（架构）、
`02-deployment`（部署）、`03-plugins`（插件）、`04-agents`（智能体）、`05-analysis`（分析评估）
五个主分类，另设 `07-rag`（RAG 服务）、`08-others`（专题）、`design`（设计稿）、`proposals`（提案）、
`test`（测试记录）五个辅助目录；配套结构图（SVG）就近放在各分类的 `diagrams/` 子目录。

> 历史重命名：原 `packages/ui` 已重命名为 `access/server`，并拆分为 `server` + `webapp` + `client` + `cli`；
> 根 `README.md` / `DEPLOY.md` / `package.json` / `render.yaml` / `Dockerfile` 均已同步更新。

## 文档导航（按主题）

### 01 架构 · `01-architecture/`

| 文档                                                                           | 内容                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [architecture.md](01-architecture/architecture.md)                             | **权威总览**：分层架构与职责、端到端业务流（启动 → 闭环）、部署与配置、核心模块协作                                                                                                                         |
| [execution.md](01-architecture/execution.md)                                   | `AgentHarness.run()` 执行流、闭环收口机制、超时/取消、运行队列解耦                                                                                                                                          |
| [modules.md](01-architecture/modules.md)                                       | core 内部模块分组与依赖边（含 P0/P1/P2 基座子系统、DB 适配器、计划模式原语）、server 业务层模块、包级依赖                                                                                                   |
| [plan-mode.md](01-architecture/plan-mode.md)                                   | **计划模式**：澄清 → 两段式 propose → 计划桥 DAG 执行 → 交付归档的全链路（代码坐标 / 生命周期 / 关键机制）                                                                                                  |
| [server-modularization-plan.md](01-architecture/server-modularization-plan.md) | server.ts 路由模块化拆分方案（已完成多批次，`routes/` 下 18 个路由模块）                                                                                                                                    |
| [user-provider-key-design.md](01-architecture/user-provider-key-design.md)     | BYOK 用户级凭据设计（**已落地**：AES-GCM 落库、per-run 注入）                                                                                                                                               |
| 配套图                                                                         | [architecture.svg](01-architecture/diagrams/architecture.svg) · [execution-flow.svg](01-architecture/diagrams/execution-flow.svg) · [module-dependency.svg](01-architecture/diagrams/module-dependency.svg) |

### 02 部署 · `02-deployment/`

| 文档                                                                             | 内容                                                                                                            |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| [deployment-index.md](02-deployment/deployment-index.md)                         | 部署决策树总入口（Compose / K8s 选路）                                                                          |
| [deployment-self-hosting.md](02-deployment/deployment-self-hosting.md)           | 自托管部署（Docker / K8s / 镜像 CI）、环境变量清单、SSO、安全清单、密钥管理                                     |
| [docker-deploy-guide.md](02-deployment/docker-deploy-guide.md)                   | Docker Compose 完整流程（内存模式 / Redis+鉴权 overlay）                                                        |
| [k8s-deploy-guide.md](02-deployment/k8s-deploy-guide.md)                         | Kubernetes 完整流程（base + overlays/local）                                                                    |
| [k8s-upgrade-rollback-runbook.md](02-deployment/k8s-upgrade-rollback-runbook.md) | K8s 升级与回滚 Runbook（滚动更新 / 版本回退演练）                                                               |
| [multi-instance-runbook.md](02-deployment/multi-instance-runbook.md)             | 多实例水平扩展与压测 Runbook（Redis 队列、sticky session、故障注入）                                            |
| [database-backends.md](02-deployment/database-backends.md)                       | **数据库后端**：sqlite / turso / MySQL / PostgreSQL 切换矩阵、方言层、租户数据分区、搬迁工具                    |
| [hardening.md](02-deployment/hardening.md)                                       | **加固批次总账**（18 项修复：越权/MCP 校验/队列 503/409、探针接线、损坏 JSON 策略；含新增环境变量表与探针速查） |
| [run-local.md](02-deployment/run-local.md)                                       | 本机一键起服务 + 前端面板（含沙箱绕过、路径坑）                                                                 |
| [mcp-services.md](02-deployment/mcp-services.md)                                 | 可通过 URL 接入的远程 MCP 服务清单与接入方式（含运行时接入校验说明）                                            |
| [os-sandbox.md](02-deployment/os-sandbox.md)                                     | OS 级沙箱（原生 C helper：命名空间/seccomp/capabilities/rlimit）设计                                            |
| [plugin-sandbox-design.md](02-deployment/plugin-sandbox-design.md)               | 插件沙箱设计（插件隔离 / 权限声明）                                                                             |

### 03 插件 · `03-plugins/`

| 文档                                                                                  | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [agent-plugin-architecture.md](03-plugins/agent-plugin-architecture.md)               | 插件架构边界 / 契约 / 复用路径 / 实例化                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| [agent-plugin-er.md](03-plugins/agent-plugin-er.md)                                   | 插件 ER 模型（清单 / 智能体卡 / 注册表）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| [agent-plugin-implementation-plan.md](03-plugins/agent-plugin-implementation-plan.md) | 插件化落地计划（分期、契约实现、验证）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| [customer-service-agent-design.md](03-plugins/customer-service-agent-design.md)       | 智能客服 Agent 设计（**已落地**，`plugins/customer-service/`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| [customer-service-agent-modules.md](03-plugins/customer-service-agent-modules.md)     | 智能客服 Agent 模块拆分（**已落地**）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| [技能开发接入与触发技术方案.md](03-plugins/技能开发接入与触发技术方案.md)             | 技能（Skill）开发接入与触发机制技术方案                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| [技能体系落地执行报告.md](03-plugins/技能体系落地执行报告.md)                         | 技能体系落地执行报告                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| [定时触发演示与说明.md](03-plugins/定时触发演示与说明.md)                             | 备忘提醒 / 定时触发的演示与说明                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 配套图                                                                                | [agent-plugin-architecture.svg](03-plugins/diagrams/agent-plugin-architecture.svg) · [agent-plugin-cs-composition.svg](03-plugins/diagrams/agent-plugin-cs-composition.svg) · [agent-plugin-lifecycle.svg](03-plugins/diagrams/agent-plugin-lifecycle.svg) · [agent-plugin-phases.svg](03-plugins/diagrams/agent-plugin-phases.svg) · [customer-service-agent-architecture.svg](03-plugins/diagrams/customer-service-agent-architecture.svg) · [customer-service-agent-sequence.svg](03-plugins/diagrams/customer-service-agent-sequence.svg) |

### 04 智能体 · `04-agents/`

| 文档                                                                                         | 内容                                                                                                                               |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| [medical-aesthetics-lead-agent.md](04-agents/medical-aesthetics-lead-agent.md)               | 医美行业线索智能体设计（多渠道获客 / 初筛 / 预约 / 留资 / 转人工；外部 RAG 检索；新增的内容生产 / AB 分流 / 咨询师辅助与定时触达） |
| [medical-aesthetics-rollout-checklist.md](04-agents/medical-aesthetics-rollout-checklist.md) | 医美客资 Agent 上线清单                                                                                                            |

### 05 分析与评估 · `05-analysis/`

| 文档                                                                                     | 内容                                                                        |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| [platform-capability-assessment.md](05-analysis/platform-capability-assessment.md)       | 平台能力评估（单智能体执行引擎维度；历史评估，结论以 architecture.md 为准） |
| [platform-orchestration-assessment.md](05-analysis/platform-orchestration-assessment.md) | 多智能体调度/协调维度评估（历史评估，同上）                                 |
| [platform-implementation-plan.md](05-analysis/platform-implementation-plan.md)           | 统一基座平台落地计划（P0/P1/P2，已落地 ✅）                                 |
| [industry-integration-readiness.md](05-analysis/industry-integration-readiness.md)       | 行业智能体对接就绪度（三种 transport + 实测证据）                           |
| [single-agent-closed-loop.md](05-analysis/single-agent-closed-loop.md)                   | 单行业智能体完全闭环可行性（自动闭环 vs 断点）                              |
| [分层架构设计说明.md](05-analysis/分层架构设计说明.md)                                   | core / server / webapp 分层架构与业务语义隔离说明                           |
| [架构落地缺口分析.md](05-analysis/架构落地缺口分析.md)                                   | 架构落地缺口分析（原 14 项缺口已全部落地，留作演进记录）                    |
| 配套图                                                                                   | [目标基座平台架构.svg](05-analysis/diagrams/目标基座平台架构.svg)           |

### 07 RAG · `07-rag/`

| 文档                                                    | 内容                                                                                                                                              |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| [external-rag-design.md](07-rag/external-rag-design.md) | 外部 RAG 服务设计（`services/rag`：默认 HTTP `/v1/retrieve` `/v1/ingest`，可选 MCP stdio，零运行时依赖；嵌入超时与损坏索引自愈见 hardening 批次） |

### 08 专题 · `08-others/`

| 文档                                                                     | 内容                                                              |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| [error-codes.md](08-others/error-codes.md)                               | 错误码文档                                                        |
| [memory-context-compression.md](08-others/memory-context-compression.md) | 记忆与上下文压缩（滑动窗口 + 启发式/LLM 摘要器 + token 成本治理） |
| [design-interaction-modes.md](08-others/design-interaction-modes.md)     | 交互模式设计（含计划模式的交互设计来源）                          |
| [项目架构梳理.md](08-others/项目架构梳理.md)                             | 项目架构梳理笔记                                                  |

### 设计稿 / 提案 / 测试记录

| 目录         | 内容                                                                                                                                                                                                                                                                  |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `design/`    | [plan-mode-multiagent.md](design/plan-mode-multiagent.md)（计划模式多 agent 执行设计源，**已落地**）、[P2-P3-design.md](design/P2-P3-design.md)                                                                                                                       |
| `proposals/` | [memory-scoring-design.md](proposals/memory-scoring-design.md)（记忆评分提案）                                                                                                                                                                                        |
| `test/`      | [P0-TEST-COVERAGE.md](test/P0-TEST-COVERAGE.md)、[P1-SUMMARY.md](test/P1-SUMMARY.md)、[P2-SUMMARY.md](test/P2-SUMMARY.md)、[P3-SUMMARY.md](test/P3-SUMMARY.md)、[im-real-platform-verification.md](test/im-real-platform-verification.md)（各批次测试覆盖与验证记录） |

## 图示速览

- **01-architecture/diagrams/** — 整体架构、执行流、模块依赖（基于当前代码）。
- **03-plugins/diagrams/** — 插件架构、生命周期、分期、客服 Agent 组成与序列。
- **05-analysis/diagrams/** — 目标基座平台架构。

## 仓库结构（当前）

```
agent-harness/                # pnpm monorepo
├─ frontend/                 # 前端应用层
│  ├─ webapp/                # Lit + Vite SPA（工作台 / 运行面板 / Chat 计划模式 UI）
│  └─ cli/                   # 运维/CI 命令行（ah）
├─ mobile/                   # Capacitor 移动端壳（iOS/Android，包裹 webapp 构建产物）
├─ access/                   # 接入层
│  └─ server/                # HTTP+SSE 服务（src/routes/ 下 18 个路由模块 + 业务层模块）
├─ backend/                  # 后端工具层
│  ├─ core/                  # 核心框架库（含多智能体基座、DB 适配器、计划模式原语）
│  ├─ client/                # 零依赖 HTTP+SSE 客户端 SDK（Web/Node/Edge）
│  └─ medical-ad-guard/      # 可复用领域合规库（医疗广告法）
├─ plugins/                  # 业务插件（非侵入，跨层复用）
│  ├─ medical-aesthetics-lead/   医美客资业务插件（已落地）
│  ├─ customer-service/          智能客服业务插件（已落地）
│  └─ memo/                      备忘提醒插件（已落地）
├─ services/rag/             # 外部 RAG 服务（向量检索）
├─ examples/                 # CLI 示例（basic / chat / multi-agent / workflow / os-sandbox …）
├─ deploy/k8s/               # K8s 清单（kustomize base + overlays/local）+ monitoring 栈
├─ Dockerfile · docker-compose.yml · docker-compose.redis.yml · render.yaml
├─ docs/                     # 统一文档中心（见上方导航）
└─ tsconfig.base.json · pnpm-workspace.yaml
```

## 整合与重命名说明（历史）

| 类型     | 说明                                                                               |
| -------- | ---------------------------------------------------------------------------------- |
| 分类归集 | 文档按主题归入 `01~08` + `design` / `proposals` / `test` 目录，消除零散分布        |
| 命名规范 | 原 UPPERCASE 统一改为 kebab-case；修正 `agent-orchestrattion-*` 等拼写             |
| 去重     | 删除与 md 重复的 html 版本                                                         |
| 旧名更名 | `DEPLOY.md`→`deployment-index.md`、`deployment.md`→`deployment-self-hosting.md` 等 |
| 图示就近 | SVG 移入各自分类的 `diagrams/` 子目录                                              |

## 过时文档提示

- `05-analysis/platform-capability-assessment.md` 与 `platform-orchestration-assessment.md`
  的"注册/路由/隔离/协议/编排缺失"评级已**不适用**——这些能力现已全部实现并接入 server 运行链路。
  当前结论以 `01-architecture/architecture.md`（权威总览）与 `01-architecture/plan-mode.md` 为准；
  旧评估仅为演进史参考，请勿据其做架构判断。
- 早期 `*.svg` 结构图未包含 DB 适配器 / 计划模式等较新模块；**文本文档（architecture.md / modules.md）为当前权威**，SVG 待刷新。

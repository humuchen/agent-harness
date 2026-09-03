# 项目文档中心（docs/）

本目录集中存放 agent-harness 的全部文档，已按**主题/功能模块**归并为 5 类，采用统一的 `01-`/`02-`… 数字前缀 + kebab-case 命名，配套结构图（SVG）就近放在各自分类下的 `diagrams/` 子目录。所有图表基于**当前代码实际结构**整理。

> 历史重命名：原 `packages/ui` 已重命名为 `access/server`，并拆分为 `server` + `webapp` + `client` + `cli`；根 `README.md` / `DEPLOY.md` / `package.json` / `render.yaml` / `Dockerfile` 均已同步更新。

## 文档导航（按主题）

### 01 架构 · `01-architecture/`
| 文档 | 内容 |
|---|---|
| [architecture.md](01-architecture/architecture.md) | **权威总览**：分层架构与职责、端到端业务流（启动→闭环）、部署与配置、核心模块协作 |
| [execution.md](01-architecture/execution.md) | `AgentHarness.run()` 执行流、闭环收口机制、超时/取消、运行队列解耦 |
| [modules.md](01-architecture/modules.md) | core 内部模块分组与依赖边（含 P0/P1/P2 基座子系统）、server 业务层模块、包级依赖 |
| 配套图 | [architecture.svg](01-architecture/diagrams/architecture.svg) · [execution-flow.svg](01-architecture/diagrams/execution-flow.svg) · [module-dependency.svg](01-architecture/diagrams/module-dependency.svg) |

### 02 部署 · `02-deployment/`
| 文档 | 内容 |
|---|---|
|| [deployment-index.md](02-deployment/deployment-index.md) | 部署决策树总入口（Compose / K8s 选路） |
|| [deployment-self-hosting.md](02-deployment/deployment-self-hosting.md) | 自托管部署（Docker / K8s / 镜像 CI）、环境变量清单、SSO、安全清单、密钥管理 |
|| [docker-deploy-guide.md](02-deployment/docker-deploy-guide.md) | Docker Compose 完整流程（内存模式 / Redis+鉴權 overlay） |
| [k8s-deploy-guide.md](02-deployment/k8s-deploy-guide.md) | Kubernetes 完整流程（base + overlays/local） |
| [multi-instance-runbook.md](02-deployment/multi-instance-runbook.md) | 多实例水平扩展与压测 Runbook（Redis 队列、sticky session、故障注入） |
| [run-local.md](02-deployment/run-local.md) | 本机一键起服务 + 前端面板（含沙箱绕过、路径坑） |
| [mcp-services.md](02-deployment/mcp-services.md) | 可通过 URL 接入的远程 MCP 服务清单与接入方式 |
| [os-sandbox.md](02-deployment/os-sandbox.md) | OS 级沙箱（原生 C helper：命名空间/seccomp/capabilities/rlimit）设计 |

### 03 插件 · `03-plugins/`
| 文档 | 内容 |
|---|---|
| [agent-plugin-architecture.md](03-plugins/agent-plugin-architecture.md) | 插件架构边界 / 契约 / 复用路径 / 实例化 |
| [agent-plugin-er.md](03-plugins/agent-plugin-er.md) | 插件 ER 模型（清单 / 智能体卡 / 注册表） |
| [agent-plugin-implementation-plan.md](03-plugins/agent-plugin-implementation-plan.md) | 插件化落地计划（分期、契约实现、验证） |
| [customer-service-agent-design.md](03-plugins/customer-service-agent-design.md) | 智能客服 Agent 设计（**已落地**，`plugins/customer-service/`） |
| [customer-service-agent-modules.md](03-plugins/customer-service-agent-modules.md) | 智能客服 Agent 模块拆分（**已落地**） |
| 配套图 | [agent-plugin-architecture.svg](03-plugins/diagrams/agent-plugin-architecture.svg) · [agent-plugin-cs-composition.svg](03-plugins/diagrams/agent-plugin-cs-composition.svg) · [agent-plugin-lifecycle.svg](03-plugins/diagrams/agent-plugin-lifecycle.svg) · [agent-plugin-phases.svg](03-plugins/diagrams/agent-plugin-phases.svg) · [customer-service-agent-architecture.svg](03-plugins/diagrams/customer-service-agent-architecture.svg) · [customer-service-agent-sequence.svg](03-plugins/diagrams/customer-service-agent-sequence.svg) |

### 04 智能体 · `04-agents/`
| 文档 | 内容 |
|---|---|
| [medical-aesthetics-lead-agent.md](04-agents/medical-aesthetics-lead-agent.md) | 医美行业线索智能体（行业落地示例，复用 run-local / 插件架构） |

### 05 分析与评估 · `05-analysis/`
| 文档 | 内容 |
|---|---|
| [platform-capability-assessment.md](05-analysis/platform-capability-assessment.md) | 平台能力评估（单智能体执行引擎维度） |
| [platform-orchestration-assessment.md](05-analysis/platform-orchestration-assessment.md) | 多智能体调度/协调维度评估 |
| [platform-implementation-plan.md](05-analysis/platform-implementation-plan.md) | 统一基座平台落地计划（P0/P1/P2，已落地 ✅） |
| [industry-integration-readiness.md](05-analysis/industry-integration-readiness.md) | 行业智能体对接就绪度（三种 transport + 实测证据） |
| [single-agent-closed-loop.md](05-analysis/single-agent-closed-loop.md) | 单行业智能体完全闭环可行性（自动闭环 vs 断点） |
| 配套图 | [目标基座平台架构.svg](05-analysis/diagrams/目标基座平台架构.svg) |

## 图示速览

- **01-architecture/diagrams/** — 整体架构、执行流、模块依赖（基于当前代码）。
- **03-plugins/diagrams/** — 插件架构、生命周期、分期、客服 Agent 组成与序列。
- **05-analysis/diagrams/** — 目标基座平台架构。

## 整合与重命名说明

本轮整合做的主要变更：

| 类型 | 说明 |
|---|---|
| 分类归集 | 34 份文档按 5 大主题归入 `01-architecture` / `02-deployment` / `03-plugins` / `04-agents` / `05-analysis`，消除零散分布 |
| 命名规范 | 原 UPPERCASE（如 `AGENT_PLATFORM_IMPLEMENTATION_PLAN.md`）统一改为 kebab-case；修正两处拼写错误 `agent-orchestrattion-*`→`platform-orchestration-assessment.md`、`agent-platform-implementattion-*`→`platform-implementation-plan.md` |
| 去重 | 删除 `agent-plugin-er.html`（与 `agent-plugin-er.md` 内容重复） |
| 旧名更名 | `DEPLOY.md`→`deployment-index.md`、`deployment.md`→`deployment-self-hosting.md`、`architecture-capability-assessment.md`→`platform-capability-assessment.md`、`industry_agent_integration_readiness.md`→`industry-integration-readiness.md`、`single_agent_closed_loop_analysis.md`→`single-agent-closed-loop.md` |
| 图示就近 | 原顶层 `diagrams/` 删除，SVG 移入各自分类的 `diagrams/` 子目录 |

仓库根目录原先散落 `README.md` / `DEPLOY.md` / `MCP_SERVICES.md` / `MULTI_INSTANCE_RUNBOOK.md` 等文档，本轮已将部署、MCP 服务、多实例 Runbook 统一整合进本 `docs/` 目录，根目录仅保留 `README.md` 作为仓库入口。

## 过时文档与图表提示

- **`ARCHITECTURE_CAPABILITY_ASSESSMENT.md`** 与 **`AGENT_ORCHESTRATION_PLATFORM_ASSESSMENT.md`** 的"注册/路由/隔离/协议/编排缺失"评级已**不适用**——这些能力现已全部实现并接入 server 运行链路。当前结论以 `01-architecture/architecture.md`（权威总览）、`05-analysis/industry-integration-readiness.md`、`05-analysis/single-agent-closed-loop.md` 为准；旧评估仅为演进史参考，请勿据其做架构判断。
- 早期 `*.svg` 结构图未包含 `agents/router/tenant/policy/workflow/a2a/plugin/sandbox/quota/audit` 等基座子系统；**文本文档（architecture.md / modules.md）为当前权威**，SVG 待刷新。

## 仓库结构（当前）

```
agent-harness/                # pnpm monorepo
├─ frontend/                 # 前端应用层
│  ├─ webapp/                # Lit + Vite SPA（运行时面板 / Playground）
│  └─ cli/                   # 运维/CI 命令行（ah）
├─ access/                   # 接入层
│  └─ server/                # HTTP+SSE 服务入口（access/server）
├─ backend/                  # 后端工具层
│  ├─ core/                  # 核心框架库
│  ├─ client/                # 零依赖 HTTP+SSE 客户端 SDK
│  └─ medical-ad-guard/      # 可复用领域合规库（医疗广告法）
├─ plugins/                  # 业务插件（非侵入，跨层复用）
│  ├─ medical-aesthetics-lead/   医美客资业务插件（已落地）
│  └─ customer-service/          智能客服业务插件（已落地）
├─ services/rag/             # 外部 RAG 服务（向量检索）
├─ examples/                多个 CLI 示例（basic / chat / multi-agent / workflow-demo / medspa-agent / os-sandbox …）
├─ deploy/k8s/              K8s 清单（kustomize base + overlays/local）
├─ Dockerfile · docker-compose.yml · docker-compose.redis.yml · render.yaml
├─ docs/                    统一文档中心（见上方 5 类导航）
└─ tsconfig.base.json · pnpm-workspace.yaml
```

# 项目文档中心（docs/）

本目录集中存放 agent-harness 的架构、执行流、模块依赖与部署相关文档。所有图表基于**当前代码实际结构**整理；原 `packages/ui` 已重命名为 `packages/server`，根 `README.md` / `DEPLOY.md` / `render.yaml` 已同步更新，详见[历史重命名说明](#历史重命名说明已落地)。

## 文档导航

| 文档 | 内容 | 配套图 |
|---|---|---|
| [architecture.md](./architecture.md) | **权威总览**：分层架构与职责、端到端业务流（启动→闭环）、部署与配置、核心模块协作 | [diagrams/architecture.svg](./diagrams/architecture.svg) |
| [execution.md](./execution.md) | `AgentHarness.run()` 执行流、闭环收口机制、超时/取消、运行队列解耦 | [diagrams/execution-flow.svg](./diagrams/execution-flow.svg) |
| [modules.md](./modules.md) | core 内部模块分组与依赖边（含 P0/P1/P2 基座子系统）、server 业务层模块、包级依赖 | [diagrams/module-dependency.svg](./diagrams/module-dependency.svg) |
| [DEPLOY.md](./DEPLOY.md) | 部署决策树总入口（Compose / K8s 选路） |
| [deployment.md](./deployment.md) | 自托管部署（Docker / K8s / 镜像 CI）、环境变量清单、SSO、安全清单、密钥管理 |
| [docker-deploy-guide.md](./docker-deploy-guide.md) | Docker Compose 完整流程（内存模式 / Redis+鉴权 overlay） |
| [k8s-deploy-guide.md](./k8s-deploy-guide.md) | Kubernetes 完整流程（base + overlays/local） |
| [mcp-services.md](./mcp-services.md) | 可通过 URL 接入的远程 MCP 服务清单与接入方式 |
| [multi-instance-runbook.md](./multi-instance-runbook.md) | 多实例水平扩展与压测 Runbook（Redis 队列、sticky session、故障注入） |
| [os-sandbox.md](./os-sandbox.md) | OS 级沙箱（原生 C helper：命名空间/seccomp/capabilities/rlimit）设计 |
| [AGENT_PLATFORM_IMPLEMENTATION_PLAN.md](./AGENT_PLATFORM_IMPLEMENTATION_PLAN.md) | 统一基座平台落地计划（P0/P1/P2，已落地 ✅） |
| [INDUSTRY_AGENT_INTEGRATION_READINESS.md](./INDUSTRY_AGENT_INTEGRATION_READINESS.md) | 行业智能体对接就绪度（三种 transport + 实测证据） |
| [SINGLE_AGENT_CLOSED_LOOP_ANALYSIS.md](./SINGLE_AGENT_CLOSED_LOOP_ANALYSIS.md) | 单行业智能体完全闭环可行性（自动闭环 vs 断点） |

## 图示速览（diagrams/）

- **architecture.svg** — 整体架构：monorepo 的 5 个包 + examples，及其与外部集成（OpenRouter / OpenAI / Harness.io / MCP / K8s / OTel / Redis）的关系。
- **execution-flow.svg** — `run()` 控制流：从输入护栏、记忆加载、主循环（LLM↔工具↔记忆）、预算/护栏/取消，到持久化与 PII 脱敏的完整闭环。
- **module-dependency.svg** — 模块依赖：core 内部模块分组依赖（带 leaf 标记）+ 包级依赖。

## 文档整合与重命名说明

仓库根目录原先散落 `README.md` / `DEPLOY.md` / `MCP_SERVICES.md` / `MULTI_INSTANCE_RUNBOOK.md` 等文档。本轮已将部署、MCP 服务、多实例 Runbook 统一整合进本 `docs/` 目录（见上方导航），根目录仅保留 `README.md` 作为仓库入口。

此外，`packages/ui` 已重命名为 `packages/server`，并拆分为 `server` + `webapp` + `client` + `cli`。根文档与配置均已同步更新，以下为对照：

| 位置 | 旧 | 当前 |
|---|---|---|
| `render.yaml` `startCommand` | `node packages/ui/dist/server.js` | `node packages/server/dist/server.js` ✅ |
| 根 `package.json` 脚本 `ui` | `@agent-harness/ui` | `@agent-harness/server`（脚本名 `server`）✅ |
| `README.md` / `DEPLOY.md` 中 `packages/ui/...` | — | `packages/server/...`（及 webapp/client/cli）✅ |

## 过时文档与图表提示

- **`ARCHITECTURE_CAPABILITY_ASSESSMENT.md`** 与 **`AGENT_ORCHESTRATION_PLATFORM_ASSESSMENT.md`** 写于 P0/P1/P2 基座能力落地**之前**，其"注册/路由/隔离/协议/编排缺失"评级已**不适用**——这些能力现已全部实现并接入 server 运行链路。结论以 `architecture.md`（权威总览）、`INDUSTRY_AGENT_INTEGRATION_READINESS.md`、`SINGLE_AGENT_CLOSED_LOOP_ANALYSIS.md` 为准。两份旧评估可保留作演进史参考，但请勿据其做架构判断。
- **`diagrams/*.svg`** 为早期结构图，未包含 `agents/router/tenant/policy/workflow/a2a/plugin/sandbox/quota/audit` 等基座子系统；**文本文档（`architecture.md` / `modules.md`）为当前权威**，SVG 待刷新。

## 仓库结构（当前）

```
agent-harness/
├─ packages/{core,server,webapp,client,cli}
├─ examples/            10 个 CLI 示例
├─ deploy/k8s/          K8s 清单（kustomize）
├─ Dockerfile · docker-compose.yml · render.yaml
├─ docs/                统一文档中心（架构 / 执行 / 模块 / 部署 / MCP / Runbook）
└─ tsconfig.base.json · pnpm-workspace.yaml
```

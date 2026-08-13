# 项目文档中心（docs/）

本目录集中存放 agent-harness 的架构、执行流、模块依赖与部署相关文档。所有图表基于**当前代码实际结构**整理；原 `packages/ui` 已重命名为 `packages/server`，根 `README.md` / `DEPLOY.md` / `render.yaml` 已同步更新，详见[历史重命名说明](#历史重命名说明已落地)。

## 文档导航

| 文档 | 内容 | 配套图 |
|---|---|---|
| [architecture.md](./architecture.md) | 仓库形态、5 个包职责与依赖、外部集成、设计原则落点 | [diagrams/architecture.svg](./diagrams/architecture.svg) |
| [execution.md](./execution.md) | `AgentHarness.run()` 执行流、关注点接入机制、超时/取消、运行队列解耦 | [diagrams/execution-flow.svg](./diagrams/execution-flow.svg) |
| [modules.md](./modules.md) | core 内部模块分组与依赖边、server 业务层模块、包级依赖 | [diagrams/module-dependency.svg](./diagrams/module-dependency.svg) |
| [deployment.md](./deployment.md) | 自托管部署（Docker / K8s / 镜像 CI）、环境变量清单、SSO、安全清单、密钥管理 |
| [mcp-services.md](./mcp-services.md) | 可通过 URL 接入的远程 MCP 服务清单与接入方式 |
| [multi-instance-runbook.md](./multi-instance-runbook.md) | 多实例水平扩展与压测 Runbook（Redis 队列、sticky session、故障注入） |

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

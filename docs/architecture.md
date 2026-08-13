# 架构总览

> 配套图：`diagrams/architecture.svg`
> 范围：当前代码实际结构（5 个包 + examples）。原 `packages/ui` 已重命名为 `packages/server`，并拆分为 `server` + `webapp` + `client` + `cli`；根 `README.md` / `DEPLOY.md` / `render.yaml` 已同步更新，见[历史重命名说明](#历史重命名说明已落地)。

## 1. 仓库形态

`agent-harness` 是一个 **pnpm monorepo**，对外服务能力由 `packages/server` 的 HTTP+SSE 服务进程提供。设计目标：单一可替换的 LLM 契约、零硬运行时依赖（OTel 可选）、工具错误自愈、护栏先行。

```
agent-harness/
├─ packages/
│  ├─ core/       @agent-harness/core   框架库（零运行时依赖）
│  ├─ server/     @agent-harness/server Web Playground（node:http + SSE）
│  ├─ webapp/     @agent-harness/webapp Lit + Vite SPA 前端
│  ├─ client/     @agent-harness/client 零依赖 HTTP SDK（对 /api/v1 建模）
│  └─ cli/        @agent-harness/cli    Node CLI `ah`（基于 client）
├─ examples/      10 个 CLI 示例（消费 core）
├─ deploy/k8s/    K8s 清单（kustomize）
├─ Dockerfile · docker-compose.yml · render.yaml
├─ docs/                统一文档中心（架构 / 执行 / 模块 / 部署 / MCP / Runbook）
└─ tsconfig.base.json · pnpm-workspace.yaml
```

## 2. 包职责与依赖

| 包 | 入口 | 职责 | 依赖 |
|---|---|---|---|
| `@agent-harness/core` | `dist/index.js` | Agent 框架原语：harness / tools / memory / guardrails / telemetry / llm / integrations / builtins / skills | 仅 Node 内置 + `@modelcontextprotocol/sdk`（硬依赖） |
| `@agent-harness/server` | `dist/server.js` | 组合根：HTTP+SSE 仪表盘、运行队列、MCP 管理、环境治理、RBAC/审批/评估/留存 | core |
| `@agent-harness/webapp` | Vite 产物（同源托管） | Lit SPA，消费 client SDK | client |
| `@agent-harness/client` | `dist/index.js` | 零依赖 HTTP+SSE 客户端，对 `/api/v1` 建模 | （仅调用 server HTTP API，不 import core） |
| `@agent-harness/cli` | `dist/cli.js` (`bin: ah`) | 运维/CI 命令行 | client |
| `examples` | 多个 `.ts` | 示例：basic / chat / multi-mcp / real-loop / self-serve-env / shell / use-context7 / verify-* | core |

**依赖方向**：`server → core`，`webapp → client → server(/api/v1)`，`cli → client`，`examples → core`。

**构建顺序**（`pnpm -r build` 按 workspace 拓扑）：`core → client → server → webapp / cli → examples`。跨包 tsconfig `paths` 指向兄弟包 `dist/index.d.ts`，因此必须先构建被依赖方。

## 3. 外部集成

| 集成 | 位置 | 必填 | 说明 |
|---|---|---|---|
| **OpenRouter** | `core/src/llm/openrouter.ts` | 可选（默认 LLM） | 需 `OPENROUTER_API_KEY`；基于原生 fetch，零额外 npm 依赖 |
| **OpenAI** | `core/src/llm/openai.ts` | 可选 | `createFailoverLLM` 的 secondary；需 `OPENAI_API_KEY` |
| **Harness.io** | `core/src/integrations/harness-client.ts` | 可选 | 无 key 时 dry-run；`ENV_PLATFORM=harness` 默认 |
| **MCP 服务** | `core/src/integrations/mcp/placeholder.ts` | SDK 为硬依赖 | `@modelcontextprotocol/sdk`；配即激活（stdio/SSE/StreamableHTTP） |
| **Kubernetes** | `core/src/integrations/k8s-env-platform.ts` | 可选 | `@kubernetes/client-node`（optional）；`ENV_PLATFORM=k8s` |
| **OpenTelemetry** | `core/src/telemetry.ts` | 可选 | `@opentelemetry/api`（optional）；缺则降级为内存快照 |
| **Redis** | `server/src/queue-backend.ts` | 可选 | `ioredis`（optional）；多副本运行队列后端 |

## 4. 设计原则落点

- **单一可替换契约**：任意 LLM 后端实现 `LLM = (messages, toolSchemas, opts) => Promise<{content, tool_calls}>` 即可接入。
- **零硬运行时依赖**：核心只用 Node 内置 API；OTel / K8s / Redis 缺失即降级。
- **工具错误即自愈**：工具抛错作为 tool result 回灌模型，模型可重试或换路。
- **护栏先行**：输入 / 输出 / 工具参数三层检查，出口统一 PII 脱敏。
- **业务策略与核心解耦**：鉴权(RBAC)/审批/评估/版本化/留存/合规全部在 `server` 业务层以「接口 + 默认实现 + 组合工厂」存在，核心 `core` 零业务耦合。

## 5. 历史重命名说明（已落地）

原 `packages/ui` 已重命名为 `packages/server`，并进一步拆分为 `server` + `webapp` + `client` + `cli`。根 `README.md` / `DEPLOY.md` / `render.yaml` / `package.json` 脚本均已同步更新，以下为对照：

| 旧写法 | 当前代码 | 状态 |
|---|---|---|
| `packages/ui` | `packages/server` + `packages/webapp` + `packages/client` + `packages/cli` | ✅ 根文档与 `render.yaml` 已更新 |
| `render.yaml` `startCommand: node packages/ui/dist/server.js` | `node packages/server/dist/server.js` | ✅ 已修正 |
| 根 `package.json` 脚本 `"ui": "... @agent-harness/ui run start"` | `"server": "... @agent-harness/server run start"` | ✅ 已修正 |

> 本 `docs/` 目录均基于实际代码。若仍有 `packages/ui` 残留，请统一改为 `packages/server`（及新增的 webapp/client/cli）。

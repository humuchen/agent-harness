# 项目长期记忆 · agent-harness

## 项目定位
最小化、可直接运行的 TypeScript AI Agent harness 骨架（**pnpm monorepo**）。对标 Python 版 `agent-harness` 重写。
零硬运行时依赖（除 MCP SDK），OTel 为可选依赖。

## 仓库结构（monorepo，截至 2026-08-11）
- `packages/core/` → `@agent-harness/core`：框架库。harness / tools / memory / guardrails / telemetry / types / llm(OpenRouter+OpenAI) / integrations(harness-client, mcp)。`main`→`dist/index.js`，`types`→`dist/index.d.ts`。
- `packages/ui/` → `@agent-harness/ui`：Web playground。`src/server.ts`(node:http + SSE 仪表盘，默认 4173，读取 `PORT`/`UI_PORT`)、runner / verification / mcp-manager / env-pipeline。`public/index.html` 为免构建单文件前端。
- `examples/` → `@agent-harness/examples`：8 个 CLI 示例，消费 `@agent-harness/core` workspace 包。
- 根：`pnpm-workspace.yaml`、`tsconfig.base.json`(target ES2022 / CommonJS / Node / declaration)、`render.yaml`(Blueprint，buildCommand `pnpm install && pnpm -r build`，start `node packages/ui/dist/server.js`)。

## 关键设计约定
- **本地跨包解析**：UI/examples 的 tsconfig 用 `paths` 把 `@agent-harness/core` 指向 `packages/core/dist/index.d.ts`（已构建产物），避免 `rootDir` 与 `paths` 拉入源码触发 `TS6059`；`pnpm -r build` 按拓扑序先构建 core 再构建 ui/examples。
- 一切降级可用：无 `OPENROUTER_API_KEY` → mock LLM；无 `HARNESS_API_KEY` → dry-run；无 MCP 配置 → 静默跳过。
- 工具抛错不中断，错误文本作为 tool message 回灌模型自愈。
- MCP 多 server 工具以 `<server>__<tool>` 前缀注册；护栏/记忆/追踪自动覆盖 MCP 工具，主循环零改动。
- `onEvent` 是纯旁路观测通道，UI 和测试靠它，不侵入业务逻辑。

## 工程现状（截至 2026-08-11）
- git 分支 `dev`，monorepo 重构已于 commit `2a4b4c7` 提交并推送 origin/dev。
- 包管理器统一为 pnpm@11.9.0（已删除 package-lock.json，仅留 pnpm-lock.yaml）。
- 部署：Render Blueprint `render.yaml`（free plan / oregon / healthCheckPath `/api/state`）。CI 见 `.github/workflows/deploy.yml`（cache: pnpm，build `pnpm -r build`，上传 `packages/ui/public`）。
- 注意：本沙箱 `pnpm install` 被 safe-delete 守卫拦截，无法本地装依赖；验证改用直接 `tsc` 构建 + 手动建 `node_modules/@agent-harness/core` 符号链接模拟 pnpm workspace 链接。

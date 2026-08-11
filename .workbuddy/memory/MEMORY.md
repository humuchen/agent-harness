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

## 优化项（2026-08-11 全部完成，commit `50231ba` 推送 dev）
原 8 个待优化点已落地：
1. **UI 鉴权**：`packages/ui/src/server.ts` 增加 `UI_AUTH_TOKEN` 承载令牌校验，保护 `/api/run`、`/api/verify`、`/api/mcp/add`、`/api/env`、`/api/mcp/list`；`/api/state` 与静态页保持开放（供 Render 健康检查）。未配置则开放并告警。SIGINT/SIGTERM 触发 `mcpManager.shutdown()` 清理 MCP 连接。
2. **长期记忆接入**：`memory.systemContext()` 注入系统提示词；`AgentHarness.remember()/notes()` 入口；配置 `persistencePath` 时 `run()` 自动 `load`/`save`。`memory.hasPersistence` getter 控制开关。
3. **Harness 超时/取消**：`HarnessOptions.timeoutMs` + `signal`；`run()` 用 `AbortController` 组合信号，`Promise.race` 打断挂起 LLM 调用，中止时返回 `[timeout]`/`[aborted]` 提示。
4. **LLM 适配器去重**：抽出 `packages/core/src/llm/shared.ts`（`toOpenAIMessage`/`safeParseArgs`/`callOpenAIChat`，含 429/5xx + 退化响应重试）；`openrouter.ts`/`openai.ts` 改为薄封装。`LLM` 契约新增第三可选参数 `LLMCallOptions { signal? }`，透传到 fetch。
5. **护栏扩展**：`guardrails.ts` 新增 `INJECTION_PATTERNS`（提示词注入启发式）+ `registerInputRule` 可扩展规则，覆盖 input/output。
6. **envUrl 可配置**：`HarnessClient` 用 `envUrlTemplate`（`HARNESS_ENV_URL_TEMPLATE`，默认 `https://{envId}.preview.internal`）替换四处硬编码占位符。
7. **MCP 连接生命周期**：`placeholder.ts` 维护 `liveClients` 注册表，`connectMcpServer`/`registerMcpTools` 存引用，新增 `disconnectMcpServer`/`disconnectAllMcp`；`ToolRegistry.unregister` 配合清理。
8. **测试套件**：`packages/core/test/*.test.cjs`（node:test + node:assert，零依赖，require 编译后的 dist 叶子模块避免触碰 MCP SDK），27 用例全过；core `package.json` 增 `test` 脚本。

## 验证命令（沙箱本地）
- 构建：`tsc -p packages/core/tsconfig.json && tsc -p packages/ui/tsconfig.json && tsc -p examples/tsconfig.json`
- 测试：`cd packages/core && node --test test/*.test.cjs`（注意：`node --test test/` 会把目录当模块报错，必须用显式文件通配）
- UI 冒烟：`node packages/ui/dist/server.js`，`/api/state` 与 `/` 应 200，`/api/run` mock SSE 正常。


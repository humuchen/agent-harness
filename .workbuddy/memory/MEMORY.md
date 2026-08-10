# 项目长期记忆 · agent-harness

## 项目定位
最小化、可直接运行的 TypeScript AI Agent harness 骨架。对标 Python 版 `agent-harness` 重写。
约 2784 行 TS（src + examples），零硬运行时依赖（除 MCP SDK），OTel 为可选依赖。

## 架构三层
- **核心** `src/`：`harness.ts`（AgentHarness 编排循环，maxSteps 默认 12，onEvent 发 HarnessEvent）、
  `tools.ts`（ToolRegistry + mergeFrom）、`memory.ts`（滑动窗口默认 20 + 长期记忆 + 可选 JSON 持久化）、
  `guardrails.ts`（输入/输出/工具参数三层，正则拦密钥、限长 20000）、`telemetry.ts`（OTel 缺失自动 no-op）、
  `types.ts`（核心契约 `LLM = (messages, tools) => Promise<{content, tool_calls}>`）。
- **接入层** `src/llm`（OpenRouter 为默认，OpenAI 兼容备选）、
  `src/integrations/harness-client.ts`（Harness NG 流水线 API + 状态轮询，无 key 自动 dry-run）、
  `src/integrations/mcp/placeholder.ts`（真实 MCP 客户端，支持 Streamable HTTP / SSE / stdio，已接 Context7）。
- **入口层** `examples/`（8 个 CLI 示例与验证脚本）、`src/ui` + `public/index.html`
  （零依赖 node:http + SSE 仪表盘，默认 4173 端口）。

## 关键设计约定
- 一切降级可用：无 OPENROUTER_API_KEY → mock LLM；无 HARNESS_API_KEY → dry-run 打印将发出的 API 调用；无 MCP 配置 → 静默跳过。
- 工具抛错不中断，错误文本作为 tool message 回灌模型自愈。
- MCP 多 server 工具以 `<server>__<tool>` 前缀注册避免冲突；护栏/记忆/追踪自动覆盖 MCP 工具，主循环零改动。
- `onEvent` 是纯旁路观测通道，UI 和测试靠它，不侵入业务逻辑。

## 工程现状（截至 2026-08-10）
- git 分支 `dev`，工作区有未提交改动（已在本地修复 CI 部署问题，尚未 commit/push）。
- **CI 部署已修复**：`deploy.yml` 现在先 `npm ci` + `npm run build` + 内联 JS 校验再做 Pages 发布；
  新增 `ci.yml` 跑类型检查与离线验证。GitHub Pages 只承载静态 `public/`，
  前端在探测不到 `/api/*` 时自动切「静态演示模式」（浏览器内复刻真实 SSE 事件流，见 `window.HarnessDemo`）。
- 本地 `npm ci` 已完成，可直接 `npm run build` / `npm run ui` / `npm run verify:harness`。
- 仓库同时存在 package-lock.json 与 pnpm-lock.yaml，包管理器口径不统一（待清理）。

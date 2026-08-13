# 项目长期记忆 · agent-harness

## 项目定位
最小化、可直接运行的 TypeScript AI Agent harness 骨架（**pnpm monorepo**）。对标 Python 版 `agent-harness` 重写。
零硬运行时依赖（除 MCP SDK），OTel 为可选依赖。

## 仓库结构（monorepo，截至 2026-08-13）
> 早期记忆误记为 `packages/ui`，实际包名如下（Dockerfile/compose/render 均引用 `packages/server/dist/server.js`）。
- `packages/core/` → `@agent-harness/core`：框架库。harness / tools / memory / guardrails / telemetry / types / llm(OpenRouter+OpenAI) / integrations(harness-client, mcp)。
- `packages/server/` → `@agent-harness/server`：HTTP+SSE 服务（运行时面板后端）。`src/server.ts`、`src/runner.ts`、`src/queue-backend.ts`。入口 `node packages/server/dist/server.js`。
- `packages/webapp/` → `@agent-harness/webapp`：Vite+Lit 前端面板，构建产物 `packages/webapp/dist`，server 优先托管。
- `packages/client/` → `@agent-harness/client`；`packages/cli/` → `@agent-harness/cli`。
- `examples/` → `@agent-harness/examples`：CLI 示例。
- 部署：`Dockerfile`(多阶段 node:22, 非 root `ah`)、`docker-compose.yml`+`docker-compose.redis.yml`(overlay)、`render.yaml`(free plan/oregon)、`deploy/k8s/`(kustomize: ns/cm/secret/deploy/svc/ingress/hpa/redis/pvc)、`deploy/overlays/local/`(NodePort 31473 本地验证)。

## 记忆后端（重要，2026-08-13 核实）
`packages/core/src/memory-store.ts` 仅内置三种 `MemoryStore`：**volatile(内存) / file(JSON, 每会话一个文件, 原子 rename) / sqlite(node:sqlite)**。接口注释说可扩展 Redis/Postgres，但**当前未实现**。server `getMemoryStore()` 按 `MEMORY_BACKEND`(sqlite|file|volatile) 选后端，`MEMORY_DIR`/`MEMORY_SQLITE_FILE` 控制路径；默认空=volatile。多副本共享记忆只能靠「挂载同一 RWX 共享卷 + file 后端」（sqlite 在网络 FS 上文件锁不可靠，勿用）。

## 生产 K8s 部署配置决策（2026-08-13）
- 决策 A（多副本记忆共享）= 所有 ui 副本挂 RWX PVC `agent-harness-data` 到 `/app/data`，configmap 设 `MEMORY_BACKEND=file`+`MEMORY_DIR=/app/data/memory`。RWX 必须支持 RWX 的 StorageClass（AWS EFS/Azure Files/GCP Filestore/阿里云 NAS），否则 PVC Pending。
- Redis 加固：`redis.yaml` 改 `redis-server --requirepass "$REDIS_PASSWORD" --appendonly yes --dir /data`；密码取自 Secret.REDIS_PASSWORD，Secret.REDIS_URL 同步为 `redis://:PASSWORD@redis:6379`。redis-data PVC 扩到 2Gi。
- **安全红线**：`deploy/k8s/secret.yaml` 未被 `.gitignore` 忽略，切勿把真实密钥（如 OPENROUTER_API_KEY）提交进该文件；用 `kubectl create secret` 或 Sealed/External Secrets 注入。

## 关键设计约定
- **本地跨包解析**：server/webapp/examples 的 tsconfig 用 `paths` 把 `@agent-harness/core` 指向 `packages/core/dist/index.d.ts`（已构建产物），避免 `rootDir` 与 `paths` 拉入源码触发 `TS6059`；`pnpm -r build` 按拓扑序先构建 core 再构建 server/webapp/examples。
- 一切降级可用：无 `OPENROUTER_API_KEY` → mock LLM；无 `HARNESS_API_KEY` → dry-run；无 MCP 配置 → 静默跳过。
- 工具抛错不中断，错误文本作为 tool message 回灌模型自愈。
- MCP 多 server 工具以 `<server>__<tool>` 前缀注册；护栏/记忆/追踪自动覆盖 MCP 工具，主循环零改动。
- `onEvent` 是纯旁路观测通道，UI 和测试靠它，不侵入业务逻辑。

## 工程现状（截至 2026-08-11）
- git 分支 `dev`，monorepo 重构已于 commit `2a4b4c7` 提交并推送 origin/dev。
- 包管理器统一为 pnpm@11.9.0（已删除 package-lock.json，仅留 pnpm-lock.yaml）。
- 部署：Render Blueprint `render.yaml`（free plan / oregon / healthCheckPath `/api/state`）。CI 见 `.github/workflows/deploy.yml`（cache: pnpm，build `pnpm -r build`，上传 `packages/server/public`）。
- 注意：本沙箱 `pnpm install` 被 safe-delete 守卫拦截，无法本地装依赖；验证改用直接 `tsc` 构建 + 手动建 `node_modules/@agent-harness/core` 符号链接模拟 pnpm workspace 链接。

## 优化项（2026-08-11 全部完成，commit `50231ba` 推送 dev）
原 8 个待优化点已落地：
1. **UI 鉴权**：`packages/server/src/server.ts` 增加 `UI_AUTH_TOKEN` 承载令牌校验，保护 `/api/run`、`/api/verify`、`/api/mcp/add`、`/api/env`、`/api/mcp/list`；`/api/state` 与静态页保持开放（供 Render 健康检查）。未配置则开放并告警。SIGINT/SIGTERM 触发 `mcpManager.shutdown()` 清理 MCP 连接。
2. **长期记忆接入**：`memory.systemContext()` 注入系统提示词；`AgentHarness.remember()/notes()` 入口；配置 `persistencePath` 时 `run()` 自动 `load`/`save`。`memory.hasPersistence` getter 控制开关。
3. **Harness 超时/取消**：`HarnessOptions.timeoutMs` + `signal`；`run()` 用 `AbortController` 组合信号，`Promise.race` 打断挂起 LLM 调用，中止时返回 `[timeout]`/`[aborted]` 提示。
4. **LLM 适配器去重**：抽出 `packages/core/src/llm/shared.ts`（`toOpenAIMessage`/`safeParseArgs`/`callOpenAIChat`，含 429/5xx + 退化响应重试）；`openrouter.ts`/`openai.ts` 改为薄封装。`LLM` 契约新增第三可选参数 `LLMCallOptions { signal? }`，透传到 fetch。
5. **护栏扩展**：`guardrails.ts` 新增 `INJECTION_PATTERNS`（提示词注入启发式）+ `registerInputRule` 可扩展规则，覆盖 input/output。
6. **envUrl 可配置**：`HarnessClient` 用 `envUrlTemplate`（`HARNESS_ENV_URL_TEMPLATE`，默认 `https://{envId}.preview.internal`）替换四处硬编码占位符。
7. **MCP 连接生命周期**：`placeholder.ts` 维护 `liveClients` 注册表，`connectMcpServer`/`registerMcpTools` 存引用，新增 `disconnectMcpServer`/`disconnectAllMcp`；`ToolRegistry.unregister` 配合清理。
8. **测试套件**：`packages/core/test/*.test.cjs`（node:test + node:assert，零依赖，require 编译后的 dist 叶子模块避免触碰 MCP SDK），27 用例全过；core `package.json` 增 `test` 脚本。

## 多 MCP server 支持（commit `63ff19e` 推送 dev）
- `placeholder.ts` 新增 `McpServerConfig` / `parseMcpServersEnv(env?)`（MCP_SERVERS JSON 数组优先、MCP_SERVER_URL 兜底、每 server 独立 transport/command/args/env/headers）/ `connectMcpServers(registry, configs)` 顺序批量接入（单失败不影响其余）。
- UI `mcp-manager.ts` 复用 `parseMcpServersEnv`；`addServer(name,url,headers)` 仍只透传 name/url/headers（不强制 transportType），`/api/mcp/add` 同理。
- 新增 `examples/multi-mcp.ts` 演练多 server 接入 + `disconnectAllMcp()` 清理；脚本 `pnpm --filter @agent-harness/examples run mcp:multi`。
- 测试新增 `mcp-config.test.cjs`（7 用例），core 套件 27 → 34 全过。
- 新增 `MCP_SERVICES.md` 远程 MCP 服务接入清单；`render.yaml` 服务名 `agent-harness-ts → agent-harness`。
- 踩坑：本地 `node_modules/@agent-harness/core` 是早期 install 残留的**真实目录**（含陈旧 dist），`ln -sfn ../../packages/core node_modules/@agent-harness/core` 会把它塞成目录内的子符号链接而非替换；验证前需先 `rm -rf node_modules/@agent-harness/core` 再建符号链接，否则 require 到旧 dist 缺导出。

## 验证命令（沙箱本地）
- 构建：`tsc -p packages/core/tsconfig.json && tsc -p packages/server/tsconfig.json && tsc -p packages/webapp/tsconfig.json && tsc -p examples/tsconfig.json`
- 测试：`cd packages/core && node --test test/*.test.cjs`（注意：`node --test test/` 会把目录当模块报错，必须用显式文件通配）
- UI 冒烟：`node packages/server/dist/server.js`，`/api/state` 与 `/` 应 200，`/api/run` mock SSE 正常。


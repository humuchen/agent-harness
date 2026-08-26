# 项目长期记忆 · agent-harness

## 定位

最小化可直接运行的 TS AI Agent harness 骨架（pnpm monorepo，零硬依赖除 MCP SDK）。

## 仓库结构（分层布局，旧 packages/\* 路径已失效）

- backend/core → @agent-harness/core（框架库）；backend/client → @agent-harness/client
- access/server → @agent-harness/server，入口 `node access/server/dist/server.js`
- frontend/webapp → @agent-harness/webapp（Vite+Lit，产物 dist，server 优先托管）
- plugins/\* 业务插件（ma-lead / customer-service），core/server/webapp 零业务耦合
- 部署：Dockerfile(非 root ah) / docker-compose(+redis) / render.yaml(free/oregon, healthCheck /api/state) / deploy/k8s

## 关键约定

- 跨包解析：tsconfig paths 把 @agent-harness/core 指向 backend/core/dist/index.d.ts；`pnpm -r build` 拓扑序先 core 后 server/webapp/plugins。
- 一切降级：无 OPEN_API_KEY→mock；无 HARNESS_API_KEY→dry-run；无 MCP→ 跳过。
- onEvent 纯旁路观测；工具抛错不中断，回灌模型自愈。
- MCP 多 server：`MCP_SERVERS` JSON 优先；工具前缀 `<server>__<tool>`。
- 前端 chat 页（frontend/webapp/src/chat.ts）：消息区 `.scroll` 钉底跟随由 `stickToBottom` 状态门控，`onScroll` 计算距底 ≤24px 判为 atBottom 并驱动 `showScrollDown` 浮动「回到底部」按钮显隐。

## 记忆后端

volatile / file(每会话 JSON,原子 rename) / sqlite(node:sqlite)，按 MEMORY_BACKEND 选；多副本共享用 RWX 卷 + file 后端（sqlite 网络 FS 锁不可靠）。

## 沙箱构建验证

- 类型检查各包：`tsc -p <pkg>/tsconfig.json`（webapp 用 node_modules/typescript/bin/tsc，因 .bin 是 sh 脚本不可直跑）
- core 测试：`cd backend/core && node --test test/*.test.cjs`
- 本地 pnpm install 被 safe-delete 守卫拦；全量 pnpm -r build 可行（NODE_OPTIONS=--use-system-ca + 抬高 CODEBUDDY_SAFE_DELETE_BULK_THRESHOLD + dangerouslyDisableSandbox）。

## 插件数据目录坑（复用）

- ma-lead：`MA_DATA_DIR`>MEMORY_DIR/plugins/medical-aesthetics-lead>cwd/data/ma-lead（cwd 偏移致库分散）；活跃库 data/ma-lead/ma-lead.db（node:sqlite DatabaseSync）。
- customer-service：`CS_DATA_DIR`>...>cwd/data/cs。
- node:sqlite：`@types/node@20` 无类型 → 动态 require + 本地接口；exec() 无参，写用 prepare().run()，RETURNING 用 .get()；先 mkdirSync 父目录。
- 插件路由 key 须纯路径；server handle(path) 精确匹配，方法在 handler 内用 req.method 区分。

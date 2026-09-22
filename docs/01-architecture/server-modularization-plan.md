# server.ts 路由模块化拆分方案

> 背景：`access/server/src/server.ts` 曾达 6400+ 行，单文件承载全部路由分发与组合根。
> 大文件的问题不是行数本身，而是「改动热点集中」：任何路由小改都要在 6000 行里找上下文，
> code review 困难、合并冲突高频、编译增量慢。
> 本文记录已验证的拆分模式与后续批次计划。

## 已完成：第一批（账户路由，模式验证）

- 新模块：`access/server/src/routes/account-routes.ts`（约 480 行）
- 覆盖：`/api/account/*` 全部 10 个非 OAuth 端点（login-salt / register / login /
  forgot-password / reset-password / me / change-password / logout / refresh / DELETE）
- server.ts 由 6491 行降至约 6150 行，编译零错误，325 项测试全绿，
  并经真实 HTTP 全流程验证（注册→me→refresh→logout + CSRF 403/200 正反例）。

### 模式约定（后续批次必须遵守）

1. **签名统一**：模块导出
   `async function handleXxxRoutes(req, res, url, path, deps): Promise<boolean>`
   ——命中并完成响应返回 `true`；未命中返回 `false`，主分发器继续匹配。
2. **依赖注入，不 import server.ts**（避免环）：与 server.ts 强耦合的闭包
   （`guard` / `audit` / `clientIp` / cookie 构造器等）经 `deps` 对象传入，
   接口定义在模块内（`export interface XxxRouteDeps`）。
3. **纯助手直接 import**：`http-helpers.ts`（readBody/sendJsonError/securityHeaders）、
   `accounts.ts`、`rate-limit.ts`、`config-defaults.ts`（cfgNum）等本就是独立模块。
4. **行为零变更**：搬移即原样复制（含注释），不改逻辑；每批完成后
   `tsc -p tsconfig.json` + `node --test test/*.test.cjs` 全绿才算完成。
5. **路由前缀判早**：模块入口先做 `if (!path.startsWith('/api/xxx')) return false;`
   快速短路（第一批未加是因为端点前缀统一，后续批次建议加上）。
6. **真实 HTTP 验证**：单元测试直接 require dist 函数，不覆盖 HTTP 分发层；
   每批外迁后必须起一次真实服务 curl 冒烟（参考下方命令）。

```bash
# 冒烟模板（本地）
PORT=4182 ADMIN_API_KEY=test-admin-token node access/server/dist/server.js &
curl -sf http://127.0.0.1:4182/health/ready
# …按批次端点逐一 curl…
```

## 已完成：第二批（devices / datasources / upload）

- 新模块：`routes/device-routes.ts`、`routes/datasource-routes.ts`、`routes/upload-routes.ts`
- server.ts 6153 → 6055 行；tsc 零错误、325 项测试全绿。
- 该批依赖全部可静态 import（device-store / data-source / upload / http-helpers），
  deps 仅剩 `{ guard }`——印证「先搬纯静态依赖的路由组」的排序策略。
- 细节：原 upload catch 中 `const code = e?.status ? ... : 400` 是死变量（未用于响应），
  搬移时保留线上行为（错误统一 200 JSON body），未"顺手修复"——拆分批次严禁夹带行为变更。

| 批次 | 路由组 | 状态 |
|---|---|---|
| 1 | account（10 端点，非 OAuth） | ✅ 已完成（routes/account-routes.ts） |
| 2 | devices / datasources / upload | ✅ 已完成（device / datasource / upload-routes.ts） |
| 3 | approvals / plans / recipes / skills | 待做 |
| 4 | agents / registry / A2A | 待做 |
| 5 | chat / run / jobs（SSE 流） | 待做 |
| 6 | OAuth（github/google 回调） | 待做（并入 account-routes） |
| 7 | metrics / artifacts / history / memory | 待做 |

## 已完成：第三批（plans / approvals / eval+recipes / skills）

- 新模块：`routes/plan-routes.ts`（含协同 SSE 频道）、`routes/approval-routes.ts`、
  `routes/eval-recipe-routes.ts`、`routes/skill-routes.ts`
- server.ts 6055 → 约 5788 行；tsc 零错误、325 项测试全绿、
  HTTP 冒烟 6/6（`scripts/smoke-batch3.cjs`，可复用于回归）。
- 依赖启示：`runQueue` / `sseConnectionLock` / plan-bus / eval 等都是可独立 import 的模块——
  真正需要 deps 注入的只剩 `guard`、`auditAction` 和组合根单例（`approvalPolicy` / `evaluator`）。
  **单例语义核查**：`getRecipeStore()` 是 memoized 单例，模块内直接调用安全；
  `createApprovalPolicy()` / `createEvaluator()` 每次创建新实例，必须经 deps 注入共享。

| 批次 | 路由组 | 状态 |
|---|---|---|
| 1 | account（10 端点，非 OAuth） | ✅ 已完成（routes/account-routes.ts） |
| 2 | devices / datasources / upload | ✅ 已完成（device / datasource / upload-routes.ts） |
| 3 | plans / approvals / eval+recipes / skills | ✅ 已完成（plan / approval / eval-recipe / skill-routes.ts） |
| 4 | agents / registry / A2A | 待做 |
| 5 | chat / run / jobs（SSE 流） | 待做 |
| 6 | OAuth（github/google 回调） | 待做（并入 account-routes） |
| 7 | metrics / artifacts / history / memory | 待做 |

## 已完成：第四批（agents / A2A / teams）

- 新模块：`routes/agent-routes.ts`（约 270 行，含 normalizeIncomingCard 与 handleA2A 全函数体迁入）
- server.ts 5788 → 约 5503 行；tsc 零错误、325 项测试全绿、HTTP 冒烟 9/9（`scripts/smoke-batch4.cjs`）。
- 新增注入形态：**可变旗标经 getter 注入**（`isShuttingDown: () => boolean`）——server.ts 的
  可变模块状态不直接共享，读侧用闭包。
- 教训：外迁函数体时锚点必须「现场重取」——上一批删掉的注释不能再当终点锚（曾因
  end 锚点已不存在而 ValueError，改用下一个存活注释为终点并重跑）。

| 批次 | 路由组 | 状态 |
|---|---|---|
| 1 | account（10 端点，非 OAuth） | ✅ 已完成（routes/account-routes.ts） |
| 2 | devices / datasources / upload | ✅ 已完成（device / datasource / upload-routes.ts） |
| 3 | plans / approvals / eval+recipes / skills | ✅ 已完成（plan / approval / eval-recipe / skill-routes.ts） |
| 4 | agents / A2A / teams | ✅ 已完成（agent-routes.ts） |
| 5 | chat / run / jobs（SSE 流） | 待做（最大批次） |
| 6 | OAuth（github/google 回调） | 待做（并入 account-routes） |
| 7 | metrics / artifacts / history / memory / mcp / shell / env / workflows | 待做 |

## 已完成：第五批（jobs / mcp / verify / shell / env 运维端点）

- 新模块：`routes/ops-routes.ts`（约 340 行）
- server.ts 5503 → 约 5208 行；tsc 零错误、325 项测试全绿、HTTP 冒烟 8/8（`scripts/smoke-batch5.cjs`）。
- **发现一个存量怪癖（未顺手修，遵守「搬移不带行为变更」纪律）**：`POST /api/env` 传非法
  `action` 时，原代码先 `startSse()` 写响应头、再 fall-through 到 `writeHead(400)` →
  ERR_HTTP_HEADERS_SENT，被外层兜底捕获后回 200 + 错误 JSON。候选后续修复：在 startSse
  前校验 action ∈ {create, destroy}，否则直接 400。
- 原 handleRun（~1000 行）与 handleWorkflow 的搬移**暂缓**：二者深度耦合配额/会话/计划
  提议/BYOK 凭据装配与 SSE 流，是产品关键路径，机械搬移的风险收益比不合理。建议以
  「先补 run/chat 全流程 e2e（真实 LLM 或确定性 stub）→ 再搬移」的方式进行，单独排期。

| 批次 | 路由组 | 状态 |
|---|---|---|
| 1 | account（10 端点，非 OAuth） | ✅ 已完成（routes/account-routes.ts） |
| 2 | devices / datasources / upload | ✅ 已完成（device / datasource / upload-routes.ts） |
| 3 | plans / approvals / eval+recipes / skills | ✅ 已完成（plan / approval / eval-recipe / skill-routes.ts） |
| 4 | agents / A2A / teams | ✅ 已完成（agent-routes.ts） |
| 5 | jobs / mcp / verify / shell / env | ✅ 已完成（ops-routes.ts） |
| 6 | handleRun / handleWorkflow / chat 流（高危，需先补 e2e） | ⏸ 暂缓（单独立项） |
| 7 | OAuth（github/google 回调，并入 account-routes） | 待做 |

## 已完成：第六批（OAuth 并入账户模块）

- `routes/account-routes.ts` 新增 `handleAccountOauthRoutes`：GitHub / Google 授权码流
  全部 4 个端点 + cookie 构造器族（oauthStateCookie / oauthCodeVerifierCookie /
  refreshCookieValue / setCookies / isReqLocalhost）与 redirectUri 构造器整体迁入。
- `safeEqualString` 上移至 `http-helpers.ts`（guard 的 CSRF 校验与 OAuth 回调共用）。
- server.ts 5208 → 约 4589 行；tsc 零错误、325 项测试全绿、HTTP 冒烟 3/3
  （`scripts/smoke-batch6.cjs`：未配置语义 500 JSON + PKCE 分流归属验证）。
- **分流归属注意**：`/api/account/oauth/callback、/config、/exchange` 属 OpenRouter
  PKCE 流（provider-keys 注册表），本模块显式返回 false，由 server.ts 的 PKCE 分发块接手。
- **机械转换教训**：外迁「深嵌套 if 块」时，裸 `return;` 出现在多层缩进——只转换顶层
  缩进会漏掉嵌套层（曾 23 处漏网导致 TS2322）；应对整个函数区间做任意缩进的统一转换。
  行级手术删除函数定义区时，插入语句后必须核对原位置残留的 `return;}/}` 孤儿对。

| 批次 | 路由组 | 状态 |
|---|---|---|
| 1 | account（10 端点，非 OAuth） | ✅ 已完成（routes/account-routes.ts） |
| 2 | devices / datasources / upload | ✅ 已完成（device / datasource / upload-routes.ts） |
| 3 | plans / approvals / eval+recipes / skills | ✅ 已完成（plan / approval / eval-recipe / skill-routes.ts） |
| 4 | agents / A2A / teams | ✅ 已完成（agent-routes.ts） |
| 5 | jobs / mcp / verify / shell / env | ✅ 已完成（ops-routes.ts） |
| 6 | OAuth（github/google） | ✅ 已完成（并入 account-routes.ts） |
| 7 | metrics / artifacts / history / memory / workspaces / workflows 快照等杂项 | 待做（量大但模式同） |
| — | handleRun（~1000 行）/ handleWorkflow | ⏸ 暂缓：需先补 run 全流程 e2e 护航，单独立项 |

## 已完成：第七批（策略 / 合规 / 可观测指标）

- 新模块：`routes/policy-routes.ts`（openapi.json / retention / features GET+toggle /
  im/status / policy GET+preview+POST / brand，约 190 行）、
  `routes/metrics-routes.ts`（/api/metrics JSON + /api/metrics/prometheus 含延迟直方图，约 120 行）。
- server.ts 4589 → 约 4388 行；tsc 零错误、325 项测试全绿、HTTP 冒烟 4/4（`scripts/smoke-batch7.cjs`）。
- **鉴权归属要点**：`/api/metrics*` 的守卫来自主分发器的 `readAction` 预检（metrics:read），
  不在路由块内——metrics 模块的分发调用必须保持在 readAct 预检**之后**，否则守卫被绕过。
  外迁任何「无显式 guard 的 GET」前，先查 readAction 映射表。
- 类型来源核对清单：ImBridge 在 `./im`（im-status 只是转用）、Action/Role 在 `./authz`
  （core 的同名类型语义不同）、RetentionPolicy 在 `./retention`、getMemoryStore 在 `./runner`。

| 批次 | 路由组 | 状态 |
|---|---|---|
| 1 | account（10 端点，非 OAuth） | ✅ 已完成（routes/account-routes.ts） |
| 2 | devices / datasources / upload | ✅ 已完成（device / datasource / upload-routes.ts） |
| 3 | plans / approvals / eval+recipes / skills | ✅ 已完成（plan / approval / eval-recipe / skill-routes.ts） |
| 4 | agents / A2A / teams | ✅ 已完成（agent-routes.ts） |
| 5 | jobs / mcp / verify / shell / env | ✅ 已完成（ops-routes.ts） |
| 6 | OAuth（github/google） | ✅ 已完成（并入 account-routes.ts） |
| 7 | 策略 / 合规 / 品牌 / 指标 | ✅ 已完成（policy-routes.ts + metrics-routes.ts） |
| 8 | sessions / memory / gdpr / roles / workspaces / audit / org / artifacts / sandbox / supply-chain / usage / jev / provider-keys / chat-sessions / history / events / workflows 快照 | 待做（同模式，逐组推进） |
| — | handleRun（~1000 行）/ handleWorkflow / chat-stream / events | ⏸ 暂缓：需先补 run 全流程 e2e 护航，单独立项 |

## 已完成：第八批（数据 / 合规 / 运维杂项）

- 新模块：`routes/misc-routes.ts`（约 300 行）：GET /api/sessions、GET+DELETE /api/memory、
  DELETE /api/data/gdpr、GET /api/roles、GET /api/audit、GET /api/org、
  GET+POST /api/supply-chain/*、GET /api/account/usage、GET /api/jev/status。
- server.ts 4388 → 约 4208 行；tsc 零错误、325 项测试全绿、HTTP 冒烟 7/7（`scripts/smoke-batch8.cjs`）。
- 环境注意：macOS 本地默认记忆目录 `/var/lib/agent-harness` 不可写（EACCES）属**存量环境问题**
  与重构无关——本地冒烟用 `MEMORY_BACKEND=volatile` 规避；容器内路径已预建（Dockerfile）。
- 类型/依赖来源：Memory / quotaEngine / getJevStats / sanitizeKey 在 core；
  invalidateSessionMemory 在 `./runner`；resolveJevCredential 在 `./provider-keys`。

| 批次 | 路由组 | 状态 |
|---|---|---|
| 1 | account（10 端点，非 OAuth） | ✅ 已完成（routes/account-routes.ts） |
| 2 | devices / datasources / upload | ✅ 已完成（device / datasource / upload-routes.ts） |
| 3 | plans / approvals / eval+recipes / skills | ✅ 已完成（plan / approval / eval-recipe / skill-routes.ts） |
| 4 | agents / A2A / teams | ✅ 已完成（agent-routes.ts） |
| 5 | jobs / mcp / verify / shell / env | ✅ 已完成（ops-routes.ts） |
| 6 | OAuth（github/google） | ✅ 已完成（并入 account-routes.ts） |
| 7 | 策略 / 合规 / 品牌 / 指标 | ✅ 已完成（policy-routes.ts + metrics-routes.ts） |
| 8 | sessions / memory / gdpr / roles / audit / org / supply-chain / usage / jev | ✅ 已完成（misc-routes.ts） |
| 9 | workspaces / artifacts / sandbox / chat-sessions / history / workflows 快照 / provider-keys / events / plugins / run 挂载 | 待做（同模式；chat/history/events 与 run 耦合较深，建议与 handleRun 一并 e2e 护航后处理） |
| — | handleRun（~1000 行）/ handleWorkflow | ⏸ 暂缓：需先补 run 全流程 e2e 护航，单独立项 |

## 后续批次（按耦合度从低到高排序）

| 批次 | 路由组 | 预估行数 | 依赖闭包 | 备注 |
|---|---|---|---|---|
| 2 | devices / datasources / upload | ~250 | guard, readBody, sendJson | 简单 CRUD，最易 |
| 3 | approvals / plans / recipes / skills | ~400 | guard, approvalEngine | 中等 |
| 4 | agents / registry / A2A | ~600 | registry, guard | 需注册表上下文 |
| 5 | chat / run / jobs（SSE 流） | ~900 | runQueue, chatBus, sse | 流式端点，注意限流豁免 |
| 6 | OAuth（github/google 回调） | ~500 | views, provider 配置 | 与账户模块合并进 account-routes |
| 7 | metrics / artifacts / history / memory | ~500 | telemetry, artifactStore | — |

每批一次 commit，全量回归后再进下一批。全部完成后 server.ts 只剩：
组合根（装配 authorizer/queue/plugins）+ 主分发器（< 800 行目标）。

## 风险与教训（第一批实录）

- **CSRF 覆盖缺口是外迁时发现的**：`refresh`/`logout` 是「cookie 鉴权但不经 guard」的
  POST，此前不在 guard 的 CSRF 门禁覆盖内（实测无 token 返回 200）。模块内补了
  `csrfGuard` 兜底（尊重 `CSRF_ENFORCE=off`）。**后续批次外迁时，逐个端点自查
  「鉴权来源 × 方法 × 是否过 guard」三维矩阵，这是拆分最大的价值所在。**
- BSD grep 的 `\|` 不代表或（需 `-E`）——批量核对 import 残留时用 `grep -c <name>` 逐个来。
- `noUnusedLocals` 未开启，unused import 不会编译报错，需在每批结束时人工 prune
  （对照模块内 import 清单逐个 `grep -c`）。

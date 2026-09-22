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

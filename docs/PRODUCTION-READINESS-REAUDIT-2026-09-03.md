# agent-harness 企业级生产就绪度复评报告

> 复评日期：2026-09-03
> 评估方法：全仓库静态代码审计 + 对上一轮自评（`docs/PRODUCTION-READINESS-2026-09.md`，2026-09-02）的**逐条信任但验证（trust-but-verify）**
> 评估对象：`agent-harness` monorepo（backend/{core,client,medical-ad-guard} · access/server · frontend/{webapp,cli} · plugins/\* · services/rag）
> 判定基准：企业级 SaaS 公网生产上线门槛（7.5/10）

---

## 一、结论先行

**综合得分 5.1 / 10（上一轮自评 4.2）。定位仍是「工程完成度很高的内测级平台」，距离企业级生产环境还有一个明确的、约 3–4 周可收敛的缺口。**

三条最重要的判断：

1. **上一轮 7 项 P0，真正修好的只有 2 项（P0-3、P0-6），2 项部分修（P0-1、P0-5），2 项完全未修（P0-4、P0-7），1 项「看起来修了、实际仍然完全无效」（P0-2）。**
2. **本轮新发现 3 项 P0，其中「公开注册即获管理员权限」是上一轮完全漏掉的、上线即被攻破级别的缺陷。**
3. **核心矛盾没变，但形态更清楚了：约六成问题仍是「有实现、没接线」。** 项目不缺架构能力和代码质量，缺的是把已有的正确设计真正接通到生产运行时。

一句话概括：**架构骨架 7 分，代码质量 7 分，接线与默认配置 3 分，权限模型 2 分。**

---

## 二、上一轮 P0 修复验证（本轮核心工作）

> 判定标准：不是看「代码里有没有相关调用」，而是**沿着完整执行链验证它在生产默认配置下是否真的生效**。

| 编号 | 上一轮问题 | 本轮判定 | 验证证据 |
| --- | --- | --- | --- |
| P0-1 | 加密主密钥未注入 | **✅ 已修（配置层）** | `render.yaml:62-65` 已声明 `AH_CRYPTO_KEY` / `AH_AUTH_SECRET`（`sync: false`），且 `:119-122` 开启 `AH_STARTUP_CRITICAL=1`。剩余责任在运维：必须在 Render Dashboard 实际填入 64 hex，否则启动即被强校验阻断 |
| P0-2 | 无成本硬上限 | **❌ 表面已修、实际完全无效** | 见下方 §2.1。双重缺陷叠加 |
| P0-3 | `rateBuckets` 确定性内存泄漏 | **✅ 已修，且修得很漂亮** | 抽出为 `access/server/src/rate-limit.ts`，三层防护：惰性过期 + 60s 定时 sweep（`unref` 不阻断退出）+ `RATE_BUCKETS_MAX=50_000` 硬淘汰。配套 `test/rate-limit.test.cjs` |
| P0-4 | free plan 伪持久化 | **❌ 未修** | `render.yaml:19` 仍 `plan: free`，`:35-38` 仍声明 `disks`。注释自陈「free plan 不支持持久卷，重启即清空」 |
| P0-5 | 默认管理员明文口令 | **⚠️ 部分修，且引入新误导线索** | `render.yaml` 已移除 `ADMIN_PASSWORD`，改 `ADMIN_API_KEY`（`sync:false`）；`accounts.ts:151` 的 `if (adminUser && adminPass)` 在无 `ADMIN_PASSWORD` 时不创建内置账户 → 弱口令风险已消除。**但** `render.yaml:115-116` 注释仍宣称「admin/admin888 始终可登录放行」，与代码行为矛盾，运维照注释配置即重新引入弱口令 |
| P0-6 | 零备份 + 3 处非原子写 | **⚠️ 非原子写已修，备份仍未调度** | 三处均已是 tmp+rename：`services/rag/src/store.ts:132,148`、`access/server/src/chat-sessions.ts:130`、`access/server/src/eval.ts:243`（三文件均 import `renameSync`）。`scripts/backup-db.cjs` 已实现，CI 有验证步骤，**但生产零调度**（见 §3 P0-E） |
| P0-7 | 迁移框架是死代码 | **❌ 未修** | `render.yaml:29-30` 的 buildCommand/startCommand 与 `.github/workflows/ci.yml` **均不调用** `scripts/db-migrate.cjs`；`Dockerfile:118` CMD 同样不调用。`db:migrate` 仅存在于 `package.json:22` |

### 2.1 P0-2 详解：一个「已接线但不通电」的典型

上一轮的修复确实把 `admit()` 接进了 run 路径（`access/server/src/run-queue.ts:817-845`），但沿着链走到底会发现它完全不工作：

```ts
// run-queue.ts:821-823
const maxCostPerWindow = Number(process.env.MAX_COST_PER_WINDOW) || 0;   // = 10（render.yaml:125）
const requestedCost = maxCostPerWindow > 0 ? { cost: maxCostPerWindow } : {};  // ← 传了「整个窗口预算」10
const admit = quotaEngine.admit(tenantIdForQuota, requestedCost, maxCostPerWindow > 0);
```

```ts
// backend/core/src/quota/engine.ts:149
if (q.maxCostPerWindow && b.costUsed + reqCost > q.maxCostPerWindow) { ...拒绝... }
```

**缺陷 1 —— 配额从未装配，拦截分支永久短路。**
`engine.ts:205` `export const quotaEngine = new QuotaEngine()` 无参构造 → `engine.ts:52-54` `defaultQuota()` 只返回 `{ windowMs: 60000 }`，**不含 `maxCostPerWindow`**。全仓无任何 `setDefault()` / `setQuota()` 调用点。因此 `q.maxCostPerWindow === undefined`，`if` 短路 → **成本硬上限在生产默认配置下从不生效，资损防护依然为零**。

**缺陷 2 —— 即使装配了，也会退化成「每窗口只放行一次」。**
`requestedCost` 传的是窗口总预算（10）而非本次预估成本。判定式变成 `costUsed + 10 > 10`，即 **`costUsed > 0` 就拒绝**。且 `engine.ts:158` `b.costUsed += reqCost` 每次准入都累加 10。结果：
- 租户在 60s 窗口内跑通第 1 次后，`costUsed = 10`，第 2 次起全部 `cost window limit exceeded` → **多轮对话在第 2 轮直接失败**；
- `/api/account/usage` 展示的成本是**每次 +10 美元的虚高假数据**（`b.costUsed` 被污染），计费与对账同样失真。

> 这是本次复评最重要的发现：**修复动作本身让代码从「明显缺失」变成「看起来完备」**，静态扫描和人工 review 都更容易放过。正确修法是：启动时用 `MAX_COST_PER_WINDOW` 装配 `quotaEngine.setDefault({ maxCostPerWindow })`，run 路径改为传本次预估成本（或 0），真实消耗仍走 `recordUsage()` 累加。

---

## 三、本轮新发现的 P0 阻塞项

### P0-A（安全·致命）· 公开注册即获管理员权限

- **利用链（四道默认值全部指向 admin）：**
  1. `/api/account/register` 是**公开端点**，无需登录、无邀请码、无邮箱验证 —— `server.ts:792` 显式放在鉴权 guard **之前**处理（`server.ts:790-791` 注释自陈）；
  2. `accounts.ts:302` 注册 INSERT **不指定 `role` 列** → 落到 `accounts.ts:130` 的列定义 `role TEXT NOT NULL DEFAULT 'admin'`；
  3. `accounts.ts:213-216` `issueToken()` 读库 → `const role = row?.role || 'admin'`；
  4. `authz.ts:352` 解析 token → `role: (t.role ?? 'admin') as Role`；`accounts.ts:252` 旧 token 无 `r` 字段同样回落 `'admin'`。
- **影响：** 任何人 `curl -X POST .../api/account/register -d '{"username":"x","password":"..."}'` 即获得 `DEFAULT_MATRIX.admin`（`authz.ts:110`）的全部权限，含 `env:destroy`、`mcp:add`、`plugin:manage`、`shell:approve`、`approvals:review`、`memory:clear`、`provider:manage`、`features:write`。
- **反证这是遗漏而非设计：** GitHub OAuth（`accounts.ts:384`）与 Google OAuth（`accounts.ts:420`）**都显式写入 `'operator'`**，唯独注册路径漏写。作者知道该区分，是单点遗漏。
- **修复：** ① 建表默认值改为 `'viewer'`；② 注册 INSERT 显式写 `'viewer'`；③ `issueToken` / token 解析的兜底改为 `'viewer'`；④ 存量库一次性 `UPDATE users SET role='viewer' WHERE role IS NULL OR role=''`；⑤ 注册加邮箱验证或邀请码。

### P0-B（可用性·致命）· 配额逻辑误杀正常请求

见 §2.1 缺陷 2。即使不装配配额，只要 `q.maxCostPerWindow` 一旦被正确设置，`requestedCost` 的传参错误就会让**每个租户每 60 秒只能提交 1 次 run**。上线后表现为「用户发第 2 句话就失败」。

### P0-C（持久性）· free plan 伪持久化（沿用上一轮 P0-4）

`render.yaml:19` `plan: free` + `:35-38` `disks:`。free plan 不支持持久卷，且 15 分钟休眠冷启。后果：账户、BYOK 密钥、记忆、业务数据**每次冷启动归零**；长 SSE 任务被休眠中断。
**修复：** 升级付费 plan 启用持久卷，或切到 `deploy/k8s`（已备 RWX PVC 模板）。

### P0-D（数据治理）· 迁移框架仍是死代码（沿用上一轮 P0-7）

`scripts/db-migrate.cjs` 实现了完整的 `schema_migrations` 表，但 buildCommand / startCommand / Dockerfile CMD / CI 四处**全部不调用**。上一轮还指出隐藏地雷：`getCurrentVersion` 取 `MAX(version)`（`:59-60`）而 `createMigration` 用 `Date.now()` 作版本号（`:172`），混用后任何手写 `002_*` 迁移会被**永久跳过**。

### P0-E（持久性·新）· 备份能力零调度

- `scripts/backup-db.cjs` 已实现（backup / list / restore），`package.json:32-34` 暴露了脚本。
- **但全仓无任何调度点：** 进程内 `setInterval` 全部用于 telemetry autosave、memo 提醒、token 缓存聚合，**无一用于备份**；`render.yaml` 未定义 `type: cron` 作业；CI（`.github/workflows/ci.yml:54-55`）只是「push 时验证脚本能跑」，**不是生产备份**。
- **结论：生产环境的实际备份数量 = 0。** `AH_BACKUP_DIR` / `AH_BACKUP_KEEP_DAYS`（`render.yaml:136-139`）是没有任何消费者的配置。
- **修复：** Render 加 cron job，或 k8s 加 CronJob，调用 `backup-db.cjs --action backup`，并做异地复制与**恢复演练**（`scripts/rollback-drill.cjs` 已备但同样无调度）。

### P0-F（弹性·新）· 生产未启用 Redis，水平扩展与任务可靠性均不成立

- Redis 事件桥实现完整且有测试：`access/server/src/queue-backend.ts`、`redis-client.ts`，`test/queue-backend.test.cjs` 覆盖了 claim 原子性、崩溃回收、跨实例 pub/sub。
- **但 `render.yaml` 全文无 `REDIS_URL`。** 未配置时的回退路径：`redis-client.ts:29` 返回 null、`server.ts:4033` 回退 volatile 内存态、`health.ts:239` 返回「未配置 REDIS_URL，使用内存存储」。
- **后果：** ① 水平扩容到 2 副本立刻出现「请求打到另一个实例找不到任务」；② 进程重启/崩溃即丢失全部在途与排队任务；③ 限流计数、配额桶、SSE 广播全部实例内私有。
- `server.ts:4083` 的自检已经会报 `REDIS_URL 未设置（多副本共享存储缺失）`，说明这是已知问题，但仍未接线。

---

## 四、八维评分矩阵（与上一轮对照）

| 维度 | 上一轮 | 本轮 | 变化 | 一句话症结 |
| --- | --- | --- | --- | --- |
| 运行时稳定性 | 6.0 | **7.0** | ↑ | crash guard + 优雅停机（abortAll→5s 宽限→MCP 关闭→server.close→3s 兜底）+ 限流三层内存防护 + 队列崩溃回收，骨架扎实；扣分在无熔断、无备份调度、Redis 未启用 |
| 安全性 | 4.0 | **4.5** | ↑ | 密码学选型全对（scrypt、AES-256-GCM、HMAC、timingSafeEqual）+ CSP/安全头完整 + 隔离测试扎实；**但注册即 admin 的提权链是致命项** |
| 持久性 | 2.5 | **3.5** | ↑ | 三处非原子写已修、备份脚本已备；但 free plan 伪持久化、迁移死代码、备份零调度、无 Redis，四项叠加 |
| 可观测性 | 5.5 | **6.5** | ↑ | `/api/metrics/prometheus`（`server.ts:1539`）、`/health/live` + `/health/ready` 分离探针、traceId 全链路、告警 webhook/文件双 sink、token 缓存命中率告警；扣分在 OTel 未真正导出、告警无去重抑制分级、无默认接收器 |
| 部署运维 | 4.5 | **6.0** | ↑ | CI 已具备 PR 门禁 + lint fail-on-error + `pnpm audit --audit-level=high` + 构建 + 测试；Dockerfile 非 root 运行 + HEALTHCHECK + 只读根 fs 硬化；扣分在四套部署通道漂移、db-migrate 未接入、无 cron 备份 |
| 弹性伸缩 | 4.0 | **3.5** | ↓ | 能力（Redis 事件桥）实现度高且有测试，但生产 `REDIS_URL` 未配 → 实际锁死单副本。**因确认「有能力但没开」，比上一轮评分更保守** |
| 测试与质量门禁 | 5.0 | **7.0** | ↑↑ | 实测 **89 个测试文件**，覆盖租户隔离、BYOK 隔离、会话归属、路径穿越、代码注入、幂等、崩溃恢复、竞态；**上一轮此项被明显低估** |
| 成本与资损防护 | 2.0 | **3.0** | ↑ | `admit()` 已接进 run 路径并有审计留痕 + 已有 `MAX_COST_PER_RUN`（`runner.ts:644`）；但窗口成本上限因配额未装配而完全失效，且计费展示数据被污染 |

**加权平均 5.125 → 5.1**

### 值得保留、不要重构成上面这些债的架构资产

1. `rate-limit.ts` 的三层内存防护 —— 把「内存有界」变成可被单测证明的性质，而非靠人工 review。
2. `db-adapter.ts:79-82` 的统一 WAL + busy_timeout + foreign_keys 兜底 —— 全项目唯一做对的一致性防护，所有调用方即使不传 pragmas 也生效。
3. 三处原子写统一为 tmp+rename，且 `rag-store.json` 损坏不再导致 RAG 起不来。
4. 租户/BYOK/会话三层隔离测试（`tenant-isolation`、`byok-isolation`、`chat-isolation`）—— 这是很多商业 SaaS 都做不到的质量。
5. 优雅停机的分层收尾顺序与兜底超时，以及 `installCrashGuard` 对 `uncaughtException` 与 `unhandledRejection` 的差异化处理（前者退出交守护进程重启，后者仅记录）。
6. `/health/live` 与 `/health/ready` 分离 —— 可直接对接 k8s 三种探针语义。

---

## 五、P1 上线前必修

**权限与身份**
1. 兜底角色仍是 admin：`server.ts:896` `role: profile?.role ?? 'admin'`（库未就绪/用户不存在时回落 admin）；`authz.ts:352`、`accounts.ts:216,252` 同问题。**兜底值应全部改为 `viewer`。**
2. 删除或订正 `render.yaml:115-116` 关于「admin/admin888 始终可登录」的注释，避免运维据其配置弱口令。

**Web 安全**
3. `http-helpers.ts:69-70`：`UI_CORS_ORIGIN` 含 `*` 时直接返回 `Access-Control-Allow-Origin: *`，且**未返回 `Vary: Origin`**（缓存投毒风险）。应禁止 `*` 与凭证模式共存，并补 `Vary: Origin`。
4. CSP 与插件 UI 的潜在冲突（**需实测确认**）：CSP 为 `default-src 'self'`（无 `'unsafe-inline'`，`render.yaml` 未配 `UI_CSP_EXTEND`），而 `plugins/memo/src/web-view.ts:94,159` 的看板依赖内联 `onclick` 属性 —— 内联事件处理器会被该 CSP 阻止，memo 看板交互可能整体失效。
5. `http-helpers.ts:49` `cross-origin-embedder-policy: require-corp` 会阻断无 CORP 头的跨源资源（外部图片、CDN 脚本、用户上传的跨源预览图）。需确认 webapp 是否依赖此类资源。

**密钥管理**
6. `custom-models.ts:55-95` 的 AES-256-GCM 无 AAD、无 key version 前缀 → 密钥轮换需全量重加密，且无法区分密文版本。建议加 1 字节版本前缀 + AAD 绑定（tenantId/rowId）。
7. `decryptApiKey` 解密失败静默返回 `''`（`:91-94`），调用方无法区分「未配置」与「解密失败/密钥已轮换」，排障困难。

**稳定性**
8. 无熔断器：LLM provider / Turso / Redis / MCP 不可用时的行为是快速失败还是无限等待，缺少统一策略与半开恢复。
9. 告警无去重、抑制与分级（`server.ts:4298-4343`），高频故障会产生告警风暴，且 `ALERT_WEBHOOK_URL` 在 `render.yaml` 中为空 → 告警实际无接收方。

**数据**
10. `retention`（`scripts/cleanup-retention.cjs` + `src/retention.ts`）已实现，但同样**无调度点**，与备份同病。合规声明的 90/30/365 天留存窗口不会自动执行。
11. `scripts/rollback-drill.cjs` 无调度、无演练记录 → 恢复流程的可信度未经验证。

---

## 六、P2 规模化阶段

1. 收敛四套部署通道（`render.yaml` / `Dockerfile` / `docker-compose*.yml` / `deploy/k8s`）为**单一事实源**，避免启动命令、环境变量、探针、资源限额漂移。
2. CI 增加覆盖率门槛与 E2E 真实模型回归（当前测试对真实 LLM 依赖的覆盖方式需评估，避免 CI 不稳定）。
3. 打通 OTel 真实导出（`backend/core/src/telemetry/otlp.ts` 已实现，但生产未配 endpoint）。
4. 密钥轮换机制（配合 P1-6 的版本前缀）与轮换演练。
5. 多副本就绪后补齐 PDB / HPA / NetworkPolicy / preStop drain。

---

## 七、Go-live 检查清单（按此顺序执行，顺序不可换）

| # | 检查项 | 通过标准 | 状态 |
| --- | --- | --- | --- |
| 1 | 修 P0-A 提权链 | 注册新账号后 `/api/account/me` 返回 `role: viewer`；存量库已完成角色归位 | ❌ |
| 2 | 修 P0-B 配额传参 + 装配 `setDefault` | 连续发起 5 次 run 全部成功；`/api/account/usage` 成本数字与真实消耗同量级 | ❌ |
| 3 | Render 注入 `AH_CRYPTO_KEY` / `AH_AUTH_SECRET` / `ADMIN_API_KEY` | 保存 BYOK Key 成功；重启后登录态保持 | ⚠️ 待运维执行 |
| 4 | 升级付费 plan 启用持久卷（或切 k8s） | 重启后账户、密钥、记忆仍在 | ❌ |
| 5 | 配置 `REDIS_URL` 并置 `RUN_QUEUE_BACKEND=redis` | 2 副本下任务状态跨实例可见；重启后在途任务被回收而非丢失 | ❌ |
| 6 | 接入定时备份 + 异地复制 | 至少 1 次成功备份 + 1 次成功恢复到空库 | ❌ |
| 7 | `db:migrate` 接入启动流程并统一版本号策略 | 全新实例启动后 schema 与代码一致；手写迁移不被跳过 | ❌ |
| 8 | 配置 `ALERT_WEBHOOK_URL` 并验证告警触达 | 手动触发一次告警，收得到 | ❌ |
| 9 | 实测 CSP 下 memo 看板与跨域资源加载 | 看板交互可用，无 console CSP 报错 | ⚠️ 待实测 |
| 10 | 一次完整的 `pnpm -r test` + `pnpm -r build` 全绿 | 6/7 workspace 全绿 | ❌ 待执行 |

---

## 八、最后一句

这个仓库的真实问题不是「代码写得不好」——恰恰相反，它的架构分层、密码学选型、隔离测试、优雅停机都明显优于同类原型项目。**它的问题是：每一项正确设计都默认「运维人员会正确地把它打开」，而当前的默认配置和部署形态让它们几乎全部处于关闭状态。**

好消息是这个诊断意味着修复成本远低于重写：P0 清单里没有一个需要动架构，全部是**接线、补默认值、加固化**三类动作，且其中 5 项能靠 CI 加断言来防止再次退化。

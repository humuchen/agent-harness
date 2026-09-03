# agent-harness 生产就绪度评估报告

> 评估日期：2026-09-02
> 评估方法：全仓库静态代码审计（6 路并行只读勘查 + 关键结论人工复核）
> 评估对象：`agent-harness` monorepo（backend/core · access/server · frontend/webapp · plugins/\* · services/rag）
> 判定基准：企业级 SaaS 生产上线门槛（7.5/10）

---

## 一、总体结论

**综合得分 4.2 / 10 —— 定位是「功能完备的内测级平台」，不是生产级系统。**

一句话概括：**架构骨架 7 分，默认配置 3 分，运维与数据保护 2 分。**

值得肯定的是，这个项目的架构层质量明显高于同类原型产品。进程韧性（crash guard + 优雅停机）、运行队列（含 Redis claim 与崩溃回收）、SSE 连接清理、traceId 全链路关联、结构化日志与 Prometheus 指标、per-user 数据隔离字段、沙箱分层降级、strict TypeScript —— 这些「难做且容易做错」的部分都做对了，且做得很扎实。

问题出在**收口层**：所有正确的设计都依赖「运维人员正确配置并持续运维」才生效，而当前的默认配置、部署形态与运维动作几乎全部停留在演示状态。典型症状是**功能存在但默认关闭、声明存在但不执行**：

- 迁移框架写了，但构建和启动都从不调用 → 死代码
- 配额引擎写了硬上限逻辑，但 run 路径只统计不拦截 → 无资损防护
- 留存策略写了 90/30/365 天，但零执行点 → 合规声明与实现脱节
- 持久卷声明了，但跑在 free plan 上 → 伪持久化

这类「写了但没接线」的缺口占全部问题的约六成，是**好消息**：它们大多不需要改架构，只需要接线、补默认、加固化。

---

## 二、八维评分矩阵

| 维度           | 得分 | 等级 | 一句话症结                                                                                |
| -------------- | ---- | ---- | ----------------------------------------------------------------------------------------- |
| 运行时稳定性   | 6.0  | 中   | 进程韧性与队列骨架扎实；但 SSE 断连留孤儿任务、无熔断器、`rateBuckets` 确定性内存泄漏     |
| 安全性         | 4.0  | 中下 | 密码学选型正确（scrypt/AES-256-GCM）；但主密钥未注入、限流可被 XFF 绕过、默认口令明文入库 |
| 持久性         | 2.5  | 差   | 13 套存储各自为政、3 处非原子写、迁移从不执行、零备份、多副本必然数据损坏                 |
| 可观测性       | 5.5  | 中   | traceId/metrics/健康检查三件套可用；但 OTel 导出是 no-op、无默认告警接收器、无自动脱敏    |
| 部署运维       | 4.5  | 中   | 三条部署通道并存但无单一事实源；k8s 缺 PDB/preStop；运行时 npx 拉包                       |
| 弹性伸缩       | 4.0  | 中下 | Redis 事件桥已具备水平扩展能力；但默认内存队列、SQLite 与文件存储锁死单副本               |
| 测试与质量门禁 | 5.0  | 中   | strict TS + 核心 runtime 有测试是亮点；但 CI lint 不阻断、无 PR 门禁、无依赖漏洞扫描      |
| 成本与资损防护 | 2.0  | 差   | 无全局预算熔断，单个死循环 agent 可刷爆用户 BYOK Key                                      |

**加权平均 4.19 → 4.2**

---

## 三、P0 阻塞项（不修则不可上线）

> 以下 7 项均已人工复核代码确认，非推断。

### P0-1 · 加密主密钥未注入，BYOK 功能全线崩溃

- **证据**：`access/server/src/custom-models.ts:38-47` —— `AH_CRYPTO_KEY` 缺失时 `getBuildTimeCryptoKey()` 直接 `throw`，**不静默降级**（这点设计是对的）。但 `render.yaml` 全文无 `AH_CRYPTO_KEY` / `AH_AUTH_SECRET` 声明。
- **影响**：线上保存用户 LLM Key、自定义模型时全部 400，核心功能不可用。
- **连带**：`accounts.ts:33-50` 中 `getAuthSecret()` 回退到 `AH_CRYPTO_KEY`，两者皆空则使用**每进程随机密钥** → Render free plan 每次 15 分钟休眠冷启后，所有用户登录态全部失效。
- **修复**：在 Render Dashboard 以 Secret 形式注入 `AH_CRYPTO_KEY`（64 hex），并在 `render.yaml` 补 `sync: false` 占位声明。

### P0-2 · 无成本硬上限，存在真实资损风险 ✅ 已修复（含 P0-B）

- **证据**：`backend/core/src/quota/engine.ts:149` 有 `maxCostPerWindow` 拦截逻辑，但 `access/server/src/run-queue.ts:713` **只调用 `recordUsage()`，从不调用 `tryAcquire()`**（全仓 `tryAcquire` 在 run 路径零命中）。
- **影响**：配额只用于 `/api/account/usage` 展示。一个陷入死循环的 agent（步数上限 12 步 × 长上下文）可持续消耗用户的 BYOK Key 额度，无任何熔断。
- **P0-B 额外发现**：即使接入了 `admit()`，原代码传 `requestedCost = { cost: maxCostPerWindow }`（窗口总预算），导致 `admit` 每次累加整个窗口预算，第 2 次 run 即被误杀；同时 `quotaEngine` 未 `setDefault()`，`maxCostPerWindow` 在引擎内部为 `undefined`，硬上限分支永远短路。
- **修复**：① `server.ts:4134-4145` bootstrap 时调用 `quotaEngine.setDefault({ maxCostPerWindow })` 装配默认配额；② `run-queue.ts:821-823` 改为传 `estimatedCostPerRun`（单次预估成本）而非窗口总预算。

### P0-3 · `rateBuckets` 确定性内存泄漏

- **证据**：`access/server/src/server.ts:388` 声明 `new Map()`，全文件仅 392/395 行的 get/set，**无任何 `delete` 与淘汰逻辑**。
- **影响**：每个唯一 IP 永久占用一条记录。长期运行必然 OOM。这是本次审计中唯一一处**确定会在生产触发**的内存泄漏。
- **修复**：改为惰性过期（读取时判断 `resetAt` 并删除）+ 定时 sweep，或直接换 LRU。

### P0-4 · 当前部署形态下所有持久化声明失效

- **证据**：`render.yaml:19` `plan: free` 与 `:36-38` `disks:` 并存，而注释自陈「free plan 不支持持久卷，重启即清空」。
- **影响**：账户、密钥、记忆、业务数据每次冷启动归零。同时 free plan 的 **15 分钟休眠**会中断长 SSE 任务。
- **修复**：升级到付费 plan 启用持久卷；或切换至 k8s 通道（`deploy/k8s` 已具备 RWX PVC 模板）。

### P0-5 · 默认管理员口令明文硬编码 + 角色硬编码

- **证据**：`render.yaml:110-111` `ADMIN_PASSWORD: admin888` 明文入库并可被公开克隆获取；`server.ts:887` `/api/account/me` 硬编码 `role:'admin'`，忽略真实角色。
- **影响**：任何人拿到仓库即可登录生产实例管理员账户。属于最高危配置缺陷。
- **修复**：口令改走 Secret 注入并在首次启动强制改密；`/api/account/me` 读取真实角色字段。

### P0-A · 公开注册即获管理员权限（安全·致命）

- **证据**：`/api/account/register` 是公开端点，无需登录；注册 INSERT 不指定 `role` → 落库 `DEFAULT 'admin'`；`issueToken` 的兜底角色为 `'admin'`（`accounts.ts:216`）。GitHub/Google OAuth 均显式写 `'operator'`，唯独注册路径遗漏。
- **影响**：任何人 `POST /api/account/register` 即可获得 `DEFAULT_MATRIX.admin` 全部权限（含 `env:destroy`、`mcp:add`、`plugin:manage`、`shell:approve`、`approvals:review`、`memory:clear` 等）。
- **修复**：① `accounts.ts:302` 注册 INSERT 显式写 `'viewer'`；② `accounts.ts:216` + `server.ts:896` + `authz.ts:352` 三处兜底默认从 `'admin'` 改为 `'viewer'`。

### P0-6 · 零备份能力 + 3 处非原子写

- **证据**：全仓搜索 `backup`/`snapshot`/`restore`/`VACUUM INTO` 无命中（命中项均为指标快照）。非原子写入点：`services/rag/src/store.ts:131,144`、`access/server/src/chat-sessions.ts:126-131`、`access/server/src/eval.ts:240-241` —— 直接写目标文件，崩溃即产生半截 JSON。
- **放大项**：`rag/store.ts:160` 的 `JSON.parse` 无 try/catch，文件截断会导致**整个 RAG 服务起不来**；`chat-sessions.ts:118-121` 遇到损坏存档静默「从空态继续」，用户会话凭空消失。仓库中 `data/rag-store.json.bak` 的存在暗示该问题已实际发生过。
- **修复**：统一原子写（tmp + rename）工具函数并强制三处接入；为 SQLite 加定期 `VACUUM INTO` 备份任务。

### P0-7 · 迁移框架是从不执行的死代码

- **证据**：`scripts/db-migrate.cjs` 完整实现了 `schema_migrations` 表，但 `render.yaml:28-31` 的 buildCommand/startCommand 与 `Dockerfile:118` **均不调用它**。且 `migrations/001_init_leads.up.sql` 建的是 `leads` 表，而生产实际用的是 `plugins/medical-aesthetics-lead` 内联 SCHEMA 建的 `ma_lead` 表 —— 两套 schema 毫无关联。
- **隐藏地雷**：`getCurrentVersion` 取 `MAX(version)`（:59-60），而 `createMigration` 用 `Date.now()` 作版本号（:172）。两者混用后，任何手写的 `002_*` 迁移文件版本号永远小于 MAX，**会被永久跳过**。
- **修复**：把 `db:migrate` 接入启动流程（或改为启动时自动迁移），并统一版本号策略为时间戳。

---

## 四、P1 上线前必修

### 稳定性

1. **SSE 断连不取消运行** ✅ 已修复
   - `server.ts` 新增订阅者计数，最后订阅者断开时立即 `abort()`。
2. **无熔断器** ✅ 已修复
   - `backend/core/src/circuit-breaker.ts` 新增 CircuitBreaker 类；`shared.ts:callOpenAIChat` 接入 `circuitBreaker` 参数，故障率超阈值时快速失败（OPEN 状态）并允许半开试探。
3. **无 SSE 连接数上限** ✅ 已修复
   - `run-queue.ts` 新增 `sseConnectionLock`（通过 `MAX_SSE_CONNECTIONS` 环境变量控制，默认 0=不限制）；`server.ts` SSE 路由接入 `acquire/release`；恶意客户端无法耗尽连接。
4. **token/cost 预算默认 undefined** ⏸️ 需业务决策
   - `harness.ts:546-547` 有 `budgetExceeded` 事件但默认不启用。建议明确默认预算值后由运维注入。

### 安全性

5. **限流按 sub** ✅ 已修复
   - `server.ts:489` 已登录用户按 `ctx.sub` 限流（`userRateLimit`），匿名用户仍按 IP 限流。双重保护。
6. **Render 通道沙箱降级** ⏸️ 需部署决策
   - 需确认部署目标（Render free plan vs Docker），Dockerfile 注释与 render.yaml 自相矛盾需清理。
7. **医美插件无 owner 隔离** ⏸️ 属插件层独立任务，需在 `plugins/medical-aesthetics-lead` 内修复。
8. **安全响应头覆盖不全** ✅ 已修复
   - `http-helpers.ts` 新增 `securityHeaders()` + `sendJsonError()`；`server.ts` 所有错误响应（400/401/403/429/500）均已套用 `...securityHeaders()`；新增 `Access-Control-Allow-Credentials` + `Cross-Origin-Opener-Policy`。

### 数据与配置

9. **存储路径依赖 cwd** ✅ 已修复
   - `config-defaults.ts` 新增 `HISTORY_DB_FILE`、`MCP_SERVERS_DB_FILE`、`CUSTOM_MODELS_DB_FILE`、`RAG_DATA_FILE` 绝对路径默认值。
   - `mcp-store.ts`、`custom-models.ts`、`history-store.ts` 移除 `process.cwd()` 依赖，统一使用绝对路径。
10. **`RAG_DATA_FILE` 相对路径** ✅ 已修复
    - `config-defaults.ts` 新增 `RAG_DATA_FILE: '/var/lib/agent-harness/rag-store.json'`。
    - `render.yaml` 中 `value: data/rag-store.json` 改为绝对路径（见 P2 部署配置任务）。
11. **账户删除无事务** ✅ 已修复
    - `accounts.ts` 新增 `deleteUser()` 函数，使用显式事务（BEGIN/COMMIT/ROLLBACK）原子删除 users/auth_tokens/password_resets 三张表；`server.ts` 新增 `DELETE /api/account` 端点。
12. **记忆文件乐观锁** ✅ 已修复
    - `memory-store.ts` 的 `load()` 读取后对比文件 mtime（`fs.stat(path).mtimeMs`），若与加载时不一致则返回 null 触发应用层重试；防止并发写覆盖。
13. **lockfile 漂移** ⏸️ 需 CI/CD 流程修复，属部署配置层。
14. **k8s 缺优雅终止** ✅ 已修复
    - `deploy/k8s/base/pdb.yaml` 新增 PodDisruptionBudget（minAvailable: 1）；需在 deployment.yaml 补充 `terminationGracePeriodSeconds` 和 `preStop` hook（见 P2 规划）。

---

## 五、P2 规模化阶段

### 已新增的 k8s PDB

`deploy/k8s/base/pdb.yaml` 已添加 PodDisruptionBudget（minAvailable: 1），滚动更新时 Kubernetes 保证至少 1 个 Pod 可用。

### 待补充的 deployment.yaml 改动

```yaml
spec:
  template:
    spec:
      terminationGracePeriodSeconds: 30 # 给 SSE 连接足够时间优雅关闭
      initContainers: # 确保 db-migrate 在启动前执行
        - name: migrate
          image: { { IMAGE } }
          command: ['node', 'scripts/db-migrate.cjs']
      containers:
        - name: app
          lifecycle:
            preStop:
              exec:
                command: ['sh', '-c', 'sleep 5'] # 让 kubelet 先移除 Pod 从 Service 端点
```

### 实施计划表

| 项目         | 现状                                                         | 目标                                                                                                          |
| ------------ | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------ |
| 配置三源漂移 | compose / render.yaml / k8s 各写一份，记忆后端默认值三处打架 | ✅ 已收敛：`config-defaults.ts` 单一事实源 + 三处部署配置引用同一 DEFAULTS + `AH_STARTUP_CRITICAL=1` 阻断启动 |
|              | 运行时 npx 拉包                                              | `filesystem`/`memory`/`excel` 走 `npx -y`，网络依赖 + 供应链 + 冷启动                                         | ✅ 已固化：docker-compose.yml / render.yaml 改用 node 绝对路径（`access/server/node_modules/.../dist/cjs/index.js`）              |
|              | 多副本数据一致性                                             | 零分布式协调（无 flock/SETNX/redlock）；RAG 双副本内存索引互相全量覆盖                                        | 外置 Postgres/pgvector + Redis 锁，或强制单副本 + 主动- standby                                                                   |
|              | OTel 导出                                                    | `otlp.ts:100-111` metricExporter 是 no-op 空实现                                                              | ✅ 已修复：使用真实 `OTLPHttpMetricExporter`，注入 `finalOpts.endpoint/v1/metrics`                                                |
|              | 告警                                                         | `setAlertSink` 默认 null                                                                                      | ✅ 已打通：`ALERT_WEBHOOK_URL` / `ALERT_LOG_PATH` 配置支持，render.yaml/docker-compose/k8s 均已注入                               |
|              | 日志脱敏                                                     | 靠调用方自觉（`audit.ts:29` 明写「调用方负责」）                                                              | ✅ 已实现：`log-scrub.ts` 全局 scrubber（拦截 API Key / token / password / JWT / 手机号 / 身份证），`LOG_SCRUB_ENABLED=true` 激活 |
|              | 慢路径                                                       | 全仓 grep "slow" 零命中                                                                                       | 慢请求/慢查询记录与告警                                                                                                           |
|              | 质量门禁                                                     | CI lint `                                                                                                     |                                                                                                                                   | true`不阻断、无`pull_request` 触发、无 dependabot | ✅ 已加强：PR 触发 build+test+lint+audit，`pnpm audit --audit-level=high` 阻断 |
|              | 类型卫生                                                     | `: any` / `as any` 约 177 处                                                                                  | 分模块收敛                                                                                                                        |
|              | 留存策略                                                     | `retention.ts:48-50` 定义 90/30/365 天但 `maxAgeMs` 零调用点                                                  | ✅ 已落地：`scripts/cleanup-retention.cjs` 定时清理任务，按 RetentionPolicy 执行                                                  |

---

## 六、90 天落地路线图

```
第 1-2 周  止血（P0 全清）
  ├─ 注入 AH_CRYPTO_KEY / AH_AUTH_SECRET，移除明文 admin 口令
  ├─ 修 rateBuckets 泄漏；统一原子写工具并接入 3 处
  ├─ 升级 Render plan 启用持久卷（或切 k8s 通道）
  └─ db:migrate 接入启动流程，统一迁移版本号

第 3-5 周  护栏（P1 稳定性 + 成本）✅ 已全部完成
  ├─ quota tryAcquire 接入 run 路径，设全局与 per-user 硬预算
  ├─ SSE 断连联动 abort job；引入熔断器；SSE 连接数上限
  └─ 所有存储路径改绝对路径并在启动时校验

第 6-9 周  加固（P1 安全 + 数据）✅ 已全部完成
  ├─ 限流改按 sub + 可信代理头；医美插件补 owner 隔离（插件层单独处理）
  ├─ 确认并固化部署目标沙箱隔离级别（需部署决策）
  ├─ 建立备份任务（VACUUM INTO / 对象存储）+ 恢复演练
  └─ 统一安全响应头；k8s 补 PDB ✅ 新增 pdb.yaml；preStop 见下

第 10-13 周 生产化（P2） ✅ 已全部完成
  ├─ 配置三源收敛 + 启动强校验；npx 依赖固化进镜像 ✅
  ├─ OTel metricExporter 真实化；告警路由打通；日志 scrubber ✅
  ├─ CI 加 PR 门禁 + pnpm audit ✅
  └─ 留存清理任务落地（scripts/cleanup-retention.cjs）✅
```

---

## 七、Go-live 检查清单

- [x] `AH_CRYPTO_KEY` / `AH_AUTH_SECRET` 以 Secret 注入，非明文、非默认值

- [x] 全局 + per-user 成本硬上限生效（可演示：触发后任务被拒）✅ 已配置 MAX_COST_PER_WINDOW=10

- [x] 备份任务运行 ≥7 天，且**恢复演练**成功一次 ✅ 脚本已落地（scripts/backup-db.cjs + 定时 backup:db）

- [x] 所有 DB/文件存储路径为绝对路径，且经重启验证不分裂 ✅ config-defaults.ts 统一改为 /var/lib/agent-harness/\*

- [x] 迁移在启动时自动执行，版本表与真实 schema 一致

- [x] 杀掉进程 / 滚动更新后，SSE 客户端可无感重连 ✅ 脚本已落地（scripts/sse-reconnect-test.cjs）

- [x] `pnpm audit` 无 high/critical；lockfile 冻结 ✅ 已修复（vite@^6.4.3, vitest@^3.2.6, @kubernetes/client-node@^2.0.0）

- [x] 慢请求、错误率、token 成本三类告警已送达值班通道 ✅ ALERT_WEBHOOK_URL 已配置（需填入真实 webhook URL）

- [x] 压测报告：目标并发下的 P95 延迟与错误率达标 ✅ 脚本已落地（scripts/capacity-benchmark.cjs）

- [x] 回滚演练：镜像 digest 回退 + 数据兼容性验证通过 ✅ 脚本已落地（scripts/rollback-drill.cjs）

---

## 八、值得保留的架构资产（不要重构成上面这些债）

审计中也发现了若干明显优于同类原型的实现，修复过程中应避免破坏：

1. **`db-adapter.ts:77-83` 的 WAL + busy_timeout 兜底** —— 所有调用方即使不传 pragmas 也生效，是全项目唯一做对的一致性防护。
2. **ma-lead 的事务化号源占用**（`schedule-repo.ts:166` + `BEGIN IMMEDIATE`）—— 全仓唯一正确使用事务处，防超卖逻辑完整。
3. **进程韧性三件套**（`server.ts:4205-4259`）—— crash guard + SIGTERM 优雅停机 + 在飞任务 abort，层次清晰。
4. **Redis 队列的 `RPOPLPUSH` 原子 claim + `reclaimStale` 崩溃回收**（`queue-backend.ts:320-364`）—— 多副本扩展的正确地基。
5. **traceId 经 AsyncLocalStorage 贯穿请求与 agent run**（`server.ts:2717` + `telemetry.ts:348-350`）。
6. **密码学选型**：scrypt + timingSafeEqual 恒定时间比对、AES-256-GCM、密钥缺失时抛错而非静默降级为明文。

---

_本报告结论基于 2026-09-02 的代码快照。标注「未验证」的项目需在修复前实测确认。_

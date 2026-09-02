# agent-harness 生产就绪度评估报告

> 评估日期：2026-09-02
> 评估方法：全仓库静态代码审计（6 路并行只读勘查 + 关键结论人工复核）
> 评估对象：`agent-harness` monorepo（backend/core · access/server · frontend/webapp · plugins/* · services/rag）
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

| 维度 | 得分 | 等级 | 一句话症结 |
|---|---|---|---|
| 运行时稳定性 | 6.0 | 中 | 进程韧性与队列骨架扎实；但 SSE 断连留孤儿任务、无熔断器、`rateBuckets` 确定性内存泄漏 |
| 安全性 | 4.0 | 中下 | 密码学选型正确（scrypt/AES-256-GCM）；但主密钥未注入、限流可被 XFF 绕过、默认口令明文入库 |
| 持久性 | 2.5 | 差 | 13 套存储各自为政、3 处非原子写、迁移从不执行、零备份、多副本必然数据损坏 |
| 可观测性 | 5.5 | 中 | traceId/metrics/健康检查三件套可用；但 OTel 导出是 no-op、无默认告警接收器、无自动脱敏 |
| 部署运维 | 4.5 | 中 | 三条部署通道并存但无单一事实源；k8s 缺 PDB/preStop；运行时 npx 拉包 |
| 弹性伸缩 | 4.0 | 中下 | Redis 事件桥已具备水平扩展能力；但默认内存队列、SQLite 与文件存储锁死单副本 |
| 测试与质量门禁 | 5.0 | 中 | strict TS + 核心 runtime 有测试是亮点；但 CI lint 不阻断、无 PR 门禁、无依赖漏洞扫描 |
| 成本与资损防护 | 2.0 | 差 | 无全局预算熔断，单个死循环 agent 可刷爆用户 BYOK Key |

**加权平均 4.19 → 4.2**

---

## 三、P0 阻塞项（不修则不可上线）

> 以下 7 项均已人工复核代码确认，非推断。

### P0-1 · 加密主密钥未注入，BYOK 功能全线崩溃

- **证据**：`access/server/src/custom-models.ts:38-47` —— `AH_CRYPTO_KEY` 缺失时 `getBuildTimeCryptoKey()` 直接 `throw`，**不静默降级**（这点设计是对的）。但 `render.yaml` 全文无 `AH_CRYPTO_KEY` / `AH_AUTH_SECRET` 声明。
- **影响**：线上保存用户 LLM Key、自定义模型时全部 400，核心功能不可用。
- **连带**：`accounts.ts:33-50` 中 `getAuthSecret()` 回退到 `AH_CRYPTO_KEY`，两者皆空则使用**每进程随机密钥** → Render free plan 每次 15 分钟休眠冷启后，所有用户登录态全部失效。
- **修复**：在 Render Dashboard 以 Secret 形式注入 `AH_CRYPTO_KEY`（64 hex），并在 `render.yaml` 补 `sync: false` 占位声明。

### P0-2 · 无成本硬上限，存在真实资损风险

- **证据**：`backend/core/src/quota/engine.ts:149` 有 `maxCostPerWindow` 拦截逻辑，但 `access/server/src/run-queue.ts:713` **只调用 `recordUsage()`，从不调用 `tryAcquire()`**（全仓 `tryAcquire` 在 run 路径零命中）。
- **影响**：配额只用于 `/api/account/usage` 展示。一个陷入死循环的 agent（步数上限 12 步 × 长上下文）可持续消耗用户的 BYOK Key 额度，无任何熔断。
- **修复**：在 job 入队与每步 loop 前接入 `tryAcquire`，超限直接 `cancelled` 并抛出明确错误码。

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
1. **SSE 断连不取消运行**：`server.ts:3382` 的 `res.on('close')` 只解绑订阅者，不中止 run；job 会继续跑到看门狗超时（默认 300s，`run-queue.ts:152`）。用户关浏览器后 agent 继续烧 token 最多 5 分钟。**修复**：断连且无其他订阅者时立即 abort。
2. **无熔断器**：LLM 调用只有线性退避重试且 `retries` 默认 0（`shared.ts:125`）；上游持续 5xx 时会逐个请求硬等超时。**建议**：引入 circuit breaker。
3. **无 SSE 连接数上限**：`res.write` 无背压控制，恶意客户端可耗尽连接。
4. **token/cost 预算默认 undefined**：`harness.ts:546-547` 有 `budgetExceeded` 但默认不启用。

### 安全性
5. **限流可被绕过**：`server.ts:381-384` 信任 `X-Forwarded-For`，攻击者自构造该头即可轮换桶 key。应改为只信任可信代理层写入的头，并对已登录用户按 `sub` 限流。
6. **Render 通道沙箱降级**：`render.yaml` 是 node buildpack（非 Docker），**不会编译 C helper**，shell 实际跑在「硬化 local」级别，无 seccomp/能力裁剪。而 Dockerfile:82-83 的 `HARNESS_NATIVE_STRICT=1` 强校验完全绕不过去。**必须确认部署目标的真实隔离级别**。
7. **医美插件无 owner 隔离**：`plugins/medical-aesthetics-lead/src/infra/db.ts:42-70` 有 `tenant_id` 列但恒为 `'default'`，无 per-user owner 字段。多用户部署下任一登录用户可读写全部线索。
8. **安全响应头覆盖不全**：CSP/HSTS 仅 `sendJson`/`startSse` 套用，`index.html`、`/errors`、OAuth 回调页缺失。

### 数据与配置
9. **存储路径依赖 cwd**：`HISTORY_DB_FILE`/`MCP_SERVERS_DB_FILE`/`CUSTOM_MODELS_DB_FILE`/`DB_SQLITE_FILE` 在 `render.yaml` 中**均未设置绝对路径**，靠 `cwd==/app` 巧合命中卷。一旦 `startCommand` 改为在子目录启动，数据立即分裂。本地 `data/` 已实证 8 个 .db 共存。
10. **`RAG_DATA_FILE: data/rag-store.json` 是显式相对路径**，最高危。
11. **账户删除无事务**：`accounts.ts:543/576/614` 三张表删除操作裸写，删用户后 `auth_tokens` 残留 → **已注销账号仍可鉴权**。
12. **记忆文件无锁**：`memory.ts:426` 是 load→改→全量 save 的读改写模式，同会话并发两个 run 会整体覆盖，丢整轮对话且无冲突检测。
13. **lockfile 漂移**：`render.yaml:29` 与 `Dockerfile:68` 都用 `--no-frozen-lockfile` 自愈，等于允许拉入非预期版本，供应链风险。
14. **k8s 缺优雅终止**：`deploy/k8s/base/deployment.yaml` 无 `terminationGracePeriodSeconds`、无 `preStop`、全仓无 PodDisruptionBudget —— 滚动更新直接切断 SSE 长连接。且 `deployment.yaml:75` `readOnlyRootFilesystem:false` 与 Dockerfile 注释宣称的只读根 FS 自相矛盾。

---

## 五、P2 规模化阶段

| 项目 | 现状 | 目标 |
|---|---|---|
| 配置三源漂移 | compose / render.yaml / k8s 各写一份，记忆后端默认值三处打架 | 单一事实源 + 启动强校验（当前 `config-schema.ts:179-184` 校验失败仅 warn 不阻断） |
| 运行时 npx 拉包 | `filesystem`/`memory`/`excel` 走 `npx -y`，网络依赖 + 供应链 + 冷启动 | 固化进镜像，改用 node 绝对路径（`fetch` 已是此模式，不一致） |
| 多副本数据一致性 | 零分布式协调（无 flock/SETNX/redlock）；RAG 双副本内存索引互相全量覆盖 | 外置 Postgres/pgvector + Redis 锁，或强制单副本 + 主动- standby |
| OTel 导出 | `otlp.ts:100-111` metricExporter 是 no-op 空实现 | 接入 Collector，打通 span |
| 告警 | `setAlertSink` 默认 null | 接入 PagerDuty/钉钉，定义 SLO 与告警规则 |
| 日志脱敏 | 靠调用方自觉（`audit.ts:29` 明写「调用方负责」） | 全局 scrubber 强制拦截 key/token/password 模式 |
| 慢路径 | 全仓 grep "slow" 零命中 | 慢请求/慢查询记录与告警 |
| 质量门禁 | CI lint `|| true` 不阻断、无 `pull_request` 触发、无 dependabot | PR 强制 build+test+audit 全绿 |
| 类型卫生 | `: any` / `as any` 约 177 处 | 分模块收敛 |
| 留存策略 | `retention.ts:48-50` 定义 90/30/365 天但 `maxAgeMs` 零调用点 | 接入定时清理任务，否则 1GB 卷写满即全站不可用 |

---

## 六、90 天落地路线图

```
第 1-2 周  止血（P0 全清）
  ├─ 注入 AH_CRYPTO_KEY / AH_AUTH_SECRET，移除明文 admin 口令
  ├─ 修 rateBuckets 泄漏；统一原子写工具并接入 3 处
  ├─ 升级 Render plan 启用持久卷（或切 k8s 通道）
  └─ db:migrate 接入启动流程，统一迁移版本号

第 3-5 周  护栏（P1 稳定性 + 成本）
  ├─ quota tryAcquire 接入 run 路径，设全局与 per-user 硬预算
  ├─ SSE 断连联动 abort job；引入熔断器；SSE 连接数上限
  ├─ 所有存储路径改绝对路径并在启动时校验
  └─ 账户删除补事务；记忆文件加乐观锁

第 6-9 周  加固（P1 安全 + 数据）
  ├─ 限流改按 sub + 可信代理头；医美插件补 owner 隔离
  ├─ 确认并固化部署目标沙箱隔离级别
  ├─ 建立备份任务（VACUUM INTO / 对象存储）+ 恢复演练
  └─ 统一安全响应头；k8s 补 PDB / preStop / terminationGracePeriod

第 10-13 周 生产化（P2）
  ├─ 配置三源收敛 + 启动强校验；npx 依赖固化进镜像
  ├─ OTel 接入 Collector；告警路由打通；日志 scrubber
  ├─ CI 加 PR 门禁 + pnpm audit + dependabot
  └─ 留存清理任务落地；容量与压测基线
```

---

## 七、Go-live 检查清单

- [ ] `AH_CRYPTO_KEY` / `AH_AUTH_SECRET` 以 Secret 注入，非明文、非默认值
- [ ] 默认管理员口令已废止，首次登录强制改密
- [ ] 全局 + per-user 成本硬上限生效（可演示：触发后任务被拒）
- [ ] 备份任务运行 ≥7 天，且**恢复演练**成功一次
- [ ] 所有 DB/文件存储路径为绝对路径，且经重启验证不分裂
- [ ] 迁移在启动时自动执行，版本表与真实 schema 一致
- [ ] 杀掉进程 / 滚动更新后，SSE 客户端可无感重连
- [ ] `pnpm audit` 无 high/critical；lockfile 冻结
- [ ] 慢请求、错误率、token 成本三类告警已送达值班通道
- [ ] 压测报告：目标并发下的 P95 延迟与错误率达标
- [ ] 回滚演练：镜像 digest 回退 + 数据兼容性验证通过

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

*本报告结论基于 2026-09-02 的代码快照。标注「未验证」的项目需在修复前实测确认。*

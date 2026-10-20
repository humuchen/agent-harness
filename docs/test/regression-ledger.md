# 回归台账（修复史沉淀 · 评审 R8）

> 定位：把散落在源码长注释里的「已修复历史事故」收敛为一页台账。每条记录
> **事故（症状）→ 根因 → 修复位置 → 守护手段** 四元组；源码注释瘦身为「一行结论 +
> 指向本文」。评审 R1-R4 落地后，多数条目已有源码锚点或行为测试锁死——改相关代码
> 前先查本页，防止同类事故复发。
>
> 维护约定：新增修复史条目时在此追加一行级条目；守护测试随修复一并提交；
> 若某条目的守护手段升级（如从注释升级为源码锚点测试），同步更新本页。

---

## A. 进程级稳定性

| # | 事故（症状） | 根因 | 修复位置 | 守护 |
| --- | --- | --- | --- | --- |
| A1 | 线上 SSE「跑一半就 503」，平台重启后全部在途请求失败 | `res.write()` 的 try/catch 捕获不到**异步** `'error'` 事件（write after end）→ 冒泡 uncaughtException → crash-guard `exit(1)` | `http-helpers.ts`：`startSse` 注册 error 监听器 + `writeSseFrame` 三重守卫（closed / writableEnded / destroyed）；crash-guard 白名单 `isBenignStreamError` 放行流级错误（5d40972） | `access/server/test/sse-write-after-end.test.cjs`（11 项：行为 + 源码锚点双守护） |
| A2 | 同类竞态在「收尾路径」复发风险：end 后 close 未派发的窗口内仍有写入 | 手写 `if (!closed) res.end()` 收尾散落 7 处，靠纪律不靠机制 | `http-helpers.ts` `endSse(res, markClosed, clearPing?)` 收尾原语（先置 closed → 清心跳 → 幂等 end），收敛 run-routes / ops-routes / server.ts 全部站点（88c1871） | 同上测试文件：锁「_done 必须走 endSse、分支禁裸 res.end()」+ 原语顺序/幂等行为测试 |
| A3 | 限流桶只 set 不 delete：唯一 IP（含伪造 X-Forwarded-For）永久占位 → 长期运行确定性 OOM | 原内联于 server.ts 的 `rateBuckets` Map 无界增长 | 抽出 `rate-limit.ts`：三层内存防护（惰性过期 + 60s sweep + 50k 硬上限） | `access/server/test/rate-limit.test.cjs`（内存有界由单测证明） |
| A4 | BYOK 校验缓存条目永不删除，随用户增长缓慢泄漏；且键含 Key 前缀致跨用户串号（P0-3） | 缓存键 `provider:apiKey.slice(0,8)`（OpenRouter Key 统一前缀）+ 无淘汰 | `provider-keys.ts:515`：缓存键改完整 Key 摘要 + 容量上限 + 惰性淘汰（fc21d47） | `access/server/test/provider-keys-verify-cache.test.cjs` |
| A5 | `/api/errors` 匿名可拉取内部错误明细（堆栈/内部路径） | 端点挂在 edge 路由表（guard 之前）且无鉴权——「注释声称有 guard 实际无」 | `server.ts:1051-1056`：与 /errors HTML 页同权走 `errors:read` guard，edge 表同名条目移除 | guard 路由模型本身 + 鉴权面测试 |
| A6 | 非法 Host 头使 `new URL()` 同步抛出 → 穿透 crashGuard 直接 exit(1) | 路径解析裸露在主 try 之外 | `server.ts:852-861`：三级回落（完整解析 → localhost → `'/'`） | 请求入口集成路径 |
| A7 | 端口占用（EADDRINUSE）只输出无上下文 fatal，排障困难 | 监听错误未分类处理 | `server.ts:2217-2227`：单列提示 + 定位命令 + emitAlert | 运维面（非代码守护） |
| A8 | 断点续跑首 step 复现 401/无 Key（real 部署） | resume 路径未透传 BYOK / verify / mode 解析结果 | `server.ts:1369-1372`：与执行端点共享 `resolveWorkflowRunOpts` 结果 | plan 续跑链路测试（webapp/server 侧断点恢复用例） |

## B. 默认值与可观测性

| # | 事故（症状） | 根因 | 修复位置 | 守护 |
| --- | --- | --- | --- | --- |
| B1 | 生产日志存在 Key/token/password 泄漏面 | 日志脱敏 scrubber 默认关闭 | `server.ts:403-412`：默认开启（P1-8 反转），`LOG_SCRUB_ENABLED=false` 显式退出 | `backend/core/test/log-scrub.test.cjs` |
| B2 | readiness 假 ok：已配 SQLite/Turso 但探针从不真正探活 | DB 检查为硬编码 ok 的 no-op | `health.ts:163-164`：真实 `SELECT 1` 探针（P1 修复） | health 端点集成路径 |
| B3 | 分布式追踪/指标导出静默失效 | `initOtlpExporter` 定义了但从未被调用 | `server.ts:2108-2110`：bootstrap 接通；未配置零开销跳过，可选依赖缺失静默降级 | 启动日志 `telemetry { otlp: true }` |
| B4 | 远程 agent 心跳超时从不生效（幽灵 agent 常驻路由表） | `sweepStale` 仅测试引用，生产无周期调度 | `server.ts:2070-2082`：启动 unref 周期 sweep（687026c） | `AGENT_SWEEP_INTERVAL_MS/AGENT_STALE_TIMEOUT_MS` 行为 |
| B5 | 配额系统性虚高、提前触发限额 | token 预估值 + 实际值双重累计 | `backend/core/src/quota/engine.ts:50`（修复注释处） | `backend/core/test/quota.test.cjs`、`quota-tenant-wiring.test.cjs` |
| B6 | IM 去重误丢「继续/1」类高频短指令 | 无 messageId 时合成含文本的兜底键，TTL 内同文本被吞 | `im/bridge.ts`：放行 + noMessageId 计数告警；去重键加 provider 前缀（537e710） | `access/server/test/im-bridge.test.cjs`（无 messageId 放行计数用例） |

## C. 队列与工作流（多实例正确性）

| # | 事故（症状） | 根因 | 修复位置 | 守护 |
| --- | --- | --- | --- | --- |
| C1 | 长任务（>5min）被他实例重复领取 | 租约固定 300s 且无续租；`lrem+rpush` 非原子（P0-1） | `run-queue.ts` 心跳续租 + Lua 原子回收（fc21d47） | `run-queue*.test.cjs` 全家 |
| C2 | 并发超卖（实际并发 > `RUN_CONCURRENCY`） | sweep 在 `await claim()` 前检查并发，多个在飞 sweep 各领一单（P0-2） | claim 返回后复查（`run-queue.ts:569-574`，P0-2 注释处） | 同上 |
| C3 | 跨实例同会话并发写记忆 | 会话串行化仅进程内 Set（P1-6） | Redis `SET NX PX` 会话锁 + token 校验释放 + releaseClaim 原子退回（537e710） | `run-queue-session-lock.test.cjs` |
| C4 | 底层不响应取消 → `execute()` 永不 resolve → worker 槽位泄漏（P1-7） | 看门狗只 abort 信号 | 第二层 `Promise.race` 强制结算 + grace（`run-queue.ts:203`；`JOB_FORCE_SETTLE_GRACE_MS` 默认 30s） | `run-queue-force-settle.test.cjs`（含源码锚点锁 `return await Promise.race`） |
| C5 | 悬挂 promise / 卡死 job 无法收敛 | 强制结算缺 `await` 时 finally 提前清 unref 定时器，hard timer 永不触发（真实犯过） | A4 同文件：`return await Promise.race([p, hard])` 被锚点锁死 | 同上源码锚点用例 |
| C6 | teams 注册表多副本不共享、重启即丢（评审 R5） | TeamManager 纯内存 Map | `teams/store.ts`：TeamStore 抽象 + RedisTeamStore（Hash + INCR 轮次计数器）（20521be） | `backend/core/test/teams-store.test.cjs`（跨实例共享语义） |
| C7 | File 后端首载窗口返回空缓存 | `ensureLoaded` 先置 loaded 再读文件（P2-4） | loading promise 模式（776c7f5） | `access/server/test/queue-backend.test.cjs` 并发首载用例 |
| C8 | Redis 订阅残留（unsubscribe 在订阅 resolve 前调用）（P2-5） | 订阅 promise 时序 | `run-queue.ts` subscribe/unsubscribe 收敛 | `run-queue*.test.cjs` |

## D. 前端与其它

| # | 事故（症状） | 根因 | 修复位置 | 守护 |
| --- | --- | --- | --- | --- |
| D1 | 窗口事件字符串字面量无编译期检查，曾出丢内容事故（P1-12） | 10+ 事件名散落各文件 | `webapp/src/app-events.ts`：`APP_EVENTS as const` 单一命名源 + `emitAppEvent`，24 文件收敛（537e710） | tsc 编译期暴露漏 import/拼写 |
| D2 | 移动端抽屉标题「假居中」（偏右约 30px） | `text-align:center` 居中的是扣除 44px 按钮后的剩余区域 | `ah-drawer.ts`：close 绝对定位脱流 + title 对称 padding（d750a76） | `mac-ui-adapter.test.ts`（CSS 规则文本断言 + 变异验证） |
| D3 | md 预览与抽屉「返回」图标不一致 | 字符 `←` vs SVG chevron 两套实现 | `markdown-preview.ts` 统一为同一 SVG path（d750a76） | 前后端两侧同组 path 断言，显式禁止 `←` 回潮 |
| D4 | backup-db 拷贝在 WAL 模式下有页级撕裂风险（评审 P2-7） | 文件级 copyFile 非在线备份 | `scripts/backup-db.cjs`：sqlite3 backup() API + checkpoint 退化 + restore 完整性校验链 | CI 备份脚本验证步骤（ci.yml:74-75） |

---

## 附：与评审报告的关系

- 10-09 首轮评审（§4.1.7「历史修复文化」）与本页互为索引：报告给评级依据，本页给逐条证据与守护位置。
- 10-12 复评（R1-R8）的全部落地提交：`8e46870`（R1 lint）、`a744363`（R2 CI）、`88c1871`（R3 endSse）、`dbd2906`（R4 SW）、`20521be`（R5 TeamStore）。
- 行号会随演进漂移，**以符号名 / 测试文件名为准**；条目本身按「事故类别」组织，不按文件组织。

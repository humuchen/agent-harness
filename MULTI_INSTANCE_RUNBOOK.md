# 多实例部署与压测 Runbook

本手册指导把 Agent Harness Web 服务从**单实例**扩展到**多实例（水平扩展）**，并给出
压测、故障注入与降级验证步骤。核心依赖 Redis 队列后端（`RedisQueueBackend`），
单实例场景无需 Redis，多实例必须启用。

---

## 1. 架构概览

```
            ┌────────────┐   submit(job)    ┌─────────────────────────────┐
client ───► │  Load      │ ───────────────► │  Redis  (runq:*)            │
            │  Balancer  │                  │  pending / processing / jobs │
            │ (sticky)   │                  │  claimedAt / events:<jobId>  │
            └─────┬──────┘                  └──────────────┬──────────────┘
       SSE 回传   │                                        │ claim() LMOVE
                  │                                        ▼
        ┌─────────┴─────────┐                  ┌──────────────────────────┐
        │  Instance A        │◄── pub/sub ──────│  Instance B (执行 job)   │
        │  (持有 SSE 订阅)   │   events:<jobId>  │  sweepOnce → claim → run │
        └───────────────────┘                  └──────────────────────────┘
```

- **共享领取（claim 驱动）**：多实例下 `RunQueue` 进入 `shared` 模式，`setInterval` 周期性
  `sweepOnce()` 调用 `backend.claim()` 原子领取任务。谁领到谁执行，天然避免重复执行。
- **事件桥（pub/sub）**：执行实例把每个运行事件 `publishEvent` 到 `runq:events:<jobId>`；
  持有 SSE 订阅的**任意**实例 `subscribeEvents` 后转发给客户端。因此「提交实例 ≠ 执行实例」
  也能实时回传（前提是负载均衡开启 **sticky session**，见 §3）。
- **崩溃恢复**：任务领取时写入 `runq:claimedAt`，超过租约（`QUEUE_LEASE_MS`）未被 ack 的
  任务由 `reclaimStale` 迁回 `pending` 重新领取。

---

## 2. Redis 数据结构（前缀 `runq:`）

| Key | 类型 | 内容 |
|---|---|---|
| `runq:pending` | LIST | 待领取任务 id（FIFO） |
| `runq:processing` | LIST | 已领取、正在执行的任务 id |
| `runq:jobs` | HASH | `id → JobDescriptor(JSON)`，claim/list/ack 的内容源 |
| `runq:claimedAt` | HASH | `id → 领取时刻(ms)`，供 `reclaimStale` 判定租约过期 |
| `runq:events:<jobId>` | pub/sub channel | 运行事件流（SSE 转发） |

领取用 `LMOVE pending processing LEFT RIGHT`（原子迁移，并发安全，FIFO）。

---

## 3. 部署步骤

### 3.1 单实例（默认，无需 Redis）

```bash
# 默认后端 = memory，单进程即可
pnpm --filter @agent-harness/ui run build
node packages/ui/dist/server.js
```
适用：试点、低流量、开发。任务在进程内队列，进程重启会丢失在飞任务（可接受，客户端会重投）。

### 3.2 多实例（启用 Redis）

1. **准备 Redis**（≥ 6.2，支持 `LMOVE`）：自建、云托管或容器均可。建议开启 AOF 持久化。

2. **设置环境变量**（各实例一致）：

   ```bash
   # 方式一：显式指定后端
   RUN_QUEUE_BACKEND=redis
   REDIS_URL=redis://:password@redis-host:6379/0

   # 方式二：仅设 REDIS_URL 也会自动选 redis 后端
   # REDIS_URL=redis://redis-host:6379/0

   # 租约与领取节奏（可选，有默认值）
   QUEUE_LEASE_MS=300000          # 任务租约 5 分钟；超过未 ack 即回收重派
   QUEUE_CLAIM_INTERVAL_MS=3000   # 各实例每 3s 轮询一次 claim

   # 密钥走外部化（见 README「密钥管理」）：平台 env 或 SECRETS_FILE
   UI_AUTH_TOKEN=__from_secrets__
   ```

3. **部署 N 个副本**（≥2 推荐）。每个副本 `node packages/ui/dist/server.js`，
   `RUN_QUEUE_BACKEND=redis` + `REDIS_URL` 一致即自动组成共享队列集群。

4. **负载均衡开启 sticky session**（关键）：
   - 按连接 / `Cookie` / `client_ip` 把同一客户端的「提交」与「SSE 订阅」固定到同一实例，
     避免事件桥跨实例转发延迟与重连抖动。
   - 示例（Nginx）：
     ```nginx
     upstream harns {
       ip_hash;   # 或基于 cookie 的 sticky
       server 10.0.0.1:4173;
       server 10.0.0.2:4173;
     }
     ```
   - Render / K8s Ingress：启用 session affinity（affinity cookie）。
   - 即使 sticky 失效，事件桥也能兜底（仅延迟略增），但**强烈建议开启**以保证 SSE 体验。

### 3.3 ioredis 可选依赖说明

`ioredis` 是 `optionalDependencies`。若部署镜像未包含：
- 设了 `REDIS_URL` 但无 `ioredis` → 自动降级为 **memory 后端**并打印告警
  `[queue-backend] ioredis 不可用，回退 memory 后端:`，**不会崩溃**，但多实例共享失效。
- 多实例务必确保 `ioredis` 已安装（`pnpm install` 会自动带，或镜像内 `npm i ioredis`）。

---

## 4. 验证清单（上线前逐项确认）

| 项 | 方法 | 期望 |
|---|---|---|
| Redis 连通 | 启动日志无 ioredis 降级告警 | 无 `[queue-backend] ioredis 不可用` |
| 共享领取 | 2 实例 + 并发提交 10 任务，查 `LLEN runq:pending` 与 `LLEN runq:processing` | 任务被**不同实例**领取，无重复执行 |
| FIFO | 观测 `runq:pending` 出队顺序 | 先提交的先执行 |
| 事件桥 | 客户端在实例 A 提交、SSE 连实例 B | SSE 仍实时收到执行事件 |
| 崩溃恢复 | 杀掉正在执行任务的实例 | 该任务在 `QUEUE_LEASE_MS` 内被另一实例 reclaim 并重跑 |
| 幂等 claim | 同任务 id 重复提交（测试用） | `jobs` HASH 覆盖，仅一个实例执行 |

快速核查命令：
```bash
redis-cli -u "$REDIS_URL" LLEN runq:pending
redis-cli -u "$REDIS_URL" LLEN runq:processing
redis-cli -u "$REDIS_URL" HLEN runq:jobs
```

---

## 5. 压测方案

> 目标：量化单 vs 多实例吞吐、验证 claim 竞争无惊群、确认故障转移时效。

### 5.1 单实例基线

```bash
# 单实例，memory 后端，记录 TPS 与 p95 延迟
# 用 hey / k6 / 自写脚本并发 POST /api/run（mock LLM 模式，避免外部 LLM 限速）
hey -n 200 -c 20 -m POST -H "Authorization: Bearer $TOK" \
  -d '{"prompt":"ping","mode":"mock"}' http://localhost:4173/api/run
```
产出：单实例最大并发、p95、错误率（作为多实例对照基线）。

### 5.2 多实例水平扩展

1. 起 2 / 3 / 4 个实例（同一 Redis），LB 前置。
2. 同样 `hey` 压测，观察：
   - **吞吐**是否随实例数近似线性提升；
   - `LLEN runq:pending` 是否被各实例平稳消费（无某实例空转、无单实例过载）；
   - 各实例 `sweepOnce` 日志分布是否均匀。
3. 记录不同实例数下的 TPS 与 p95，绘制扩展效率曲线（理想：N 实例 ≈ N×单实例）。

### 5.3 故障注入

- **Kill 执行实例**：在任务运行中 `kill -9` 某实例，观察任务在 `QUEUE_LEASE_MS`（默认 5min）
  内被其余实例 reclaim 并重跑；如需更快恢复可调小 `QUEUE_LEASE_MS`（权衡：过小会误回收慢任务）。
- **Redis 抖动**：短暂 `redis-cli DEBUG SLEEP 1`，确认客户端重试/降级不雪崩（ioredis 自带重连）。
- **网络分区**：分区期间领取失败的任务保留在 `pending`，恢复后自动补领。

### 5.4 降级路径验证

- 设 `REDIS_URL` 但**故意不装 ioredis** → 启动应打印降级告警且服务 200 可用（单实例内存模式）。
- 不传 `REDIS_URL`、不设 `RUN_QUEUE_BACKEND` → 默认 memory，单实例正常。

---

## 6. 监控与告警建议

- **队列深度**：`LLEN runq:pending` 持续上涨 = 消费能力不足 → 扩容实例或调小 `QUEUE_CLAIM_INTERVAL_MS`。
- **在飞任务**：`LLEN runq:processing` 长期不收敛 = 有任务卡死 → 检查租约回收。
- **租约过期率**：`reclaimStale` 回收次数高 = 任务常超 `QUEUE_LEASE_MS` → 调大租约或优化慢任务。
- **SSE 断流**：客户端重连率突增 → 检查 LB sticky 配置与事件桥。
- 指标还可通过 `/api/metrics` 看 token / 成本累计（见 README「可观测性」）。

---

## 7. 回滚

- 多实例 → 单实例：去掉 `RUN_QUEUE_BACKEND`/`REDIS_URL`，副本数缩到 1。
  **注意**：Redis 中残留的 `runq:*` 不影响（新 memory 实例不读 Redis），上线前可
  `redis-cli -u "$REDIS_URL" --scan --pattern 'runq:*' | xargs redis-cli -u "$REDIS_URL" DEL` 清理。
- 代码回滚：多实例功能在 commit `2ee380b`（上下文压缩与 Redis 多实例队列）引入，
  回滚需同时回退 `queue-backend.ts` / `run-queue.ts` / `server.ts` 相关改动。

# 加固批次总账（18 项修复）

> 背景：全项目「健壮 / 稳定 / 安全 / 自愈」四维代码审计（纯源码实证，不参考文档）后，
> 对 12 项 P1 + 6 项结构性问题逐一修复。本文是本轮修复的单一整合页：总账、新增环境变量、
> 探针速查与验证记录，便于部署侧逐项核对。

## 一、修复总账

### 安全（6 项）

| #   | 问题                                                                                   | 修复                                                                                                                                                                                                               | 代码坐标                                  |
| --- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| S1  | **越权（IDOR）**：任意 viewer 可读所有用户的 Agent 产出物、operator 可删他人工件       | `/api/artifacts` 列表/读取/删除按 owner 过滤（admin 豁免），归属不符统一 404 不泄露资源存在性                                                                                                                      | `routes/collab-routes.ts`                 |
| S2  | `clientIp()` 盲信 `X-Forwarded-For` / `cf-connecting-ip`，直连部署下伪造头绕过 IP 限流 | 新增 `trusted-proxy.ts`（零依赖 CIDR 匹配，IPv4 掩码 + IPv6 展开/映射折返）：仅当 TCP 对端落在 `TRUST_PROXY_CIDRS` 内才采信代理头；缺省仅信任回环（compose 缺省含 docker 网段）                                    | `trusted-proxy.ts`（新增）                |
| S3  | 运行时接入 MCP 无校验：可指向内网/元数据端点（SSRF）、stdio 命令任意                   | 三道校验：`serverUrl` DNS 级私网黑名单（复用 core `resolveHostIsPrivate`）+ 仅 http/https + `command` 白名单（`MCP_ALLOWED_COMMANDS`）+ args shell 元字符拒绝；被拒配置不落库；启动期 env 配置不受限（运维可控面） | `mcp-manager.ts`                          |
| S4  | 忘记密码凭证交付链路缺签发事件与前端透传                                               | 签发事件日志 `auth.reset_token_issued`（不含凭证本体，注明查 `password_resets` 表转交）+ 前端透传服务端 `message` 提示；HTTP 回显门禁 `PASSWORD_RESET_INLINE_TOKEN`（默认带外交付）此前已在路由层落地              | `accounts.ts`、`routes/account-routes.ts` |
| S5  | 供应链：Dockerfile 锁文件校验失败静默降级 `--no-frozen-lockfile`；compose 缺容器加固   | 构建期锁文件校验失败显式失败（`STRICT_LOCKFILE=0` 为显式逃生门）；compose 补 `no-new-privileges` + `cap_drop: ALL`（与 k8s securityContext 对齐）                                                                  | `Dockerfile`、`docker-compose.yml`        |
| S6  | `OPEN_API_KEY` 被无条件注入所有插件（密钥面过宽）                                      | 改 `PLUGIN_SHARE_LEGACY_LLM_KEY=on` 显式开关；插件回调本机 API 改注入专属凭证 `ADMIN_API_KEY`（`reminders-trigger` 优先读取）                                                                                      | `plugin-bootstrap.ts`                     |

### 稳定（4 项）

| #   | 问题                                                                              | 修复                                                                                                                                                                                                                | 关键语义 |
| --- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| T1  | 共享（Redis）队列提交落盘失败仅 `console.error`，客户端拿到 jobId 但任务永不执行  | `submit` 异步化；Redis `append` 失败**同步返回 503**（`QueuePersistError`）并回滚资源；单实例（memory/file）模式维持「失败仅影响崩溃重放」语义                                                                      | 503      |
| T2  | `idempotencyKey` 去重仅进程内 Map，多实例重复执行                                 | 两层去重：Redis `SET NX PX` 原子占位（`runq:idem:<key>`，TTL `RUN_QUEUE_IDEM_TTL_MS` 默认 30 分钟，终态主动释放）；重复提交返回 **409**（`QueueDuplicateError`）+ 既有 jobId（事件经 pub/sub 事件桥对任意实例可见） | 409      |
| T3  | 僵尸任务回收仅在实例启动时执行一次，长生命周期集群无人接管 claim/ack 间崩溃的任务 | `reclaimStale(QUEUE_LEASE_MS)` 改为周期执行（默认 60s）                                                                                                                                                             | 周期回收 |
| T4  | 端口占用（EADDRINUSE）静默崩溃；启动迁移失败带旧 schema 接流                      | EADDRINUSE 给出可操作提示（定位命令 + 改 PORT 建议）并 `emitAlert`；`AH_STARTUP_CRITICAL=1` 时迁移失败**阻断启动**                                                                                                  | 启动期   |

### 自愈：探针与告警接线（3 项）

| #   | 问题                                                                                                       | 修复                                                                                                                                                                                                                                                                                                |
| --- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H1  | k8s / Docker / Render 探针全部打在不探测依赖的 `/api/state` 上——Redis 宕机时 readiness 仍 200              | 探针统一切换：readiness → **`/health/ready`**（真实探测 DB `SELECT 1` / Redis PING / 内存水位，未配置的依赖自动跳过）、liveness → **`/health/live`**；Dockerfile HEALTHCHECK、compose healthcheck、render.yaml、k8s Deployment 同步；k8s redis Deployment 补 liveness/readiness（`redis-cli PING`） |
| H2  | prod overlay `alerts.yaml` 引用从未导出的 `llm_call_*` / `harness_job_started_seconds`（两条告警永不触发） | 改用 `harness_*` 组合表达式：`HarnessRunFailureRateHigh`（失败率）/ `HarnessProcessingStuck`（处理滞留）                                                                                                                                                                                            |
| H3  | CI：nightly 回滚演练作业缩进错误导致整个 workflow 无法解析                                                 | `schedule` 触发器移至 workflow 级 `on:`；e2e 作业纳入 `load-test` / `capacity-benchmark`                                                                                                                                                                                                            |

### 健壮（5 项）

| #   | 问题                                                                                                       | 修复                                                                                                                                                                                                                           | 代码坐标                                   |
| --- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| R1  | 数据损坏策略不一致：核心静默当空数据 vs RAG 启动崩溃循环                                                   | 新增 `store-safety.ts`：记忆 / 工作流检查点 / AgentCard 解析失败统一「结构化告警 + 坏文件隔离改名（`.corrupt-<ts>` 保留现场）+ 空状态继续」；RAG 索引损坏收敛为同一策略（rag 为 stdlib-only 包，内联等价实现，不 import core） | `backend/core/src/store-safety.ts`（新增） |
| R2  | RAG 嵌入 `fetch` 无超时，embed-server 挂起时永久占用 ingest worker 池                                      | 两处 `fetch` 加 `AbortSignal.timeout(RAG_EMBED_TIMEOUT_MS)`（默认 60s），超时走既有失败处置（strict 抛错 / 降级）                                                                                                              | `services/rag`                             |
| R3  | memo 插件 `ensureDb()` 失败的 rejected promise 被永久缓存，磁盘满/瞬时故障后插件永久不可用                 | 初始化失败自动重置缓存，下次调用重新建库                                                                                                                                                                                       | `plugins/memo`                             |
| R4  | 前端未捕获异常静默消失                                                                                     | webapp 挂 `window.onerror` / `unhandledrejection` 监听：去重提示 + 最近 20 条挂 `window.__ahClientErrors` 供诊断                                                                                                               | `frontend/webapp`                          |
| R5  | `cleanup-retention` 按龄删除活跃的 `telemetry-metrics.json`（有状态热文件，低频写入时 mtime 停更即被误删） | 清理清单排除该热文件                                                                                                                                                                                                           | `scripts/cleanup-retention.cjs`            |

## 二、新增环境变量

| 变量                            | 作用                                                                                                | 默认                                    |
| ------------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `TRUST_PROXY_CIDRS`             | 可信代理网段（逗号分隔 CIDR）：仅当 TCP 对端落在列表内才采信 `cf-connecting-ip` / `X-Forwarded-For` | 回环（compose 缺省含 docker 网段）      |
| `PASSWORD_RESET_INLINE_TOKEN`   | 忘记密码凭证回显开关：默认**带外交付**；`on` 才在 HTTP 响应回显（仅限本地演示，公网禁止）           | `off`                                   |
| `MCP_ALLOWED_COMMANDS`          | 运行时接入 MCP 的 stdio 命令白名单（basename 匹配）                                                 | `node,npx,uvx,bunx,python,python3,deno` |
| `MCP_ALLOW_PRIVATE_SERVER_URL`  | 放行指向内网/元数据地址的 MCP serverUrl（默认拒绝，防特权 SSRF）                                    | `off`                                   |
| `PLUGIN_SHARE_LEGACY_LLM_KEY`   | 把 `OPEN_API_KEY` 注入插件的显式开关（默认关闭；插件改注入 `ADMIN_API_KEY`）                        | `off`                                   |
| `RUN_QUEUE_RECLAIM_INTERVAL_MS` | 僵尸任务回收周期                                                                                    | `60000`                                 |
| `RUN_QUEUE_IDEM_TTL_MS`         | 跨实例幂等键 TTL（终态主动释放）                                                                    | `1800000`                               |
| `RAG_EMBED_TIMEOUT_MS`          | RAG 嵌入请求超时                                                                                    | `60000`                                 |
| `AH_STARTUP_CRITICAL`           | 设 `1` 时启动迁移失败阻断启动（不再带旧 schema 接流）                                               | 关闭                                    |
| `STRICT_LOCKFILE`               | Docker 构建锁文件校验逃生门（`0` 允许降级，仅限本地试验）                                           | 严格                                    |

## 三、探针速查（部署侧核对用）

| 场景               | liveness                                                             | readiness       |
| ------------------ | -------------------------------------------------------------------- | --------------- |
| Kubernetes         | `/health/live`                                                       | `/health/ready` |
| Docker HEALTHCHECK | `/health/ready`（单进程镜像，二者合一）                              | —               |
| Render             | `healthCheckPath: /health/ready`                                     | —               |
| 兼容保留           | `/api/state`、`/api/v1/state` 均开放但不探测任何依赖，不建议再作探针 | 同左            |

## 四、验证记录

- `pnpm -r build` 全绿；run-queue-backpressure / queue-backend / byok-isolation 19 用例 +
  core agents/workflow/memory 50 用例全绿（`submit` 异步化后相关测试已 `await` 适配）。
- 冒烟：`/health/ready`、`/health/live` 均 200；忘记密码三态验证全过（默认仅 message 无 token、
  演示开关回显 token、签发日志落盘）。
- 一致性：全仓 grep 确认部署文档无残留「探针=/api/state」过时表述、告警幽灵指标仅存于
  `alerts.yaml` 历史注记、插件密钥旧描述无残留。

# agent-harness 项目全面健康度评审（2026-10-09）

> 范围：功能能力 / 运行稳定性 / 性能与可靠性 / 代码质量。所有关键结论均经源码核实，附文件与行号证据。  
> 方法：4 路并行源码探查（core / server / 前端与移动端 / 插件-服务-测试-部署）+ 高危发现逐条人工复核。

---

## 一、执行摘要

| 维度     | 评级（满分 10）             | 一句话结论                                                          |
| ------ | --------------------- | -------------------------------------------------------------- |
| 功能能力   | **9.0**               | 模块覆盖完整，多智能体基座 13 个子系统均有真实实现，无 stub/TODO 壳                      |
| 运行稳定性  | **单实例 8.5 / 多实例 6.5** | 单实例防御性编程到位；**多实例 Redis 模式存在已核实的重复执行与超卖竞态**                     |
| 性能与可靠性 | 7.5                   | 并发控制、内存有界化、看门狗齐备；瓶颈集中在 IM 旁路无并发上限与长任务租约                        |
| 代码质量   | 8.5                   | 架构分层纪律严格（core 零业务耦合）、零 TODO / 零 ts-ignore；前端 chat.ts 超大单体缺直接测试 |

**总体判断**：项目已达生产可用水准（192 个测试文件、四作业 CI、夜间回滚演练、监控告警栈齐全）。**若仅单实例部署，无阻塞性问题**；主要风险集中在「多实例 Redis 共享队列的分布式正确性」与少数安全边界，建议按下节优先级处置。

---

## 二、项目规模基线（实测）

| 包                             | 规模                                                   | 测试                                     |
| ----------------------------- | ---------------------------------------------------- | -------------------------------------- |
| backend/core（框架）              | 112 个 .ts，25,458 行                                   | test/ 95 个 .cjs 契约测试                   |
| access/server（接入层）            | 93 个 .ts，27,418 行（server.ts 2,359 行 + routes/ 18 模块） | test/ 49 个 .cjs                        |
| frontend/webapp（Lit SPA）      | 125 个 .ts，48,383 行（chat.ts 5,820 行）                  | 25 个 .test.ts（vitest）                  |
| frontend/cli                  | 535 行                                                | **0**                                  |
| mobile（Capacitor 壳）           | 约 879 行（7 个插件控制器）                                    | **0**                                  |
| services/rag                  | 20 个 .ts，3,706 行                                     | 10 个 .cjs                              |
| plugins ×3 + medical-ad-guard | 医美插件 16+ 张表 / 9 测试；memo / 客服较小                       | 客服仅 2 个                                |
| **全仓库合计**                     | —                                                    | **192 个测试文件**（166 cjs + 25 ts + 1 mjs） |



---

## 三、功能能力评估

### 3.1 各模块实现深度定级

| 模块                                                   | 定级                 | 证据                                                                                                    |
| ---------------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------- |
| Agent 主循环（harness.ts 1,224 行）                        | 生产级                | maxSteps/超时/取消/软截止/溢出自愈/孤儿 tool_call 补齐，见 §四                                                          |
| 工作流 DagEngine（engine.ts 1,524 行）                     | 生产级                | 拓扑分层 + 工作池并发 + fail-fast + 逆序补偿 + 检查点原子 claim                                                         |
| 多智能体基座 13 子系统                                        | 真实实现               | registry 倒排能力索引 O(1) 查询、quota 令牌桶+Redis Lua、sandbox OS 级隔离；**teams（211 行，纯内存）、subagent（仅生命周期簿记）两处偏薄** |
| 运行队列（memory/file/redis 三后端）                          | 生产级（单实例）/ 有缺陷（多实例） | 见 §五 P0-1/P0-2                                                                                        |
| 账户/BYOK/OAuth/IM 桥接                                  | 生产级 + 3 个已核实缺陷     | 见 §五 P0-3/P1-1/P1-2                                                                                   |
| memo / medical-aesthetics-lead / medical-ad-guard 插件 | 生产级                | ensureDb 自愈、参数化 IN 防注入、越权双条件收口、22 处建表 + A/B 实验 + 合规硬拦截                                                |
| customer-service 插件                                  | 中等可用               | 结构完整但仅 2 个测试、`getDb()` 缺 rejected-promise 自愈（memo 的 P1 修复范式未回移）                                       |
| RAG 服务                                               | 生产架构 / 演示默认值       | 默认 HashEmbedding（自认无语义泛化）+ JSON 存储；接远程 embedding + qdrant 才是生产路径；嵌入超时 60s / 毒化防护 / 损坏索引隔离均已落地         |
| webapp 前端                                            | 生产级（有单体债）          | 双层 SSE 重连（jobId+seq 游标续传）、全局错误兜底、25 个测试覆盖抽离模块                                                         |
| CLI / mobile                                         | 功能完整但零测试           | CLI 535 行覆盖 11 类命令；mobile 为真实薄桥（biometric AES-GCM 落 Preferences，注释诚实承认 root 下不设防）                     |

### 3.2 功能覆盖结论

- README 宣称的能力（多智能体基座、计划模式、文件交付闭环、IM 桥接、RBAC+审批、评估配方、多后端 DB、监控栈）**均能在代码中找到对应真实实现**，与「文档即事实」的口径一致。
- 已知边界已在文档诚实声明：MCP 动态添加不持久化、FileWorkflowStore 仅进程内互斥、`requireCompletion` 默认关闭等。
- 覆盖空白：多租户运营面（开通/配额/账单）与正式合规模块（SOC2/GDPR 数据主权分区）未落地（文档已声明属 SaaS 化范畴）。

---

## 四、运行稳定性评估

### 4.1 做得好的部分（核实确认）

1. **逐点防逃逸的异步错误防线**：LLM 竞速落选挂 `void llmCall.catch(() => {})` 防 unhandledRejection crash（harness.ts:584-587）；工具 rejection 转已决值（tool-executor.ts:75-77）；引擎侧在途 promise 兜底（engine.ts:1272-1274）。core 全包 217 处 try / 119 处 catch，无「仅 console.log 吞错」的 catch。
2. **进程级兜底**：`crash-guard.ts:31-38` —— uncaughtException 记录 + emitAlert('fatal') + exit(1)；unhandledRejection 仅记录不退出（在线服务不因单点拒绝拖垮）。
3. **数据安全三件套**：tmp+rename 原子写（FileMemoryStore / FileQueueBackend / FileWorkflowStore）、坏文件隔离改名 `.corrupt-<ts>` + 告警 + 空状态继续（store-safety.ts:36-46，接入 memory/agent/workflow 三类存储）、ENOENT 与损坏语义分离。
4. **优雅停机链完整**：abortAll → stop → flushSessions → 5s 宽限 → MCP shutdown → server.close → 3s 强制退出；停机期 /api/run 回 503（graceful-shutdown.ts:55-85）。
5. **健康探针真实探活**：/health/ready 探 DB SELECT 1 / Redis PING / 内存水位（health.ts），liveness/readiness 分离。
6. **可观测性三层**：structLog 统一 JSON 日志（core 出口脱敏）→ logError/emitAlert 计数 + Webhook 告警 → Prometheus/Grafana/Alertmanager 指标栈（11 面板 + 9 条告警规则）。
7. **历史修复文化**：注释中记录了限流内存泄漏、NaN→永久 429、配额不生效、readiness 假 ok 等已修事故，自审痕迹真实。

### 4.2 已核实的稳定性缺陷

见 §五 P0/P1 清单。核心结论：**单实例路径的容错设计自洽；风险集中在共享 Redis 模式的分布式语义**（租约/回收/幂等/会话串行化四个点均只在进程内视角下正确）。

---

## 五、问题清单与改进建议（按优先级）

### P0 —— 高危（多实例部署前必须修复）

**P0-1 · Redis 模式长任务被回收 → 重复执行**

- 证据：`QUEUE_LEASE_MS` 默认 300s（run-queue.ts:431），周期回收每 60s 一次（run-queue.ts:456-470）；但 `PLAN_TASK_TIMEOUT_MS` 默认 600s > 租约，且**无租约续期机制**。`reclaimStale` 判定 `!t || now - t >= leaseMs`（queue-backend.ts:395）——`claimedAt` 缺失时立即回收；`lrem`+`rpush` 两步非原子，与执行实例 `ack()` 存在窗口竞态。注释声称「不会回收在飞任务」与参数组合矛盾。
- 后果：运行超 5 分钟的计划任务在多实例下被另一实例重复领取执行；lrem/rpush 竞态可致任务二次入队。
- 建议：① 执行期间周期性 `HSET claimedAt` 续租（心跳 ≥ 租约 1/3 频率）；② reclaim 改 Lua 脚本原子迁移；③ `claimedAt` 缺失改为「跳过 + 告警」而非立即回收；④ 租约默认值 ≥ 最大任务超时（600s）× 1.5。

**P0-2 · Redis 模式并发超卖竞态**

- 证据：`sweepOnce()` 在 `await claim()` **之前**检查 `this.running >= this.concurrency`（run-queue.ts:481），claim 返回后直接 `running += 1` 不复查；claim 定时器 3s 一次且 submit/finally 也触发 sweep，多个 sweep 在飞时可各领一单。
- 后果：实际并发可短暂超过 `RUN_CONCURRENCY`，叠加上游配额熔断可能放大成本。
- 建议：claim 返回后复查 `running < concurrency`，超限则将任务 `rpush` 回 pending 头部（或本地挂起队列）；或以信号量在 claim 前占位。

**P0-3 · BYOK 校验缓存跨用户串结果**

- 证据：`verifyProviderKey` 缓存键为 `provider:apiKey.slice(0, 8)`（provider-keys.ts:528）——OpenRouter Key 统一以 `sk-or-v1-` 开头，**所有用户共享同一缓存条目**，A 用户的 valid/limit/usage 会返回给 B 用户；且 `verifyCache` Map 只有 TTL 读判、无淘汰，条目永不删除（provider-keys.ts:512-555）。
- 建议：缓存键改用完整 Key 的 SHA-256 摘要；加容量上限 + 惰性淘汰（与 rate-limit.ts 同范式）。

### P1 —— 中危（两周内处置）

| #     | 问题                                                                                             | 证据                                                                   | 建议                                                                  |
| ----- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------- |
| P1-1  | OAuth `state` 即 `code_verifier`，不持久化、不校验会话绑定 → login-CSRF / 账号绑定攻击面                            | oauth.ts:8-9, 171-184                                                | 服务端签发随机 state 短期存储（cookie/内存 TTL 10min），回调强校验                       |
| P1-2  | 旧客户端路径 `modelApiKey` 明文随 JobDescriptor 落盘 Redis/JSONL                                          | queue-backend.ts:29-35、run-queue.ts:322、routes/run-routes.ts:200-218 | 服务端收到明文 Key 立即转加密引用（复用 provider-keys），descriptor 不落明文               |
| P1-3  | IM 桥接后台执行无并发上限，绕过 `RUN_CONCURRENCY`；钉钉验签无时间戳新鲜度校验                                              | im/bridge.ts:165、adapter-dingtalk.ts:79-91                           | IM 执行复用 RunQueue 入队；钉钉验签加 ±5min 时间窗                                 |
| P1-4  | IM 去重兜底键含消息文本 → 用户 5 分钟内发相同文本被误丢                                                               | bridge.ts:152                                                        | 兜底键加入 senderId + 时间戳盐，或无 messageId 时不去重仅告警                          |
| P1-5  | 注册路径邮箱正则双反斜杠错误：`/^[^\\s@]+@.../` 匹配字面 `\`/`s` 而非空白类，含字母 s 的邮箱被误拒                               | accounts.ts:556（同文件 registerUser 的 ：526 是对的）                         | 修正为 `/[^\s@]+@[^\s@]+\.[^\s@]+/`，补一条 OAuth 派生注册测试                   |
| P1-6  | 共享 Redis 模式同会话串行化仅进程内生效（`runningSessions` 是进程内 Set），跨实例可并发写同一记忆                                | run-queue.ts:227, 759-776                                            | 复用 Redis SET NX 会话锁，或文档明示限制 + 前端按 owner 粘性路由                        |
| P1-7  | 看门狗只 abort 信号，底层不响应则 `execute()` 永不 resolve → worker 槽位泄漏（结构性）                                 | run-queue.ts:893-903                                                 | 看门狗超时后对 `execute()` 加第二层 Promise.race 强制结算 + 告警；core 侧已做工具级真实中止，双保险 |
| P1-8  | `LOG_SCRUB_ENABLED` 默认关闭 → 日志脱敏默认不生效；`MAX_SSE_CONNECTIONS` 默认 0 不限                             | server.ts:400-403、run-queue.ts:157-159                               | 生产默认值反转（scrub 默认 on；SSE 上限给非零默认如 500）                               |
| P1-9  | customer-service 插件 `getDb()` 失败后 rejected promise 永久缓存（memo 的自愈范式未回移）                         | plugins/customer-service/src/infra/db.ts:28                          | 回移 memo store.ts:86-94 的重置-重试模式                                     |
| P1-10 | `unhandledRejection` 不退出 + run-queue 10+ 处 `void promise.catch(() => {})` 静默吞错，后台持久化/事件桥故障无告警面 | run-queue.ts 多处                                                      | 静默 catch 至少补 `logError('queue.bg', ...)` 计数，接入 /api/errors          |
| P1-11 | 前端 `AhChat` 单体 5,820 行 / ~45 个 @state，主流程（confirmPlan、事件接线）无直接测试                               | chat.ts:276-649                                                      | 按既有拆分轨迹继续抽离（chat-run-runtime 模式已验证），优先给 confirmPlan 收尾链补集成测试        |
| P1-12 | 窗口级字符串事件总线（10+ 事件名）无编译期检查，曾出过丢内容事故                                                             | chat-run-runtime.ts:394-400 注释                                       | 收敛为带类型的常量枚举 + 单一 dispatch 工具函数                                      |

### P2 —— 低危 / 债务（按迭代节奏消化）

| #     | 问题                                                                                              | 证据                                                         |
| ----- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| P2-1  | harness 溢出/未知工具重试路径耗尽后 `!resp` 被误报为「运行被取消」（语义错误，非崩溃）；护栏输出重试消耗 step 预算且次数硬编码 1                   | harness.ts:638（复核：未知工具扩展 continue 在最后一次尝试时循环耗尽）、:308, :733 |
| P2-2  | workflow `sleepMs` 退避不可中断；resume() 恒真死代码未清                                                      | engine.ts:1358-1360, 995-1029                              |
| P2-3  | teams competitive 模式按「结果长度 × 权重」打分，度量天真；teams 纯内存无持久化                                           | teams/index.ts:166-169                                     |
| P2-4  | File 后端 `ensureLoaded` 先置 loaded 再读文件，首载窗口返回空缓存                                                 | queue-backend.ts:156-159                                   |
| P2-5  | `subscribe()` 在订阅 promise resolve 前调用 unsubscribe → Redis 订阅永久残留                                | run-queue.ts:596-626                                       |
| P2-6  | OAuth `/exchange` 自读 body 无大小上限（其余路由均受 MAX_BODY_BYTES 约束）                                       | oauth.ts:234-247                                           |
| P2-7  | backup-db 为文件级 copy 非 SQLite 在线备份，WAL 模式下有瞬时不一致风险                                               | scripts/backup-db.cjs                                      |
| P2-8  | CI 缺口：frontend/cli 与 mobile 零测试；SBOM 与回滚 verify `continue-on-error` 不阻断；无覆盖率门禁；单一 ci.yml 承载全部职责 | .github/workflows/ci.yml                                   |
| P2-9  | core 被第三方宿主直接嵌入时无进程级安全网（兜底全在 server 层）                                                          | core/src 无 process.on 注册（属分层取舍，建议在 README 声明）              |
| P2-10 | webapp 无 Service Worker，断网仅保偏好不保视图（移动端有 Preferences TTL 缓存兜底）                                   | grep 全 src 零命中                                             |

---

## 六、性能与可靠性评估

**资源与并发（正面）**

- worker 池 + 队列解耦：提交即返回 jobId，`RUN_CONCURRENCY=4`、事件缓冲 500、jobs 表 500 惰性淘汰（只删「已结束且无订阅者」），内存有界。
- workflow 并行波次全局上限 `WF_MAX_CONCURRENCY=16`，工作池保序取任务、fail-fast 不拉新、在途自然收敛后落检查点（engine.ts:1253-1313）。
- 限流三层内存防护（惰性过期 + 60s sweep + 50k 硬淘汰），已修旧版确定性泄漏；`cfgNum` 防 NaN 漂移。
- 定时器普遍 `unref()`，不挂进程退出；per-job 内存监控定时器在 finally/stop 双路径清理。
- token 成本五件套已落地：工具结果截断（16k）+ 滑动窗口（20）+ 压缩摘要 + 重试用量累计 + 可选 prompt cache。

**瓶颈与风险（负面）**

1. **token 结构性成本**：全量历史每步重发的 O(steps²) 根因靠压缩摘要缓解（默认关闭），未开启 `CONTEXT_COMPRESSION` 时长对话成本仍随步数平方增长。
2. **IM 旁路**：绕过队列并发上限（P1-3），洪峰下 LLM 调用数不可控。
3. **RAG 默认路径**：HashEmbedding + JSON 全量加载存储，文档量大时检索延迟与内存线性膨胀；生产必须切 qdrant + 远程嵌入。
4. **多实例 SSE**：依赖 pub/sub 事件桥转发，文档建议 sticky session；`MAX_SSE_CONNECTIONS` 默认不限，慢消费者只受 500 事件缓冲约束，超限即丢事件（客户端有 seq 游标续传兜底，属可接受取舍）。
5. **单机 SQLite 写并发**：同会话已串行化，但跨会话高频写仍受 WAL 单写者限制；多副本场景应切 Turso/MySQL（db-adapter 已支持，配置错误 fail-fast 不静默）。

---

## 七、代码质量评估

**架构（优秀）**

- 四层分界严格：core（框架原语，零业务耦合）→ server（策略/队列/RBAC/审批，全部「接口 + 默认实现 + 组合工厂」）→ plugins（业务语义 100% 隔离）→ webapp（纯消费 /api/v1）。
- 可插拔点一致且真实：Authorizer/ApprovalPolicy/Evaluator/RetentionPolicy/QueueBackend/MemoryStore/ArtifactStore/EnvPlatform 均可只改一个工厂替换。
- server.ts 2,359 行仍偏大，但已拆 routes/ 18 模块 + deps 注入组合根，趋势正确。

**类型与规范（优秀）**

- core：`as any` 6 处（全部带 eslint-disable 豁免注释）、`@ts-ignore` 0、TODO/FIXME 0。
- server：`as any` 10 处、ts-ignore 0；147 处 `catch {` 绝大多数带降级语义注释。
- webapp：`as any` 6 处、ts-ignore 2 处（均为 vite define 声明）。
- lint：no-explicit-any 棘轮（`.eslint-any-baseline.json` 锁存量禁增量），gitleaks + Syft SBOM 入 CI。

**依赖（健康）**

- core 运行时依赖仅 3 个（MCP SDK/mysql2/pg），其余 8 个可选依赖全部有安全降级路径（try/catch require → 可操作错误或 no-op，k8s/libsql 为 fail-loud 有意不静默）。
- pnpm 11 minimumReleaseAge + allowBuilds 显式放行 + `pnpm audit --audit-level=high` 门禁；无 overrides 冲突信号，锁文件 218KB 正常规模。

**债务集中点**

1. chat.ts 单体（P1-11/P1-12）——有明确拆分轨迹但本体无测试网。
2. 测试分布不均：客服插件 2 个 vs 医美插件 9 个；CLI/mobile 零测试。
3. server.ts 内「已修复历史事故」类长注释多，建议沉淀为 docs 回归清单而非散落注释。

---

## 八、结论

1. **功能完整度**：宣称能力与实现一一对应，13 个基座子系统无壳模块；空白仅在对外 SaaS 化运营面（已声明）。
2. **稳定性**：单实例部署可放心使用；**多实例 Redis 模式必须先修 P0-1/P0-2**（重复执行与超卖），并注意租约 < 计划任务超时的参数矛盾。
3. **性能**：默认配置适合中小团队；长对话开启 `CONTEXT_COMPRESSION`、生产 RAG 切 qdrant、IM 走队列是三个最大杠杆。
4. **代码质量**：纪律性在全仓库范围少见（零 TODO / 零 ts-ignore / 棘轮机制 / 修复史注释），主要债务集中在前端单体与测试分布不均。


5. **建议动作顺序**：P0-1~P0-3（多实例正确性 + 缓存串号）→ P1-1/P1-2/P1-5（安全与注册 bug）→ P1-8/P1-10（可观测默认值）→ P1-11（前端测试网）→ P2 按迭代消化。

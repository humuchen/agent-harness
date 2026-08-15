# agent-harness 架构能力评估报告

> 评估对象：`@agent-harness/core` + `@agent-harness/server`（截至 2026-08-15 代码快照）
> 评估维度：沙箱机制 / 进程隔离 / 自验证 / 自修复 / 插件化扩展
> 结论口径：**已具备**（能力完整、默认生效）/ **部分具备**（有核心实现但有边界或缺口）/ **缺失**（无对应实现）

---

## 一、总体能力矩阵

| # | 能力 | 现状 | 一句话结论 | 关键组件 |
|---|------|------|-----------|---------|
| 1 | 沙箱机制 | **部分具备** | 有「逻辑沙箱」（命令白名单＋目录作用域＋人工确认＋注入/密钥扫描），但**非 OS 级硬隔离**，命令仍以 Node 进程同等权限运行 | `builtins/shell.ts`、`guardrails.ts`、`builtins/filesystem.ts`、web_fetch |
| 2 | 进程隔离 | **部分具备** | 单进程内的并发/超时/队列/会话串行化/资源封顶已就位，但**任务间无 OS 级进程隔离**，共享同一 V8 堆，无 cgroup/CPU/内存限额 | `run-queue.ts`、`queue-backend.ts`、`harness.ts`、`runner.ts` |
| 3 | 自验证 | **部分具备** | 有可插拔评估器 + 运行配方还原 + 三类能力自验证 + 单测，但**均为运维手动触发**，且校验的是「过程质量信号」而非「任务结果正确性」 | `verification.ts`、`eval.ts`、`harness.ts`(requireCompletion)、`core/test` |
| 4 | 自修复 | **部分具备** | LLM 故障转移、MCP 自动重连/健康探测、上下文压缩兜底、队列崩溃重放**较强**；缺口在**整轮重试/副作用回滚/编排自修复** | `llm/failover.ts`、`integrations/mcp/placeholder.ts`、`memory.ts`、`queue-backend.ts` |
| 5 | 插件化扩展 | **已具备** | 以 ToolRegistry 为核心、MCP 为运行时动态插件、Skills 为组合包，业务层全面「接口＋默认实现＋工厂」，扩展面完整 | `tools.ts`、`integrations/mcp/*`、`skills/index.ts`、`eval.ts`、`approval.ts`、`env-platform.ts` |

---

## 二、逐项评估

### 1. 沙箱机制（Sandbox Mechanism）

**现状：部分具备。**

#### 已具备的「逻辑沙箱」边界
- **命令白名单（allowlist）**：`builtins/shell.ts` 的 `registerShell` 只允许 `allowedCommands` 中声明的基础命令通过，`base = command.split(sep).pop()` 取 basename 比对，空名单 = 什么也不执行（安全默认）。
- **目录作用域（jail）**：`resolveScope(root, cwdRel)` 拒绝绝对路径并校验 `relative(root, abs)` 不以前缀 `..` 开头，cwd 被锁死在 `root`（默认 `process.cwd()`，可配 `SHELL_ROOT`/`HARNESS_FS_ROOT`）。
- **Shell 元字符拦截**：`SHELL_OPERATOR_RE` 默认拒绝 `| & ; < > $ ( ) \` ! * ? { } [ ] " '` 及换行，杜绝命令注入式拼接（`allowShellOperators` 可显式放开）。
- **人工确认闸门（HITL）**：`requireConfirmation` + `confirm` 策略（`auto`/`deny`/`interactive`/自定义回调）。Web 端经 `server/src/shell-approval.ts` 的 `POST /api/shell/approve` 审批网关，超时未批准即拒绝（安全默认）。
- **内容级护栏**：`guardrails.ts` 在 input/output/tool-args 三处做归一化提示词注入检测、密钥扫描、输出侧 PII 脱敏（`redactOutput` 在 `harness.run` 末尾对所有返回内容打码）。
- **文件系统沙箱**：`builtin__fs_*` 限定在 `HARNESS_FS_ROOT` 内。
- **超时**：单条命令 `timeoutMs`（默认 10s），`spawn(..., { windowsHide: true })`。

#### 安全策略边界与缺口
- **软隔离，非硬隔离**：以上闸门都在「同一 Node 进程、同一 OS 用户、同一权限集合」内生效。被白名单放行的命令（如 `node`、`python3`）通过 `child_process.spawn` 运行，**继承宿主全部权限**（可读写沙箱外的文件、可发起任意网络、可消耗全部 CPU/内存）。没有容器、gVisor、seccomp、user-namespace、cgroups 等 OS 级隔离。
- **无网络出口管控**：`builtin__web_fetch` 无域名白名单；MCP stdio 子进程可任意联网。
- **无资源配额**：仅 `timeoutMs` 限时间，无 CPU/内存上限；`spawn` 子进程 OOM 会影响整个宿主进程。
- **默认关闭**：`SHELL_ENABLED !== 'true'` 时 `builtin__shell_exec` 根本不注册 —— 是 opt-in 的危险能力，符合「一切降级可用」约定，但也意味着默认运行态下「代码执行隔离环境」实际上不存在。

> 结论：代码/任务执行**有清晰的逻辑边界与多层闸门**，但本质是应用层的「受控执行」而非系统层的「沙箱」。若要承载不可信代码，必须外挂容器/VM（见第五节建议）。

---

### 2. 进程隔离（Process Isolation）

**现状：部分具备。**

#### 已具备的「进程内」隔离与资源管控
- **并发上限（worker 池）**：`RunQueue` 以 `RUN_CONCURRENCY`（默认 4）限制同时执行的 job 数，超出的排队（`pump()` 在 worker 空闲时续跑）。避免无限制扇出打满 LLM/MCP/内存。
- **看门狗 + 信号**：每个 job 自带 `AbortController` + `JOB_TIMEOUT_MS`（默认 300s）看门狗；`harness.run` 用 `AbortController` 组合 `timeoutMs`/`signal`，并用 `Promise.race` 打断永不 settle 的 LLM 调用。保证任务不会永久占坑。
- **会话串行化**：`runningSessions` 集合确保同一 `sessionKey` 的并发 job 错开执行，避免并发写记忆后端互相覆盖。
- **有界资源**：`RUN_QUEUE_BUFFER`(500) 事件环形缓冲、`RUN_JOBS_MAX`(500) 惰性 LRU 淘汰、`SESSION_MEMORY_MAX`(256) 会话记忆 LRU、`tokenBudget`/`costBudget`/`MAX_STEPS` 单轮熔断。
- **崩溃可重放**：`queue-backend.ts` 提供 memory/file/redis 三种后端；file 启动重放未开始任务、redis 用 `reclaimStale(leaseMs)` 回收崩溃实例占住的任务。
- **MCP 子进程隔离**：stdio 型 MCP server 以独立 OS 子进程运行（有真实进程边界），远端 SSE/StreamableHTTP 运行在外部。

#### 隔离粒度缺口
- **任务间无 OS 级进程隔离**：所有 job 跑在**同一个 Node 进程、同一 V8 堆**中（即便 redis 后端也只是把队列共享出去，执行仍在本实例进程内）。一个 job 的内存泄漏/未捕获异常/无限循环若绕过看门狗，会影响同进程其他 job 与 UI。
- **无 per-job 资源限额**：CPU、RSS 内存、文件描述符、event-loop 占用均无 cgroup/worker_thread 隔离。
- **跨副本记忆共享弱**：如 `MEMORY_BACKEND=file` 挂 RWX 共享卷才可多副本共享记忆；sqlite 在网络 FS 上文件锁不可靠（项目记忆已注明勿用）。即「水平扩展 ≠ 隔离增强」。
- **无命名空间/能力裁剪**：worker 与核心服务同权限。

> 结论：**隔离粒度是「进程内并发任务」层级，而非「独立进程/容器」层级**。在单实例内做到了较完善的资源封顶与串行化，但缺乏真正 fault-domain 隔离。

---

### 3. 自验证机制（Self-Verification）

**现状：部分具备。**

#### 已具备的验证能力
- **能力自验证（operator-triggered）**：`verification.ts` 的 `runVerification` 经 `/api/verify` 流式输出三类检查：① Agent 闭环（LLM↔工具↔记忆，含 mock 闭环跑通）② Harness 状态轮询（终态映射）③ MCP 接入（进程内起真实 MCP Server→list→注册→调用）。每一步 `verify:check` 带 `ok/msg`，UI 可点亮 ✅/❌。
- **运行质量评估（pluggable）**：`eval.ts` 提供 `Evaluator` 接口 + `RuleBasedEvaluator`（可解释、零依赖）：校验「护栏未拦截 / 预算未超限 / 有最终回答 / 调用了工具 / 有步骤」，硬性失败直接判不通过；`createEvaluator()` 工厂可替换为 LLM-as-judge。`runRecordFromEvents(jobId, events)` 从 harness 事件流**无损还原**运行配方快照（RunRecord）。
- **配方版本化（Recipe）**：`RecipeStore` 接口 + `Volatile`/`File` 实现，把一次 RunRecord 存为命名版本便于回归比对。
- **完成自检（inline）**：`harness.run` 的 `requireCompletion`（env `AGENT_COMPLETION_CHECK`）在模型以空响应收尾时注入提示继续循环，避免「空响应即结束」提前中断。
- **测试套件**：`packages/core/test/*.test.cjs`（34 用例，零依赖）、`packages/server/test/*.test.cjs`（eval/retention 等）。

#### 覆盖边界与缺口
- **触发条件 = 手动**：`/api/verify`、`/api/eval`、CLI `verify`/`eval` 全部由运维/用户显式触发；**运行管线内没有自动验证闸门**——一次 run 不会因为「评估不通过」而自动重试或告警（评估是旁路只读，不改主循环）。
- **校验对象 = 过程质量信号，非任务正确性**：`RuleBasedEvaluator` 只判断「有没有护栏拦截、有没有超预算、有没有工具调用、有没有答案」，并不验证「答案对不对 / 任务是否真正完成」。它衡量的是**流程健康度**，不是**结果正确性**。
- **无断言式验证**：没有「对最终产出运行一组断言/测试/预期 diff」的机制（如 SWE-bench 式 PASS_TO_PASS）。
- **无持续/回归验证**：配方版本化数据结构在，但没有自动「新配方 vs 基线配方」回归比对的执行链路。

> 结论：验证设施**完整且可插拔**，但定位于「运维体检 + 质量评分」，而非「运行期自动校验门禁」。要变成 self-verifying，需要把 `Evaluator` 接入 run 收尾的 gate，并引入基于断言的结果正确性验证。

---

### 4. 自修复机制（Self-Healing）

**现状：部分具备（分层较强，编排层有缺口）。**

#### 已具备的自修复（较强）
- **LLM 故障转移（熔断）**：`llm/failover.ts` 的 `createFailoverLLM` 实现 circuit-breaker：primary（OpenRouter）连续失败达阈值即打开电路，转 secondary（OpenAI）；cooldown 后 half-open 探活，恢复即闭合。对 harness 主循环**完全透明**。由 `LLM_FAILOVER`/`LLM_FAILOVER_THRESHOLD`/`LLM_FAILOVER_COOLDOWN_MS` 控制。
- **MCP 连接自愈**：`integrations/mcp/placeholder.ts`：
  - `makeResilientExecutor`——工具调用失败先**懒重连一次并重试**，使远端重启/抖动对运行透明；
  - `performReconnect`——指数退避（封顶 16×，最多 `MCP_RECONNECT_MAX=5` 次）后台自动重连，重建 client、重注册工具；
  - `startProbe`——周期 `HEALTH_INTERVAL_MS` 健康探测（ping/listTools），超时即判失活并触发重连；
  - `reclaimStale`——Redis 后端回收崩溃实例占住的任务。
- **上下文溢出自愈**：`memory.ts` 滑动窗口溢出时调用 `MemorySummarizer` 压缩为 system 摘要（启发式零额外调用 / LLM 摘要两种）；LLM 摘要器**失败时回退保留上一轮摘要**，绝不中断主运行。
- **崩溃恢复**：队列 file/redis 后端重启重放 pending job；redis 多实例租约回收。
- **工具错误回灌**：`harness.run` 把工具异常作为 tool message 回传给模型，触发模型**自我修正**（"tool error: …" 作为上下文）。
- **优雅停机**：`RunQueue.abortAll` 取消排队任务、中止在飞任务；`disconnectAllMcp` 在 SIGINT/SIGTERM 清理 MCP 连接。

#### 自修复缺口
- **无整轮重试（whole-run retry）**：单次 run 失败（非 LLM/MCP 瞬时故障）后不会自动重投；客户端需自行重投。
- **无副作用回滚（transactional safety）**：`create_ephemeral_environment` 等具副作用工具成功后若后续步骤失败，**不会自动 `destroy_environment`**。当前仅由系统提示词「劝导」模型去销毁，无强制清理/补偿事务。
- **无编排层自修复**：AgentHarness 主循环逻辑本身若进入异常分支，只能返回 `[error] …`，没有对自身控制流的重置/降级（依赖外部看门狗超时）。
- **无 checkpoint/续跑**：一次长任务中断后不能从中间步骤恢复，只能整体重来。

> 结论：**传输/连接/上下文/崩溃层的自愈相当成熟**，是本项目最扎实的能力之一；短板在「业务副作用的补偿回滚」与「整轮/步骤级重试」。

---

### 5. 插件化扩展能力（Plugin Extensibility）

**现状：已具备（扩展面完整、模式统一）。**

#### 已具备的扩展机制
- **工具注册表（核心插件原语）**：`tools.ts` 的 `ToolRegistry.register/unregister/mergeFrom` 是所有能力的统一载体。任何函数包成 `(name, desc, params, fn, source)` 即成为可被护栏/记忆/追踪/编排自动覆盖的工具。**MCP 工具自动以 `<server>__<tool>` 前缀注册进同一注册表**，主循环零改动。
- **MCP 运行时动态插件（最强动态性）**：`integrations/mcp/placeholder.ts` 支持远程（SSE / StreamableHTTP，含 headers/transportType）与本地 stdio 两种形态，通过 `MCP_SERVERS` 环境变量或 UI `addServer` **运行时接入**，无需改代码、无需重启即可扩展工具集；多 server、自动重连、健康探测一并支持。这是真正的「动态加载 + 编排」。
- **技能编排层（组合包）**：`skills/index.ts` 的 `SkillRegistry` 把「工具 + 执行指引 + 触发词」打包为可一键激活的复合能力，`builtin__use_skill` 元工具在运行时取回工作流；技能目录与触发预激活注入系统提示词。护栏/记忆/追踪对其自动覆盖。
- **护栏可插拔**：`registerInputRule` / `registerInjectionScorer`（可接语义分类模型）/ `registerPiiRedactor` / `configureGuardrails`——策略可视化、按租户收紧放松。
- **业务层全面「接口 + 默认实现 + 工厂」**：
  - `eval.ts`：`Evaluator` / `RecipeStore`（Volatile/File，可换 DB）
  - `queue-backend.ts`：`QueueBackend`（Memory/File/Redis，可换 BullMQ）
  - `approval.ts`：`ApprovalPolicy`（内存实现，可换 ITSM/Webhook）
  - `integrations/env-platform.ts`：`EnvPlatform`（harness/local/k8s 后端）
  - `llm/*`：`LLM` 契约 + `createOpenRouterLLM`/`createOpenAILLM`/`createFailoverLLM`，易于加新 provider
- **降级可用**：所有外部依赖（API key、MCP、Redis、sqlite）缺失时静默降级，绝不抛错阻断启动。

#### 扩展缺口
- **Skills/builtins 需代码级变更**：`defaultSkills()` 与 `registerBuiltinTools` 是代码注册，没有「丢一个文件即热加载」的插件清单/清单校验/版本化/依赖机制（MCP 是例外，已是纯配置驱动）。
- **无插件生命周期管理**：没有 enable/disable、版本、依赖解析、沙箱加载（接入的插件与核心同进程同权限，见第一节）。
- **无市场/目录分发**：缺少插件元数据中心与按需安装通道。

> 结论：架构**在「能力封装 + 组合 + 编排 + 加载」四个维度都已具备**，尤其 MCP 提供了运行时动态扩展通道；主要短板是「内置型插件（Skills/builtins）仍需代码改动」与「无插件安全加载/版本编排体系」。

---

## 三、跨维度关键缺口与建议优先级

| 优先级 | 缺口 | 影响维度 | 建议 |
|--------|------|---------|------|
| P0 | 无 OS 级代码执行隔离 | 沙箱 / 进程隔离 | 不可信代码场景外挂容器（gVisor/Kata/容器 per-job）；或在 worker_thread/独立子进程中跑 `shell_exec` 并裁剪 cap |
| P0 | 自验证非自动、非结果级 | 自验证 | 将 `Evaluator` 接入 run 收尾 gate；引入断言式/对账式结果验证（PASS_TO_PASS） |
| P1 | 副作用无补偿回滚 | 自修复 | 为 `env:create` 等注册补偿事务；run 异常时执行 cleanup 清单 |
| P1 | 无整轮/步骤重试 | 自修复 | run 失败依据可重试错误类型自动重投（带退避），checkpoint 续跑 |
| P1 | 任务间非独立进程 | 进程隔离 | 长任务/危险任务 dispatch 到独立 worker 进程或隔离命名空间 |
| P2 | 内置插件需代码改动 | 插件化 | 引入插件清单（manifest）+ 热加载 + 版本/依赖解析 |
| P2 | 网络出口未管控 | 沙箱 | `web_fetch`/MCP 增加域名/出口白名单与 egress 策略 |

---

## 四、证据索引（关键文件）

- 沙箱/执行边界：`packages/core/src/builtins/shell.ts`、`packages/core/src/builtins/filesystem.ts`、`packages/core/src/guardrails.ts`
- 进程/并发/队列：`packages/server/src/run-queue.ts`、`packages/server/src/queue-backend.ts`、`packages/core/src/harness.ts`、`packages/server/src/runner.ts`
- 自验证：`packages/server/src/verification.ts`、`packages/server/src/eval.ts`
- 自修复：`packages/core/src/llm/failover.ts`、`packages/core/src/integrations/mcp/placeholder.ts`、`packages/core/src/memory.ts`
- 插件化：`packages/core/src/tools.ts`、`packages/core/src/integrations/mcp/placeholder.ts`、`packages/core/src/skills/index.ts`、`packages/server/src/approval.ts`、`packages/server/src/eval.ts`、`packages/core/src/integrations/env-platform.ts`

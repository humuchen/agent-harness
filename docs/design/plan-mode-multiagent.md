# Plan 模式多 Agent 化改造方案（A+B：任务隔离 agent + 共享黑板）

> 状态：设计稿（未实施）。目标：把 Plan 模式从「前端串行逐任务派发单 agent」升级为
> 「服务端 DAG 多 agent 并行执行 + 共享黑板传递真实产出」。
> 核心结论：**不新造轮子**——仓库已有 `DagEngine` + `createWorkflowExecutor` 完整实现了
> 本方案要的全部机制，缺口只有一座「桥」：把 `ExecutionPlan` 映射成 `WorkflowDef`，
> 并让 Plan 确认走这条桥，替代前端 `confirmPlan` 的串行循环。

## 1. 目标与非目标

### 目标
- 每个 Plan task = 一个**隔离 agent**（独立 sessionKey、可指定不同 agent/team）→ **真并行**。
- 下游 task 通过**共享黑板**读取上游**真实产出**（非压缩摘要）→ 零 token 膨胀、零有损丢失。
- 按 DAG 波次（wave）并行：无依赖的 task 同层并发，失败仅级联取消下游分支。
- 断点续跑、失败补偿复用既有检查点机制。

### 非目标
- 不改 planner 生成逻辑（`buildPlannerPrompt` / `parsePlanOutput` 产出的 `ExecutionPlan` 契约不变）。
- 不动普通 QA 模式；串行路径保留为回退开关。
- 不引入「任务内再 fan-out 多 agent」的层级递归（`teamRef` 已可承载，但本期默认单 agent/step）。

## 2. 关键事实（已核对的代码锚点）

| 能力 | 现状 | 锚点 |
|---|---|---|
| Plan 生成（一次普通 run 产出 DAG） | `isPlanPropose` 时 `buildPlannerPrompt` 包装 prompt，`run:end` 处 `parsePlanOutput` 解析 | `server.ts:3719-3721`、`4151-4162` |
| Plan task 串行执行 | 前端 `confirmPlan` `for...of + await dispatchPrompt`，同会话同 agent | `chat.ts:3167-3227` |
| Plan 进度镜像 | `run:start` 的 `input` 形状 `【计划任务 <id>】` → `extractPlanTaskId` 写 `currentTaskId` | `server.ts:4271-4273` |
| **DAG 引擎（现成）** | `DagEngine`：拓扑波次 `topoWaves` + `Promise.all` 并发 + `outputs` 黑板 + 失败补偿 + 检查点续跑 | `workflow/engine.ts:222-244`、`263-379`、`RunContext.outputs` |
| **step 执行器（现成）** | `createWorkflowExecutor`：每 step `sessionKey = wf:<wfId>:<stepId>` 隔离记忆，复用 `/api/run` 同一套 `assembleAgent + harness.run`；支持 `teamRef` | `workflow-executor.ts:93`、`45-82` |
| **工作流端点（现成）** | `POST /api/workflows`（创建+运行，SSE 直播 `wf:step:*`）、`GET /api/workflows/:id`（快照）、`POST /api/workflows/:id/resume` | `server.ts:3195-3196`、`4608`、`2185-2252` |
| 黑板语义 | `resolveInput`：`inputMapping` 值 `steps.<id>` → 取上游 `outputs[id]`（真实产出） | `workflow/engine.ts:248-258` |

**结论**：A（隔离 agent）与 B（共享黑板）所需的执行内核、并发调度、隔离记忆、黑板传值、
端点、续跑**全部已存在**。唯一缺口 = `ExecutionPlan → WorkflowDef` 的映射 + Plan 确认链路改走桥。

## 3. 数据流图

```
┌─ 现状（串行，要替换）─────────────────────────────────────────────┐
│ user(plan) → planner run → plan:proposed(ExecutionPlan)          │
│   → 前端 confirmPlan: for task in tasks: await dispatchPrompt(   │
│       "【计划任务 tX】...")  ← 同会话同 agent，串行               │
└───────────────────────────────────────────────────────────────────┘

┌─ 目标（多 agent DAG，新增桥）────────────────────────────────────┐
│ 1. planner run 产 plan:proposed(ExecutionPlan)   （不变）        │
│ 2. 前端确认 → POST /api/workflows {                              │
│      def: planToWorkflowDef(plan, agentId), input: goal }       │
│ 3. handleWorkflow → new DagEngine({store, executor, onEvent})   │
│      → executor = createWorkflowExecutor({onEvent: SSE})        │
│ 4. DagEngine.run:                                               │
│      for wave in topoWaves(def):                                 │
│        Promise.all(wave.map(step =>                              │
│          executor(step, resolveInput(step, goal, outputs), ctx)  │
│            → 隔离 sessionKey 的独立 agent run                    │
│            → outputs[step.id] = result   ← 黑板写真实产出        │
│        ))                                                        │
│ 5. wf:step:* SSE → 前端计划卡片按 stepId 驱动 ⏳/✅/❌           │
│      outputs 供下游 step inputMapping 取用（零摘要、零膨胀）    │
└──────────────────────────────────────────────────────────────────┘
```

## 4. 映射契约：`planToWorkflowDef`

**新增位置**：`backend/core/src/plan.ts`（与 `ExecutionPlan` 同文件，保持纯函数、零依赖、可单测）。

```ts
// 输入
ExecutionPlan { goal, tasks: PlanTask[] }   // task: {id,title,steps[],dependsOn[],expectedOutput}
当前 agent 的 AgentCard（由调用方传入，或按 task 指定）

// 输出
WorkflowDef {
  id: string,               // 建议 `plan:<chatSessionId>:<ts>` 避免并发撞车
  steps: StepDef[],         // 每个 task 一个 StepDef
  tenantId?, traceId?       // 透传
}

// 逐 task 映射
StepDef {
  id:        task.id,
  agentRef:  agentCard,             // 默认全 task 同一 card；预留按 task.id 指定不同 agent
  dependsOn: task.dependsOn,        // 直接透传（DAG 边）
  inputMapping: buildInputMapping(task),  // 关键：把上游真实产出接进来
  // 可选：onRolling / condition 本期不填
}
```

### `buildInputMapping(task)` 的语义（黑板的核心）
- **无 `dependsOn`**：`inputMapping = undefined` → step 输入 = 全局 `goal`（首轮 task 拿用户原始需求）。
- **有 `dependsOn`**：对每个上游 `d` 生成 `{ upstream_${d}: "steps.<d>" }`，
  于是下游 step 的 `input` 变成对象：
  ```json
  { "goal": "<全局 goal>", "upstream_t1": "<t1 真实产出>", "upstream_t2": "<t2 真实产出>" }
  ```
  step 的执行 prompt 由 executor 拼（见 §5 的 prompt 装配约定），模型据此看到上游**真实**产出。
- **同时保留 task 自身信息**：task 的 `title/steps/expectedOutput` 不进 `inputMapping`，
  而是拼进 executor 的 prompt 前缀（§5），与「上游产出对象」一起喂给模型。

> 这样下游拿到的 `upstream_*` 是 `outputs[upstreamId] = result`（`engine.ts:350`）的**原始值**，
> 不经 prompt 压缩 → 直接修掉旧 A 方案的「摘要有损」与「token O(任务数)」两个坑。

## 5. 执行器 prompt 装配约定（`createWorkflowExecutor` 侧）

现状 executor 直接把 `resolveInput` 的 output 当 prompt（`workflow-executor.ts:94-99`）。
Plan 桥下 step input 是 `{goal, upstream_*}` 对象 + task 自身元数据，需在 executor 内统一成 prompt：

```
【计划任务 <task.id>】<task.title>
步骤：
1. <steps[0]>
2. ...
预期产出：<expectedOutput>

目标：<goal>
上游 <t1> 产出：<upstream_t1>
上游 <t2> 产出：<upstream_t2>
```

- 实现方式：executor 从 `input` 对象读取 `goal/upstream_*`，task 元数据（title/steps/expectedOutput）
  在映射时**内联进 StepDef 的某个可序列化字段**（建议 `inputMapping` 里加一个 `taskMeta`
  字面量源，或扩展 StepDef 携带；见 §7 风险 R2 的取舍）。
- 不改变 executor 对 teamRef / tenant 隔离 / compensate 的既有行为。

## 6. 前端改造（`frontend/webapp/src`）

| 文件 | 现状 | 改法 |
|---|---|---|
| `chat.ts:3168 confirmPlan` | `for...of + await dispatchPrompt` 串行 | 改为 `POST /api/workflows` 触发服务端 DAG run；订阅 `wf:step:*` SSE 事件更新卡片 |
| `chat-run-runtime.ts:374 plan:proposed` | 渲染计划卡片（不变） | 保留；卡片「确认执行」按钮改发 workflow 请求而非走 `dispatchPrompt` 循环 |
| 计划卡片状态机 | 前端 `planExec`（`chat-persist.ts:40`） | 由「前端首发权威」迁移为「服务端 `wf:step:*` 权威 + 前端镜像」，`resume` 时经 `GET /api/workflows/:id` 还原 |
| `planExec`/`planStatus` 落盘 | `chat-persist.ts` | 保留作为回退；DAG 路径下改存 `workflowId` 供断线/重启后 `resume` |

**回退开关**：`interactionMode=plan` 且开关关闭时，仍走现有 `confirmPlan` 串行路径，
保证 DAG 桥故障可一键回退到已验证的串行行为。

## 7. 涉及文件清单

### 新增
| 文件 | 内容 |
|---|---|
| `backend/core/src/plan.ts`（追加） | `planToWorkflowDef(plan, agentCard, opts)` + `buildInputMapping(task)` 纯函数 |
| `backend/core/test/plan-to-workflow.test.cjs` | 单测：ExecutionPlan→WorkflowDef 正确性（dependsOn 透传、inputMapping 生成、无 task 时报错）；mock executor 验证波次并行 + 黑板取值 |

### 修改
| 文件 | 改动 |
|---|---|
| `access/server/src/server.ts` | `handleWorkflow` 支持「plan 来源」body（携带 `plan` 或已映射 `def`）；`plan:proposed` 处可选生成 `workflowId`；确认端点接收 chatSessionId 以关联计划卡片 |
| `access/server/src/workflow-executor.ts` | executor prompt 装配：读 `input` 对象的 `goal/upstream_*` + task 元数据；（可选）预留按 task 指定不同 agent |
| `frontend/webapp/src/chat.ts` | `confirmPlan` 改走 `POST /api/workflows` + SSE 订阅；保留串行回退路径（开关门控） |
| `frontend/webapp/src/chat-run-runtime.ts` | 计划卡片确认按钮发 workflow 请求；消费 `wf:step:*` 驱动卡片 |

### 复用（引擎已具备，仅一处校验修正）
`backend/core/src/workflow/engine.ts`、`backend/core/src/workflow/types.ts`、
`access/server/src/plan-store.ts`、既有 `POST/GET /api/workflows` 端点。

> P1 实现中发现并修正一处引擎校验 bug：`DagEngine.validateReferences`
> （`workflow/engine.ts:121`）此前把 `inputMapping` 里**非 `steps.` 前缀的字面量常量**
> 一律拒绝（报「无法解析」），与 `types.ts` 文档及 `resolveInput` 运行时行为
> （else 分支原样注入字面量）矛盾。已修正为：仅 `steps.` 前缀须匹配 `steps.<id>(.output)`
> 且引用已知 step，其余字符串按字面量合法。此修正使 `buildInputMapping` 的 `taskMeta`
> 字面量源（R2 选择方案 a）得以通过校验，非步骤引用的 inputMapping 全量回归 431 项无影响。

## 8. 风险与对策

| # | 风险 | 对策 |
|---|---|---|
| R1 | `POST /api/workflows` 走独立 sessionKey 隔离记忆，与 chat 会话历史割裂，用户看不到「中间过程」在聊天流里 | executor `onEvent` 已透传 `harness` 事件；前端按 `wf:step:*` + `harness` 事件把每 step 产出**回挂**到计划卡片（非普通气泡），避免污染会话历史 |
| R2 | task 元数据（title/steps/expectedOutput）如何进 StepDef 未定 | **已定 (a)**：映射时塞进 `inputMapping` 的 `taskMeta` 字面量源（JSON 字符串），executor 解析后装配 prompt。不动引擎结构，仅依赖 R7 的校验修正 |
| R3 | `DagEngine` 并发 = 波次内全量 `Promise.all`，无并发上限，task 多时打满 LLM 配额 / `RUN_CONCURRENCY` | 波次内加并发上限（如 `RUN_CONCURRENCY`），或限制 planner 单波 task 数（`plan.ts` 提示词已约束 2~6 task，通常够用）；超限走队列排队 |
| R4 | 同 `def.id` 并发运行被 `engine.ts:277` 拒（防检查点覆盖） | plan 的 `def.id` 必须**每次确认唯一**（`genPlanWorkflowId` 已含 `ts+rand`，实测多次调用互不相同） |
| R5 | 黑板 `outputs` 存大对象可能撑爆 store（FileWorkflowStore 单文件） | 上游产出过大时截断 + 提示；或按 `expectedOutput` 约束产出体量；监控 `workflowStore` 体积 |
| R6 | planner 产出的 task 粒度过粗/过细，影响并行度与产出质量 | 本期不改 planner；若需，`buildPlannerPrompt` 增「任务间尽量少依赖、可独立验收」提示（独立迭代，不在本期） |
| R7 | `validateReferences` 拒绝字面量 inputMapping，与 `resolveInput`/`types.ts` 矛盾，`taskMeta` 方案无法过校验 | **已修**（P1）：非 `steps.` 前缀按字面量放行；仅 `steps.` 前缀做引用校验。回归 431 项全绿 |
| R8 | **引擎失败语义是 all-or-nothing**：`Promise.all(wave)` 中任一 step reject，run 进 catch、后续波次不再调度（配合补偿）。与 §9 DoD 第 2 条「失败 task 仅级联取消其下游、独立分支正常跑完」不一致 | P1 测试已钉死现状（all-or-nothing + 补偿）。若产品要求「独立分支继续跑完、仅失败分支下游跳过」，需 P2/P3 改造引擎为 per-branch 级联取消（`Promise.allSettled` + 依赖图按分支剪枝）——**需人工决策是否接受现状或升级** |

## 9. 验收标准（DoD）

1. `planToWorkflowDef` 单测通过：`dependsOn` 完整透传、`inputMapping` 正确生成上游引用、空 tasks 报错。
2. mock executor 端到端：给定 6-task DAG（含 2 层并行 + 1 处依赖失败），验证——
   - 无依赖 task 同波并发；
   - 下游 `input` 里 `upstream_*` = 上游真实 `output`（非摘要）；
   - 失败 task 仅级联取消其下游，独立分支正常跑完；
   - `resume` 从断点续跑不重复已完成 step。
3. 前端：计划卡片「确认执行」触发 `POST /api/workflows`，`wf:step:*` 驱动卡片状态；关闭开关回退串行路径仍可用。
4. `pnpm run test` / `pnpm run lint` / `pnpm run build` 全绿。

## 9.1 P1 落地状态（已实现 + 测试）

| 项 | 状态 | 说明 |
|---|---|---|
| `planToWorkflowDef` + `buildInputMapping`（`plan.ts`） | ✅ 已实现 | 纯函数、零运行时依赖；task→step 映射、dependsOn 透传、agentRef 默认/按 task 覆盖、`genPlanWorkflowId` 唯一 id |
| R7 引擎校验修正（`workflow/engine.ts`） | ✅ 已实现 | 字面量 inputMapping 合法化，对齐 `resolveInput` 运行时 |
| `plan-to-workflow.test.cjs`（9 项） | ✅ 全绿 | 纯映射 5 项 + DagEngine 集成 4 项（成功路径并发、黑板取值、失败 all-or-nothing、resume 复用） |
| DoD 第 2 条「独立分支正常跑完」 | ⚠️ 与现状引擎差异 | 见 R8，all-or-nothing 已用测试钉死；是否升级 per-branch 取消待决策 |

**P1 结论**：映射桥验证通过——`ExecutionPlan` 能正确生成**合法** `WorkflowDef`（含黑板 `upstream_*` 取值 + `taskMeta` 字面量），DagEngine 能端到端执行并保证「下游拿到上游真实产出」。

## 9.2 P2 落地状态（服务端端到端，已实现 + 测试）

| 项 | 状态 | 说明 |
|---|---|---|
| executor prompt 装配 `formatStepInput`（`workflow-executor.ts`） | ✅ 已实现 | 识别 `{goal, taskMeta, upstream_*}` 对象 → 装配设计文档 §5 约定的可读 prompt；`string`/普通对象原行为零回归；`compensate` 前缀保留；`taskMeta` 解析失败不阻断 |
| `handleWorkflow` plan 来源（`server.ts`） | ✅ 已实现 | body 可带 `plan`（+ `agentRef?` / `mode?`），经 `planToWorkflowDef` 生成 def；`mode` 透传 executor（与 `/api/run` 同款白名单，默认 mock）；unknown `agentRef` fail-fast 400（对齐 `server.ts:3729`）；初始输入取 `plan.goal` |
| `workflow-executor-format.test.cjs`（6 项） | ✅ 全绿 | plan 装配 / 上游真实产出注入 / string 透传 / 对象回退 / compensate 前缀 / taskMeta 解析失败 |

**P2 结论**：服务端链路打通——`POST /api/v1/workflows` 携带 `{plan, agentRef, mode}` 即可驱动多 agent DAG 执行 + 共享黑板，SSE 直播 `wf:step:*`。server 全量测试无回归。

## 9.3 P3 落地状态（前端闭环，已实现 + 测试）

| 项 | 状态 | 说明 |
|---|---|---|
| client `streamWorkflowFromPlan`（`backend/client`） | ✅ 已实现 + 18/18 测试 | 同 `streamWorkflow` SSE 范式，POST `{plan, agentRef?, mode?}`；`streamWorkflowResume` 断点续跑 |
| 状态机 `applyPlanWfEvent`（`chat-render-utils.ts`） | ✅ 已实现 + 单测 | wf:step:start/done/failed + wf:done/failed → `PlanExecState` 纯函数叠加；未知 task/无关事件同引用返回（`next !== prev` 判重渲染）；`chat-plan-wf-state.test.ts` 10 项 |
| 特性开关 `isPlanDagEnabled`（localStorage `ah_plan_dag`） | ✅ 已实现 | **默认开**；用户显式置 `ah_plan_dag='0'` 可关（回退串行）；localStorage 不可用安全回落「开」；非浏览器/隐私模式保守回退串行 |
| `confirmPlan` DAG 门控（`chat.ts`） | ✅ 已实现 | 开关开 + 首次确认（pending）走 `confirmPlanViaWorkflow`；传输层失败（unknown agent/5xx/断连/wf:error）整体回退已验证串行路径兜底；failed 态「从失败任务继续」统一走串行 resume |
| `confirmPlanViaWorkflow` + `appendPlanDagSummary`（`chat.ts`） | ✅ 已实现 | SSE 消费 `wf:step:*` 驱动卡片；`wf:done/wf:failed` 回挂执行摘要到线程（R1：卡片级紧凑摘要，不污染会话气泡）；用户停止→cancelled，传输层异常→pending 回退；`saveHistory` 落盘 |
| 停止按钮接入（`chat.ts` 渲染） | ✅ 已实现 | DAG 运行中（`planWfAbort` 非空）优先 `abort()` 中止 DAG 流，否则 `runRt.stop()`（两者互斥） |
| `chat-plan-wf-state.test.ts`（10 项） | ✅ 全绿 | 状态机 6 项 + 特性开关 4 项 |

**P3 结论**：前端闭环——计划卡片「确认执行」可走多 agent DAG（开关门控），`wf:step:*` 实时驱动卡片状态，终态回挂摘要，失败/停止/断连均有明确处置，全程可回退串行。**默认开**（用户可显式 `ah_plan_dag='0'` 关闭），传输层失败自动回退已验证串行路径兜底。

### 9.4 节点级可追踪 / 可记录（已实现）

开启 `ah_plan_dag` 后，每个 DAG 节点的执行信息按三层可追踪 / 可记录：

| 层 | 载体 | 记录内容 | 持久性 |
|---|---|---|---|
| 实时（SSE） | `wf:step:start/done/failed` + 嵌套 harness 事件 | 每节点 stepId / agentId / error 文本，驱动卡片 ⏳/✅/❌ | 会话内 |
| 检查点 | `FileWorkflowStore`（`WORKFLOW_STORE_DIR`，render.yaml 已配 `/app/data/workflows`，挂载持久卷） | 每 workflow 一个 JSON：`StepRun` 的 `input`（解析后实际喂入）/`output`/`error`/`agentId`/`startedAt`/`finishedAt`；支持 `GET /api/workflows/:id` 快照查询与 `POST .../resume` 断点续跑 | **跨重启**（render 持久卷） |
| 审计日志 | `auditWfEvent`（`server.ts`，`stdout` JSON 行） | run 终态 `workflow.done`（ok/failed/cancelled + 每步 status/agentId/durationMs）、`workflow.step.failed`（stepId/agentId/error 截断 500）；resume 路径同样接审计 | render 服务日志，可 `grep` 逐节点回溯 |

**关键事实**：`DagEngine` 在 `engine.ts:336` 落 `StepRun.startedAt`、`engine.ts:352/368` 落 `finishedAt`，故审计 `durationMs` 可靠。检查点在 `FileWorkflowStore` 自动 `mkdirSync(递归)` 建目录，render 初始不存在 `/app/data/workflows` 无碍。run 起点审计（`workflow.run`，`server.ts:4716`）保留，与节点级审计互补。

### 回归验证（P2/P3 落地后）
- webapp `vitest`：294 项全绿（含新增 10 项）；`vite build` 通过；`tsc --noEmit` 9 条 error **全 pre-existing**（stash 基线对比确认，零新增）
- server：全量测试无回归；client 18/18
- 全仓 `pnpm run test`：见执行记录

## 10. 分期落地建议（P1–P3 均已完成）

- **P1（✅ 已完成，commit `14b0457`/`344f0f0`）**：`planToWorkflowDef` + 单测 + R7 引擎校验修正——零运行链路风险的安全基线。
- **P2（✅ 已完成）**：`handleWorkflow` plan 来源 + `formatStepInput` 装配 + `mode` 透传 + agentRef fail-fast——服务端端到端跑通 DAG。
- **P3（✅ 已完成）**：前端 `confirmPlan` DAG 门控 + 状态机 + SSE 卡片 + 回退开关 + 摘要回挂——闭环，默认开，用户可 `ah_plan_dag='0'` 回退串行。

### 9.5 P0–P3 改进项落地状态（校验反思 / 断点续跑 / 轨迹回放 / 节点级人工门）

改进项命名（P0–P3）与本节上半部的「分期落地 P1–P3」是两套编号，勿混淆：上半部 P1–P3 = 多 agent DAG 的分期上线；本节 P0–P3 = 上线后的体验改进。

| 改进项 | 状态 | 说明 |
|---|---|---|
| P0 校验/反思 | ✅ 已实现 | DAG executor 接 `createVerifier` + `AGENT_VERIFY_MAX_RETRIES`（与 `/api/run` 同款优先级 `body.verify > body.autoVerify > AGENT_AUTO_VERIFY`）；`workflow-verify.test.cjs` 3 项实证反思循环 |
| P1 断点续跑 | ✅ 已实现 | 确定性检查点键 `derivePlanWfId`（FNV-1a，结构键不含文案，跨刷新可重算）；server 抽共享 `resolveWorkflowRunOpts`（BYOK+verify+402 收敛，执行/续跑路由共用）；`streamWorkflowResume` 补 BYOK body；failed 卡片「从失败任务继续」优先 DAG 续跑，404/5xx/断连自动回退串行 resume |
| P2 轨迹回放 | ✅ 已实现 | **零引擎改动**——`WorkflowRun` 检查点快照本身即轨迹（每 step 带 agentId/output/error/时间戳）。计划卡片非 pending 态显示「执行详情」→ 侧滑抽屉经 `client.getWorkflow(derivePlanWfId)` 水合快照 → `buildPlanWfReplayRows`（纯函数，可测）渲染步骤时间线（状态/agent/耗时/可折叠产出·错误）；404 无检查点 → 友好提示并指向「断点续跑 / 重新执行」兜底。样式独立追加于 `styles/chat/plan-mode.ts` |
| P3 节点级人工门 | ⬜ 未实施 | 见下方 P4 待办（需动引擎核心循环） |

**回归基线（P0–P2 落地后）**：server 273/0 fail；client 18/18；webapp 316/316（含 derivePlanWfId + 回放纯函数新增 12 项）；三端 build 0；lint 0 error（仅 pre-existing warning）；webapp `tsc --noEmit` 9 条全 pre-existing（与 P1 前基线一致，零新增）。

### P4（后续，未实施）
- **R8 引擎 per-branch 级联取消**：`Promise.all` → `Promise.allSettled` + 依赖图按分支剪枝，使「失败 task 仅取消其下游、独立分支正常跑完」，消除 all-or-nothing。动核心执行循环，需补引擎回归测试。
- ~~DAG 断点续跑入口~~ → **已由 P1 实现**（§9.5）：failed 态经 `resumePlanViaWorkflow` → `streamWorkflowResume(derivePlanWfId)` 从检查点续跑，不可达自动回退串行。
- **P3 节点级人工门**：`StepDef.requireApproval` + `WorkflowRun.approvals` + 引擎在 flagged step 前暂停并 emit `wf:awaiting-approval` + `POST /api/workflows/:id/approve` 放行续跑。**需动引擎核心执行循环**（当前「不改核心循环」约束需明确解除后方可启动，风险最高，排最后）。
- **黑板体积护栏（R5）**：`upstream_*` 大产出截断 + 监控 `workflowStore` 体积。
- **P3 观察反馈收集**：默认开后的线上/自测观察期，若 DAG 路径暴露真实模型环境下的问题（R5 黑板体积、R8 all-or-nothing），经 `ah_plan_dag='0'` 可即时回退串行；稳定后可移除开关。

> 每阶段独立可验收、可回退；P1 完成即证明「ExecutionPlan 能生成合法 WorkflowDef」，P2/P3 分别打通服务端与前端链路，全程不破坏已验证的串行回退路径。

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

### 复用（零改动）
`backend/core/src/workflow/engine.ts`、`backend/core/src/workflow/types.ts`、
`access/server/src/plan-store.ts`、既有 `POST/GET /api/workflows` 端点。

## 8. 风险与对策

| # | 风险 | 对策 |
|---|---|---|
| R1 | `POST /api/workflows` 走独立 sessionKey 隔离记忆，与 chat 会话历史割裂，用户看不到「中间过程」在聊天流里 | executor `onEvent` 已透传 `harness` 事件；前端按 `wf:step:*` + `harness` 事件把每 step 产出**回挂**到计划卡片（非普通气泡），避免污染会话历史 |
| R2 | task 元数据（title/steps/expectedOutput）如何进 StepDef 未定 | 二选一：(a) 映射时塞进 `inputMapping` 的 `taskMeta` 字面量源（需 executor 解析）；(b) 扩展 `StepDef` 加 `taskMeta` 字段（改 `types.ts` + 引擎透传，向后兼容）。**倾向 (a)**：不动引擎，只动映射 + executor |
| R3 | `DagEngine` 并发 = 波次内全量 `Promise.all`，无并发上限，task 多时打满 LLM 配额 / `RUN_CONCURRENCY` | 波次内加并发上限（如 `RUN_CONCURRENCY`），或限制 planner 单波 task 数（`plan.ts` 提示词已约束 2~6 task，通常够用）；超限走队列排队 |
| R4 | 同 `def.id` 并发运行被 `engine.ts:277` 拒（防检查点覆盖） | plan 的 `def.id` 必须**每次确认唯一**（含 `chatSessionId + ts`），不得复用 |
| R5 | 黑板 `outputs` 存大对象可能撑爆 store（FileWorkflowStore 单文件） | 上游产出过大时截断 + 提示；或按 `expectedOutput` 约束产出体量；监控 `workflowStore` 体积 |
| R6 | planner 产出的 task 粒度过粗/过细，影响并行度与产出质量 | 本期不改 planner；若需，`buildPlannerPrompt` 增「任务间尽量少依赖、可独立验收」提示（独立迭代，不在本期） |

## 9. 验收标准（DoD）

1. `planToWorkflowDef` 单测通过：`dependsOn` 完整透传、`inputMapping` 正确生成上游引用、空 tasks 报错。
2. mock executor 端到端：给定 6-task DAG（含 2 层并行 + 1 处依赖失败），验证——
   - 无依赖 task 同波并发；
   - 下游 `input` 里 `upstream_*` = 上游真实 `output`（非摘要）；
   - 失败 task 仅级联取消其下游，独立分支正常跑完；
   - `resume` 从断点续跑不重复已完成 step。
3. 前端：计划卡片「确认执行」触发 `POST /api/workflows`，`wf:step:*` 驱动卡片状态；关闭开关回退串行路径仍可用。
4. `pnpm run test` / `pnpm run lint` / `pnpm run build` 全绿。

## 10. 分期落地建议

- **P1（先做）**：`planToWorkflowDef` + 单测（mock executor 验证映射正确性）——零运行链路风险。
- **P2**：`handleWorkflow` 支持 plan 来源 + executor prompt 装配——服务端可端到端跑通 DAG。
- **P3**：前端 `confirmPlan` 改走 workflow + SSE 卡片 + 回退开关——闭环，回归面最大，最后动。

> 每阶段独立可验收、可回退；P1 完成即证明「ExecutionPlan 能生成合法 WorkflowDef」，是整条链的安全基线。

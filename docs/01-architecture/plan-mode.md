# 计划模式与计划工作流（Plan Mode）

> 状态：**已落地**（多批次迭代：澄清 → propose → DAG 执行 → 交付归档）。
> 设计稿见 [`../design/plan-mode-multiagent.md`](../design/plan-mode-multiagent.md)（计划 → 多 agent 并行执行的设计源）。

## 1. 概述

计划模式把 Chat 从「一问一答」升级为「**规划-执行-交付**」的多步任务形态：用户提出复杂需求后，
模型先产出一棵**可确认、可编辑的计划树**（任务拆解 + 依赖 + 验收点），用户确认后由计划桥映射为
WorkflowDef 交给 DagEngine 多 agent 执行，全程有实时思考面板与断连自愈，最终产出归档为可下载的交付文件。

分层纪律与全仓一致：

- **core**（`backend/core/src/plan.ts` + `plan-propose.ts`）只提供「计划契约 + planner 提示词 +
  容错解析器 + 计划 → 工作流映射」四件纯函数级能力，不感知 UI 与交互语义；
- **server**（`access/server/src/plan-*.ts` + `routes/plan-routes.ts`）只做透传、落盘、事件桥与产物归档；
- **webapp** 承载澄清交互、思考面板、计划树渲染等全部 UI 语义。

## 2. 代码坐标

| 模块                    | 包     | 职责                                                                                                                                                                                              |
| ----------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plan.ts`               | core   | `ExecutionPlan`/`PlanTask` 契约、planner 提示词、`parsePlanOutput` 容错解析、`planToWorkflowDef`/`buildInputMapping`（计划 →WorkflowDef 映射，交 DagEngine 多 agent 并行 + 共享黑板传递真实产出） |
| `plan-propose.ts`       | core   | **两段式规划 propose 管线**：先澄清后成案；planner 输出计划 JSON，服务端在 `run:end` 时解析并补发 `plan:proposed` 事件                                                                            |
| `routes/plan-routes.ts` | server | 计划文档 CRUD + SSE（`GET/POST /api/plans`、`GET /api/plans/:id`、`GET /api/plans/:id/events`）                                                                                                   |
| `plan-store.ts`         | server | Plan 协同存储（P2-3）：`PlanNode`（todo/doing/done/blocked + assignee + dependsOn）持久化为可视化、可多人协同的文档（乐观更新 + 版本号冲突解决）                                                  |
| `plan-bus.ts`           | server | Plan 协同事件总线（P2-3）：复用 chat-bus 双层模式（进程内 fanout + Redis 跨实例桥）                                                                                                               |
| `plan-verify.ts`        | server | P4.5 默认验证门禁纯决策模块：未显式指定 verify 时回落「确定性结果断言」（零 LLM 成本）拦跑题/空/截断/护栏兜底产出                                                                                 |
| `plan-artifacts.ts`     | server | P4.6 计划桥产物归档：plan 来源工作流终态时，把每个 done step 的产出文本归档进 artifact-store（`kind=plan-step-output`、`runId=workflowId`），前端渲染「📎 交付文件」区                            |
| `frontend/webapp`       | webapp | 澄清候选选项点选/逐题作答、propose 实时活动与计时、计划树拓扑渲染、思考面板（钉底滚动/归因/执行详情）、交付文件区                                                                                 |

## 3. 生命周期

```
用户需求
  │
  ├─ ① 澄清（可选分支）：模型提出澄清问题，前端支持候选选项点选与逐题作答
  │
  ├─ ② propose（两段式规划管线）：planner 提示词约束模型输出计划 JSON
  │     实时活动 + 计时展示；run:end 时 parsePlanOutput 解析 → plan:proposed 事件
  │
  ├─ ③ 确认：用户查看/编辑计划树（任务/步骤/依赖/验收点），确认后进入执行
  │     requireApproval 任务的波次前暂停（state → awaiting），人工放行后 resume
  │
  ├─ ④ 执行：planToWorkflowDef 映射为 WorkflowDef → DagEngine
  │     · DAG 形状自动决策串/并行，支持有界并发（计划桥）
  │     · 显式取消 + 断连自愈（断连中止引擎运行并清理思考面板残留）
  │     · 验收词软门禁：未命中触发一次自检重试，仍不通过只告警不阻断
  │     · 失败/中断状态落盘，重开不从 t1 全量重跑
  │
  └─ ⑤ 交付：plan-artifacts 归档各 step 产出 → 「📎 交付文件」区
        计划任务可合并交付文档（长输入放宽）；终止后归档汇总交付报告
```

## 4. 关键机制

- **验收词（P4.5/P4.7）**：每个任务带 2~4 个「产出必须包含」的短词（`pickOutputChecks` 收敛，
  上限 `PLAN_OUTPUT_CHECK_MAX`），同时注入执行 prompt 的「验收要求」并生成 contains 断言——
  保证「模型被告知的词」与「门禁断言的词」严格一致；**软性门禁**（自检重试一次后仅告警不阻断）。
- **并发与取消**：计划桥按 DAG 形状自动决策串/并行（有界并发）；`workflow` 支持显式取消与
  断连自愈，断连时中止引擎运行并清理思考面板残留，避免僵尸 run。
- **状态落盘**：执行失败/中断的状态落盘，会话重开后不从头重跑已完成任务。
- **规划期约束**：规划模式限制步数与工具调用（`e18c136`）；长输入放宽（`17d2b6d`）支持
  大体量需求直接进规划；执行详情截断上限 20 万字（`2c5ada4`）。
- **执行详情可观测**：`jev:call` 旁路事件与 Jev 调用统计接口（见根 README「内置基础工具」）
  覆盖计划执行中的决策调用；思考面板同步归因与执行详情（`1ea277d`）。
- **联调入口**：`scripts/e2e-plan-mock.cjs` / `scripts/plan-e2e.js`（mock 模型端到端）。

## 5. 相关文档

- 设计源：[`../design/plan-mode-multiagent.md`](../design/plan-mode-multiagent.md)
- 执行引擎（DagEngine/补偿/检查点）：[`modules.md`](modules.md) 的 `workflow/` 条目
- 交付文件闭环（`builtin__fs_write` / `builtin__doc_export` / `builtin__deliver_file`）：根
  README「内置基础工具」与 CHANGELOG「文件导出与交付闭环」

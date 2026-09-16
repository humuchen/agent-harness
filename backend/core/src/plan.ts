/**
 * 问答 / 计划模式（P0）—— 计划模式的结构化原语。
 *
 * 职责边界：core 只提供「计划契约 + planner 提示词 + 容错解析器 + 计划→工作流映射」
 * 四件纯函数级能力，不感知 UI、不感知交互模式语义（那属于 webapp）；server 只做透传与落盘。
 * 「计划生成」本身是一次普通 run：planner 提示词约束模型输出计划 JSON，
 * 服务端在 run:end 时用 parsePlanOutput 解析并补发 plan:proposed 事件。
 * 「计划→工作流映射」（planToWorkflowDef / buildInputMapping）把 ExecutionPlan 转成
 * WorkflowDef，供 DagEngine 多 agent 并行执行 + 共享黑板传递真实产出
 * （见 docs/design/plan-mode-multiagent.md）。

 */

import type { StepDef, WorkflowDef } from './workflow/types';
import type { AgentCard } from './agents/types';

/** 单个计划任务：任务拆解的最小单元。 */
export interface PlanTask {
  /** 任务 id（planner 生成，如 t1/t2；前端拓扑排序依据 dependsOn）。 */
  id: string;
  title: string;
  /** 任务内执行步骤（顺序列表）。 */
  steps: string[];
  /** 依赖的前置任务 id（必须引用 tasks 内其它 id，禁止环）。 */
  dependsOn: string[];
  /** 预期产出描述。 */
  expectedOutput: string;
  /**
   * P3 人工审批门：执行该任务前需用户显式批准（默认 false，零回归面）。
   * 映射为 StepDef.requireApproval 后，引擎在该任务所在波次前暂停 run（state → awaiting），
   * 用户经 approve 接口放行后 resume 才继续执行。
   */
  requireApproval?: boolean;
}

/** 结构化执行计划（plan:proposed 事件的 payload 契约）。 */
export interface ExecutionPlan {
  goal: string;
  tasks: PlanTask[];
}

/** planner 系统提示词：约束模型输出可解析的计划 JSON（不夹带 markdown 围栏/解释文字）。 */
export function buildPlannerPrompt(userInput: string): string {
  return [
    '你是资深任务规划师。请根据用户需求产出一份结构化执行计划。',
    '',
    '硬性要求：',
    '1. 只输出一个 JSON 对象，不要输出任何解释文字、markdown 围栏或多余内容。',
    '2. JSON 形如 {"goal": string, "tasks": [{"id": string, "title": string, "steps": string[], "dependsOn": string[], "expectedOutput": string, "requireApproval"?: boolean}]}',
    '3. task.id 用 t1/t2/… 命名；dependsOn 只能引用已定义的任务 id，且不得形成循环依赖。',
    '4. 每个任务的 steps 是该任务内的有序执行步骤；expectedOutput 描述该任务完成后的可验证产出。',
    '5. 任务粒度以「一次对话可独立完成」为准，通常 2~6 个任务。',
    '6. 仅当某任务涉及不可逆或高风险操作（删除数据、发布、金钱相关等）时，才为该任务设置 "requireApproval": true（执行前需用户人工批准）；其余任务一律省略该字段（缺省 = 无需批准）。',
    '',
    `用户需求：${userInput}`,
  ].join('\n');
}

/**
 * 从模型输出中容错提取计划 JSON。
 * - 直接 parse；
 * - 失败则剥离 ```json 围栏后再试；
 * - 再失败则截取首个 `{` 到最后一个 `}` 的片段重试；
 * - 结构校验：goal 为字符串、tasks 为非空数组、id 唯一、dependsOn 引用存在且无环。
 * 任一步不可恢复即返回 null（调用方回退为普通问答并 emit warn）。
 */
export function parsePlanOutput(text: string): ExecutionPlan | null {
  if (!text || !text.trim()) return null;
  const candidates: string[] = [text];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1] ?? '');
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));

  for (const raw of candidates) {
    let data: unknown;
    try {
      data = JSON.parse(raw.trim());
    } catch {
      continue;
    }
    const plan = normalizePlan(data);
    if (plan) return plan;
  }
  return null;
}

/** 结构校验 + 字段收敛；不合法返回 null。 */
function normalizePlan(data: unknown): ExecutionPlan | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  const goal = typeof d.goal === 'string' ? d.goal.trim() : '';
  if (!goal) return null;
  if (!Array.isArray(d.tasks) || d.tasks.length === 0) return null;

  const tasks: PlanTask[] = [];
  const ids = new Set<string>();
  for (const raw of d.tasks) {
    if (!raw || typeof raw !== 'object') return null;
    const t = raw as Record<string, unknown>;
    const id = typeof t.id === 'string' && t.id.trim() ? t.id.trim() : '';
    const title = typeof t.title === 'string' ? t.title.trim() : '';
    if (!id || ids.has(id) || !title) return null;
    ids.add(id);
    const steps = Array.isArray(t.steps)
      ? t.steps.map((s) => String(s)).filter((s) => s.trim())
      : [];
    const dependsOn = Array.isArray(t.dependsOn)
      ? t.dependsOn.map((s) => String(s).trim()).filter(Boolean)
      : [];
    const expectedOutput =
      typeof t.expectedOutput === 'string' ? t.expectedOutput.trim() : '';
    // P3：仅当模型显式给出布尔 true 时保留审批门（缺省/非法值一律视为无需批准，零回归面）。
    const requireApproval = t.requireApproval === true;
    tasks.push({
      id,
      title,
      steps,
      dependsOn,
      expectedOutput,
      ...(requireApproval ? { requireApproval: true } : {})
    });
  }

  // dependsOn 引用必须存在；用 Kahn 拓扑排序检测环。
  for (const t of tasks) {
    for (const dep of t.dependsOn) {
      if (!ids.has(dep)) return null;
    }
  }
  const indeg = new Map<string, number>(tasks.map((t) => [t.id, t.dependsOn.length]));
  const dependents = new Map<string, string[]>();
  for (const t of tasks) {
    for (const dep of t.dependsOn) {
      dependents.set(dep, [...(dependents.get(dep) ?? []), t.id]);
    }
  }
  let queue = tasks.filter((t) => (indeg.get(t.id) ?? 0) === 0).map((t) => t.id);
  let visited = 0;
  while (queue.length) {
    const next: string[] = [];
    for (const id of queue) {
      visited += 1;
      for (const nxt of dependents.get(id) ?? []) {
        const v = (indeg.get(nxt) ?? 0) - 1;
        indeg.set(nxt, v);
        if (v === 0) next.push(nxt);
      }
    }
    queue = next;
  }
  if (visited !== tasks.length) return null; // 存在环

  // 拓扑序输出（稳定：同层按声明序）。
  const order: PlanTask[] = [];
  const done = new Set<string>();
  let pending = [...tasks];
  while (pending.length) {
    const ready = pending.filter((t) => t.dependsOn.every((d) => done.has(d)));
    if (!ready.length) return null; // 理论不可达（前面已检环）
    for (const t of ready) {
      order.push(t);
      done.add(t.id);
    }
    pending = pending.filter((t) => !done.has(t.id));
  }

  return { goal, tasks: order };
}

/** planToWorkflowDef 的选项（见设计文档 §4 映射契约）。 */
export interface PlanToWorkflowOptions {
  /** 每个 task 默认使用的 agent（字符串 id 经 AgentRegistry 解析，或内联 AgentCard）。必填。 */
  agentRef: string | AgentCard;
  /** 按 task.id 覆盖默认 agent（可选，实现「不同 task 不同 agent」）。 */
  agentRefByTask?: Record<string, string | AgentCard>;
  /**
   * 工作流 id（设计文档 R4：建议每次确认唯一，避免 DagEngine 拒绝并发运行）。
   * 缺省自动生成 `plan:<ts>-<rand>`。
   */
  workflowId?: string;
  /** 全局租户标识（可选，透传给每个 step 的记忆分区与护栏策略）。 */
  tenantId?: string;
  /** 全局追踪 id（可选，贯穿所有 step 的 agent 调用，OTel 跨 agent 关联）。 */
  traceId?: string;
}

/**
 * 把一个 PlanTask 映射成 StepDef 的 inputMapping（设计文档 §4 黑板契约）：
 * - `goal`：`'input'` → 取工作流全局初始输入（= plan.goal，由 engine.run(def, goal) 传入）；
 * - `taskMeta`：字面量源，内联本 task 的 title/steps/expectedOutput（JSON 字符串），
 *   供 executor 装配 prompt —— 不经 prompt 压缩，零 token 膨胀；
 * - `upstream_<dep>`：`'steps.<dep>'` → 取上游 step 的**真实**产出（共享黑板，见 engine outputs），
 *   直接修掉旧隔离方案的「摘要有损 + token O(任务数)」两个坑。
 *
 * 返回的映射交给 DagEngine.resolveInput 解析：值为 `'input'` 取初始输入，`'steps.<id>'` 取上游输出，
 * 其它字符串按字面量原样注入（taskMeta 即此分支）。
 */
export function buildInputMapping(task: PlanTask): Record<string, string> {
  const map: Record<string, string> = {
    goal: 'input',
    taskMeta: JSON.stringify({
      id: task.id,
      title: task.title,
      steps: task.steps,
      expectedOutput: task.expectedOutput,
    }),
  };
  for (const d of task.dependsOn) {
    map[`upstream_${d}`] = `steps.${d}`;
  }
  return map;
}

/**
 * 把 ExecutionPlan 映射为可被 DagEngine 执行的 WorkflowDef（设计文档 §4 的核心桥）。
 * - 每个 PlanTask → 一个 StepDef（task.id → step.id，dependsOn 直接透传为 DAG 边）；
 * - 黑板语义：下游 step 经 inputMapping 的 upstream_<dep> 读取上游真实产出；
 * - fail-fast：空 tasks 或无 agentRef 直接抛错（与 DagEngine.validateWorkflow 对齐）。
 *
 * 纯函数、零运行时依赖（type import 编译后擦除），可独立单测；执行由 server 注入的
 * createWorkflowExecutor 完成（设计文档 §5 prompt 装配约定）。
 */
export function planToWorkflowDef(plan: ExecutionPlan, opts: PlanToWorkflowOptions): WorkflowDef {
  if (!plan || !Array.isArray(plan.tasks) || plan.tasks.length === 0) {
    throw new Error('planToWorkflowDef: plan must carry a non-empty tasks[]');
  }
  if (!opts || !opts.agentRef) {
    throw new Error('planToWorkflowDef: agentRef (default agent for all tasks) is required');
  }
  const byTask = opts.agentRefByTask ?? {};
  const steps: StepDef[] = plan.tasks.map((task) => ({
    id: task.id,
    agentRef: byTask[task.id] ?? opts.agentRef,
    dependsOn: task.dependsOn,
    inputMapping: buildInputMapping(task),
    // P3：人工审批门透传（未标记任务零回归面）——引擎在该 step 所在波次前暂停 run。
    ...(task.requireApproval === true ? { requireApproval: true } : {})
  }));
  const def: WorkflowDef = {
    id: opts.workflowId || genPlanWorkflowId(),
    steps,
  };
  if (opts.tenantId) def.tenantId = opts.tenantId;
  if (opts.traceId) def.traceId = opts.traceId;
  return def;
}

/** 生成 plan 工作流 id（时间戳 + 随机后缀，R4 防并发拒绝；与 DagEngine.genRunId 同款，无需 uuid 依赖）。 */
function genPlanWorkflowId(): string {
  const rand =
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `plan:${Date.now().toString(36)}-${rand}`;
}

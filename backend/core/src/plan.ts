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
  /**
   * P4.5 结果断言词表：2~4 个「该任务最终产出必须包含」的短词，planner 依据
   * expectedOutput 的验收检查点提取。经 taskMeta 透传给 executor，逐项生成
   * contains 断言（与执行器级验证器组合，全部满足才算通过）——产出跑题 / 缺
   * 少关键章节（任一词缺失）即判失败。可选：无明确关键词可提取的任务缺省不填
   * （缺省 = 不启用结果断言，零回归面）。
   */
  outputChecks?: string[];
}

/** 结构化执行计划（plan:proposed 事件的 payload 契约）。 */
export interface ExecutionPlan {
  goal: string;
  tasks: PlanTask[];
}

/**
 * planner 系统提示词：两态工作流——需求清晰时「理解目标 → 调研 → 拆分」产出结构化计划；
 * 需求模糊 / 关键前提缺失 / 高风险未对齐时「澄清」分支产出 goalDraft + questions，等用户确认目标后再拆。
 * 提示词仅作为 user turn 注入（system prompt 仍是 harness 通用助手），工具（web_fetch / 读文件等）
 * 在 propose 阶段本就可用，这里显式鼓励调研，并以阶段约束让规划过程「有思考、有依据、有确认」。
 */
export function buildPlannerPrompt(userInput: string): string {
  return [
    '你是资深任务规划师。请先理解用户需求，再产出执行计划；若需求不清则先澄清目标。',
    '',
    '严格按顺序执行：',
    '1. 理解目标：用一句话复述用户的真实目标与关键约束。',
    '2. 判断清晰度：',
    '   - 若需求模糊、关键前提缺失、或涉及不可逆/高风险操作且目标尚未对齐 → 进入「澄清」分支（见格式 B），不要强行出计划。',
    '   - 否则进入「调研 + 拆分」分支。',
    '3. 调研（仅「调研 + 拆分」分支、且计划依赖外部事实时才做）：如计划需要外部资料 / 网页 / 文件 / 数据，先调用可用工具（web_fetch / 读文件等）获取依据，把结论沉淀进任务的 steps 与 expectedOutput。**调研预算：最多调用 3 次工具、总预算 1 次规划内完成**——信息足够拆分即停，信息不足就在产出中标注数据缺口；禁止为「更全面」反复检索，这会拖垮规划时效。检索失败须显式标注数据缺口，禁止以「无法找到，请自行查阅」式放弃收尾。',
    '4. 拆分：围绕已确认目标，把任务拆成「一次对话可独立完成、可独立验收」的单元（通常 2~6 个）。',
    '',
    '输出格式（二选一，必须是单个 JSON 对象，不要输出任何解释文字、markdown 围栏或多余内容）：',
    '',
    'A. 计划（需求清晰时）：',
    '{"goal": string, "tasks": [{"id": "t1", "title": string, "steps": string[], "dependsOn": string[], "expectedOutput": string, "requireApproval"?: boolean, "outputChecks"?: string[]}]}',
    '- goal：用户已确认的目标（一句话，可验收）。',
    '- task.id 用 t1/t2/… 命名；dependsOn 只能引用已定义的任务 id，且不得形成循环依赖。',
    '- expectedOutput 必须包含可验收的检查点（章节结构 / 关键数据项 / 产出体量），禁止「完成分析」「内容完整」式模糊描述。',
    '- 仅当某任务涉及不可逆或高风险操作（删除数据、发布、金钱相关等）时，才设置 "requireApproval": true（执行前需用户人工批准）；其余任务一律省略该字段。',
    '- 为每个任务提供 outputChecks：2~4 个该任务最终产出中必须出现的短词（验收门禁按「产出必须包含」逐条断言），从 expectedOutput 的验收检查点提取；无法提取明确关键词的任务省略该字段。',
    '',
    'B. 澄清（需求不清时）：',
    '{"clarify": true, "goalDraft": string, "questions": [{"q": string, "options": string[]}], "needs"?: string}',
    '- goalDraft：你对目标的初步理解草稿（供用户确认或修正）。',
    '- questions：需要用户回答 / 确认的 1~5 个关键问题（具体问题，不要泛泛而问）。',
    '- 每个问题必须附 options：2~4 个该问题最常见的候选答案（短词或短语，覆盖典型场景），供用户直接点选；用户也可自行输入其他答案。',
    '- needs（可选）：你认为缺失的关键信息或前置条件。',
    '',
    `用户需求：${userInput}`,
  ].join('\n');
}

/** 澄清问题（可附候选选项供用户点选，也允许用户自行输入）。 */
export interface PlanClarifyQuestion {
  /** 问题文本。 */
  q: string;
  /** 2~4 个典型候选答案（可选，供用户点选）。 */
  options?: string[];
}

/** 澄清结果（plan:clarify 事件的 payload 契约）：模型认为需求不清、需先确认目标。 */
export interface PlanClarify {
  /** 固定 true，用于与计划 JSON 区分。 */
  clarify: true;
  /** 模型对目标的初步理解草稿，供用户确认或修正。 */
  goalDraft: string;
  /** 需要用户回答 / 确认的关键问题（1~5 条），可附候选选项。 */
  questions: PlanClarifyQuestion[];
  /** 模型判断缺失的关键信息或前置条件（可选）。 */
  needs?: string;
}

/** 计划 / 澄清联合解析结果。 */
export type PlanParseResult =
  | { kind: 'plan'; plan: ExecutionPlan }
  | { kind: 'clarify'; clarify: PlanClarify }
  | null;

/**
 * 从模型输出中容错提取澄清 JSON（与 parsePlanOutput 同级容错：直接 parse → 去围栏 → 截取首尾括号）。
 * 仅当 `clarify === true` 且 goalDraft / questions 至少其一非空才视为有效澄清，否则返回 null。
 */
export function parseClarifyOutput(text: string): PlanClarify | null {
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
    if (!data || typeof data !== 'object') continue;
    const d = data as Record<string, unknown>;
    if (d.clarify !== true) continue;
    const goalDraft = typeof d.goalDraft === 'string' ? d.goalDraft.trim() : '';
    // questions 兼容两种形态：旧格式 string[]（历史落盘）与新格式 [{q, options}]（可点选）。
    const questions = Array.isArray(d.questions)
      ? (d.questions as unknown[])
          .map((item) => {
            if (typeof item === 'string') {
              const q = item.trim();
              return q ? { q } : null;
            }
            if (item && typeof item === 'object') {
              const o = item as Record<string, unknown>;
              const q = typeof o.q === 'string' ? o.q.trim() : '';
              if (!q) return null;
              const options = Array.isArray(o.options)
                ? (o.options as unknown[])
                    .map((x) => String(x).trim())
                    .filter(Boolean)
                    .slice(0, 4)
                : [];
              return options.length ? { q, options } : { q };
            }
            return null;
          })
          .filter((x): x is { q: string; options?: string[] } => x !== null)
          .slice(0, 5)
      : [];
    const needs = typeof d.needs === 'string' ? d.needs.trim() : '';
    if (!goalDraft && questions.length === 0) continue;
    return {
      clarify: true,
      goalDraft,
      questions,
      ...(needs ? { needs } : {})
    };
  }
  return null;
}

/**
 * 计划 / 澄清联合解析：先试计划 JSON，失败再试澄清 JSON。
 * 用于 propose 阶段 run:end 的二分支分发（plan:proposed vs plan:clarify）。
 */
export function parsePlanOrClarify(text: string): PlanParseResult {
  const plan = parsePlanOutput(text);
  if (plan) return { kind: 'plan', plan };
  const clarify = parseClarifyOutput(text);
  if (clarify) return { kind: 'clarify', clarify };
  return null;
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
    // P4.5：结果断言词表——非字符串项剔除、空白项剔除、上限 8 条（防膨胀）；
    // 全空 / 非数组一律缺省丢弃（不整单作废，零回归面）。
    const rawChecks = Array.isArray(t.outputChecks)
      ? (t.outputChecks as unknown[]).map((s) => String(s).trim()).filter(Boolean)
      : [];
    const outputChecks = rawChecks.slice(0, 8);
    tasks.push({
      id,
      title,
      steps,
      dependsOn,
      expectedOutput,
      ...(requireApproval ? { requireApproval: true } : {}),
      ...(outputChecks.length > 0 ? { outputChecks } : {})
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
      // P4.5：结果断言词表（缺省时不带键，executor 装配侧零感知 = 零回归面）。
      ...(task.outputChecks && task.outputChecks.length > 0 ? { outputChecks: task.outputChecks } : {})
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
    // P4.5：计划任务以「交付真实产出」为完成标准——无效产出（空 / 模型中断 partial /
    // 护栏兜底话术）按失败处置（可断点续跑），不再以 5/5 ✅ 掩盖缺失的交付物。
    // 该 flag 仅由本映射桥写入，存量手工 WorkflowDef 缺省不开（零回归面）。
    failOnInvalidOutput: true,
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

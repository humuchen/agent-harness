/**
 * 问答 / 计划模式（P0）—— 计划模式的结构化原语。
 *
 * 职责边界：core 只提供「计划契约 + planner 提示词 + 容错解析器」三件纯函数级能力，
 * 不感知 UI、不感知交互模式语义（那属于 webapp）；server 只做透传与落盘。
 * 「计划生成」本身是一次普通 run：planner 提示词约束模型输出计划 JSON，
 * 服务端在 run:end 时用 parsePlanOutput 解析并补发 plan:proposed 事件。

 */

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
    '2. JSON 形如 {"goal": string, "tasks": [{"id": string, "title": string, "steps": string[], "dependsOn": string[], "expectedOutput": string}]}',
    '3. task.id 用 t1/t2/… 命名；dependsOn 只能引用已定义的任务 id，且不得形成循环依赖。',
    '4. 每个任务的 steps 是该任务内的有序执行步骤；expectedOutput 描述该任务完成后的可验证产出。',
    '5. 任务粒度以「一次对话可独立完成」为准，通常 2~6 个任务。',
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
    tasks.push({ id, title, steps, dependsOn, expectedOutput });
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

/**
 * 业务层 · 运行评估与配方版本化（Evaluation & Recipe Versioning）。
 *
 * 设计原则（与核心 framework 隔离，保持可插拔/可组合）：
 * - 评估是「业务质量策略」，不属于核心 AgentHarness。核心只产出事件流，本模块负责把
 *   事件流还原为「运行配方快照（RunRecord）」并交给可替换的 Evaluator 打分。
 * - Evaluator / RecipeStore 均为接口 + 默认实现 + 组合工厂；替换评分逻辑（如 LLM-as-judge）
 *   或落地存储（如数据库）只需改 createEvaluator / createRecipeStore，server 其余代码不动。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';

/** 一次运行的配方快照：prompt / 工具 / 模型 + 关键质量信号，天然即「版本化配方」。 */
export interface RunRecord {
  jobId: string;
  mode: string;
  prompt: string;
  model?: string;
  tools: string[];
  steps: number;
  guardrailsBlocked: number;
  budgetExceeded: boolean;
  finalAnswer: string;
  totalTokens: number;
  totalCost: number;
  finishedAt?: number;
}

/** 把运行队列里累积的 harness 事件还原为 RunRecord（业务层解析，不依赖核心类型）。 */
export function runRecordFromEvents(jobId: string, events: unknown[]): RunRecord {
  const rec: RunRecord = {
    jobId,
    mode: '',
    prompt: '',
    tools: [],
    steps: 0,
    guardrailsBlocked: 0,
    budgetExceeded: false,
    finalAnswer: '',
    totalTokens: 0,
    totalCost: 0,
  };
  const seenTools = new Set<string>();
  for (const raw of events as Array<Record<string, any>>) {
    const t = raw && raw.type;
    if (!t) continue;
    switch (t) {
      case 'run:meta':
        if (raw.notes) rec.steps = rec.steps; // notes 仅展示
        break;
      case 'run:start':
        if (typeof raw.input === 'string') rec.prompt = raw.input;
        break;
      case 'run:tools':
        for (const tool of raw.tools || []) {
          const name = typeof tool === 'string' ? tool : tool?.name;
          if (name) seenTools.add(name);
        }
        break;
      case 'step:start':
        rec.steps = Math.max(rec.steps, Number(raw.step) || 0);
        break;
      case 'tool:start':
        if (raw.call?.name) seenTools.add(raw.call.name);
        break;
      case 'llm:response':
        if (typeof raw.content === 'string' && raw.content) rec.finalAnswer = raw.content;
        break;
      case 'guardrail:blocked':
        rec.guardrailsBlocked += 1;
        break;
      case 'budget:exceeded':
        rec.budgetExceeded = true;
        break;
      case 'run:cost':
        rec.totalTokens = Number(raw.cumulativeTokens) || 0;
        rec.totalCost = Number(raw.cumulativeCost) || 0;
        break;
      case 'run:end':
        if (typeof raw.final === 'string' && raw.final) rec.finalAnswer = raw.final;
        if (typeof raw.steps === 'number') rec.steps = raw.steps;
        rec.finishedAt = Date.now();
        break;
      case '_done':
        rec.finishedAt = rec.finishedAt || Date.now();
        break;
      default:
        break;
    }
  }
  rec.tools = [...seenTools];
  return rec;
}

export interface EvalResult {
  score: number; // 0..1
  passed: boolean;
  reasons: string[];
}

export interface Evaluator {
  /** 对一次运行配方打分，返回可解释的评分结果与原因。 */
  evaluate(rec: RunRecord): EvalResult;
}

/**
 * 默认规则评估器：可解释、零依赖。检查项：
 *  - 护栏未被拦截；预算未超限；有最终回答；有工具被调用（证明闭环跑通）；
 *  - 回答非空。加权汇总为 0..1 分。任一硬性失败（护栏拦截 / 预算超限 / 无回答）直接判不通过。
 */
export class RuleBasedEvaluator implements Evaluator {
  evaluate(rec: RunRecord): EvalResult {
    const reasons: string[] = [];
    let score = 1;
    let hardFail = false;

    if (rec.guardrailsBlocked > 0) {
      hardFail = true;
      score = 0;
      reasons.push(`护栏拦截 ${rec.guardrailsBlocked} 次（硬性不通过）`);
    }
    if (rec.budgetExceeded) {
      hardFail = true;
      score = 0;
      reasons.push('预算超限（硬性不通过）');
    }
    if (!rec.finalAnswer || !rec.finalAnswer.trim()) {
      hardFail = true;
      score = 0;
      reasons.push('无最终回答（硬性不通过）');
    } else {
      reasons.push('产出非空最终回答');
    }
    if (rec.tools.length === 0) {
      score -= 0.3;
      reasons.push('本轮未调用任何工具（可能是纯对话）');
    } else {
      reasons.push(`调用工具 ${rec.tools.length} 个：${rec.tools.join(', ')}`);
    }
    if (rec.steps <= 0) {
      score -= 0.1;
      reasons.push('无明确步骤');
    } else {
      reasons.push(`执行 ${rec.steps} 步`);
    }
    if (rec.totalTokens > 0) reasons.push(`tokens=${rec.totalTokens} cost=$${rec.totalCost.toFixed(6)}`);

    score = Math.max(0, Math.min(1, score));
    if (reasons.length === 0) reasons.push('通过');
    return { score: Number(score.toFixed(3)), passed: !hardFail && score >= 0.5, reasons };
  }
}

/** 组合工厂：返回 Evaluator 实现。要接 LLM-as-judge，只需在此返回实现了 Evaluator 的对象。 */
export function createEvaluator(): Evaluator {
  return new RuleBasedEvaluator();
}

// ---------------------------------------------------------------------------
// 运行完成闸门（Run-completion gate）：把评估接入「一次 run 结束」的时点。
// 与 POST /api/eval 的「按需评估」不同，这里是「自动评估」——运行跑完立刻打分，
// 可据配置决定仅告警（warn）还是硬性拦截（enforce）。运行管线（run-queue.execute）
// 在 harness.run() 返回后调用本模块，把结果级断言校验（护栏/预算/非空回答/工具闭环）
// 作为「交付前自检」闸门。
// ---------------------------------------------------------------------------

export type EvalGate = 'off' | 'warn' | 'enforce';

/** 解析运行完成闸门开关：HARNESS_EVAL_GATE = off(默认) | warn | enforce。 */
export function resolveEvalGate(): EvalGate {
  const v = (process.env.HARNESS_EVAL_GATE ?? 'off').toLowerCase().trim();
  return v === 'warn' || v === 'enforce' ? v : 'off';
}

export interface CompletionEval {
  record: RunRecord;
  result: EvalResult;
  gate: EvalGate;
}

/**
 * 运行结束后自动评估。把事件流还原为 RunRecord，并以运行最终回答覆盖 finalAnswer，
 * 再交给 Evaluator 打分。gate=off 时直接返回 null（不评估，零开销）。
 */
export function evaluateCompletion(
  jobId: string,
  events: unknown[],
  finalText: string,
  gate: EvalGate = resolveEvalGate(),
): CompletionEval | null {
  if (gate === 'off') return null;
  const rec = runRecordFromEvents(jobId, events);
  // 运行结束时的真实最终回答优先（run:end/_done 之前事件可能尚无 finalAnswer）。
  rec.finalAnswer = finalText;
  rec.finishedAt = rec.finishedAt ?? Date.now();
  const result = createEvaluator().evaluate(rec);
  return { record: rec, result, gate };
}

// ---------------------------------------------------------------------------
// 配方版本化（Recipe Versioning）：把一次 RunRecord 存为命名版本，便于回归比对。
// ---------------------------------------------------------------------------

export interface Recipe {
  id: string;
  name: string;
  createdAt: number;
  record: RunRecord;
  notes?: string;
}

export interface RecipeStore {
  save(recipe: Recipe): void;
  get(id: string): Recipe | null;
  list(): Recipe[];
}

/** 纯内存配方库（默认，零依赖；进程重启即清空，适合演示/单节点）。 */
export class VolatileRecipeStore implements RecipeStore {
  private map = new Map<string, Recipe>();
  save(r: Recipe): void {
    this.map.set(r.id, r);
  }
  get(id: string): Recipe | null {
    return this.map.get(id) ?? null;
  }
  list(): Recipe[] {
    return [...this.map.values()].sort((a, b) => b.createdAt - a.createdAt);
  }
}

/** 文件配方库：按 id 落盘 JSON（零 npm 依赖），多节点/重启可保留。 */
export class FileRecipeStore implements RecipeStore {
  constructor(private dir: string) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
  private path(id: string): string {
    return join(this.dir, `${id}.json`);
  }
  save(r: Recipe): void {
    const p = this.path(r.id);
    const tmp = p + '.tmp';
    writeFileSync(tmp, JSON.stringify(r, null, 2), 'utf-8');
    renameSync(tmp, p);
  }
  get(id: string): Recipe | null {
    try {
      return JSON.parse(readFileSync(this.path(id), 'utf-8')) as Recipe;
    } catch {
      return null;
    }
  }
  list(): Recipe[] {
    try {
      return require('node:fs')
        .readdirSync(this.dir)
        .filter((f: string) => f.endsWith('.json'))
        .map((f: string) => this.get(f.replace(/\.json$/, '')))
        .filter(Boolean) as Recipe[];
    } catch {
      return [];
    }
  }
}

/** 组合工厂：按 RECIPE_DIR 环境变量选文件库，否则内存库。 */
export function createRecipeStore(): RecipeStore {
  const dir = process.env.RECIPE_DIR;
  if (dir) return new FileRecipeStore(dir);
  return new VolatileRecipeStore();
}

/**
 * 配方库单例：run-queue（运行完成闸门自动存档）与 server 的 /api/eval、/api/recipes
 * 共用同一份存储，避免各自 new 出独立实例导致列表对不齐。内部惰性创建。
 */
let _recipeStore: RecipeStore | null = null;
export function getRecipeStore(): RecipeStore {
  if (!_recipeStore) _recipeStore = createRecipeStore();
  return _recipeStore;
}

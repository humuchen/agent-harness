/**
 * 业务层 · 运行评估与配方版本化（Evaluation & Recipe Versioning）。
 *
 * 设计原则（与核心 framework 隔离，保持可插拔/可组合）：
 * - 评估是「业务质量策略」，不属于核心 AgentHarness。核心只产出事件流，本模块负责把
 *   事件流还原为「运行配方快照（RunRecord）」并交给可替换的 Evaluator 打分。
 * - Evaluator / RecipeStore 均为接口 + 默认实现 + 组合工厂；替换评分逻辑（如 LLM-as-judge）
 *   或落地存储（如数据库）只需改 createEvaluator / createRecipeStore，server 其余代码不动。
 *
 * Evaluator 实现：
 * - RuleBasedEvaluator：可解释、零依赖的规则评估（默认兜底）。
 * - LLMJudgeEvaluator：LLM-as-judge，注入 LLM 客户端打分；LLM 失败/输出不可解析时回退规则评估。
 *   经 EVAL_JUDGE_ENABLED 特性开关启用（默认 off）；judge LLM 凭据缺失时自动降级为规则评估。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { createOpenRouterLLM, isEnabled, structLog, type LLM } from '@agent-harness/core';

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
        // notes 仅展示，不参与指标计算（原此处为自赋值死代码，已清理）。
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
  /** 对一次运行配方打分，返回可解释的评分结果与原因。LLM-as-judge 为异步实现，故允许返回 Promise。 */
  evaluate(rec: RunRecord): EvalResult | Promise<EvalResult>;
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

// ---------------------------------------------------------------------------
// LLM-as-judge 评估器（默认实现，经 EVAL_JUDGE_ENABLED 特性开关门控启用）。
// 注入 LLM 客户端对运行配方打分；LLM 失败或输出不可解析时回退规则评估（缺失即降级）。
// ---------------------------------------------------------------------------

/** judge 系统提示：约束输出「评分 + 逐条理由」格式，便于确定性解析。 */
const JUDGE_SYSTEM_PROMPT = `你是一个严格、公正的「运行质量评估器」（LLM-as-judge）。你会收到一次 agent 运行的快照与最终回答，需要评估最终回答对用户 prompt 的完成质量，输出一个 0..1 的小数评分（越高越好）与简短中文理由。

评估维度（按需取舍，不必全部覆盖）：
1. 相关性：是否切题、直接回应用户 prompt。
2. 正确性：事实准确、逻辑自洽、无明显错误。
3. 完整性：覆盖用户需求、无关键遗漏。
4. 工具使用：任务需要工具时是否正确调用并据此得出结论；无必要时不应臆造工具调用。
5. 护栏与预算：被护栏拦截、超预算、步骤异常均作为硬性扣分项。

输出格式（严格遵守）：先输出一行评分，再逐条输出理由，每条以「- 」开头：
评分: <0..1 之间的小数>
理由:
- <理由一>
- <理由二>`;

/** 把 RunRecord 渲染为 judge 用户提示。 */
function buildJudgeUserPrompt(rec: RunRecord): string {
  return [
    `用户 prompt：${rec.prompt}`,
    ``,
    `最终回答：${rec.finalAnswer && rec.finalAnswer.trim() ? rec.finalAnswer : '（空）'}`,
    ``,
    `已注册工具：${rec.tools.length > 0 ? rec.tools.join(', ') : '无'}`,
    `步骤数：${rec.steps}`,
    `护栏拦截次数：${rec.guardrailsBlocked}`,
    `预算超限：${rec.budgetExceeded ? '是' : '否'}`,
    `总 tokens：${rec.totalTokens}`,
    `总成本：$${Number(rec.totalCost).toFixed(6)}`
  ].join('\n');
}

/** 把任意数值归一到 0..1：≤1 原样；1..10 视为十分制折算；其余截断。 */
export function normalizeScore(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n <= 1) return Math.max(0, n);
  if (n <= 10) return Math.max(0, Math.min(1, n / 10));
  return 1;
}

/** 解析 judge 输出为 { score, reasons }；无法解析返回 null（触发兜底）。 */
export function parseJudgeOutput(text: string): { score: number; reasons: string[] } | null {
  if (!text || !text.trim()) return null;

  // 优先尝试 JSON（LLM 偶尔无视格式约束直接输出 JSON 对象）。
  const jsonProbe = text.match(/\{[\s\S]*\}/);
  if (jsonProbe) {
    try {
      const obj = JSON.parse(jsonProbe[0]);
      if (obj && typeof obj.score === 'number') {
        const reasons = Array.isArray(obj.reasons)
          ? (obj.reasons as unknown[]).filter((r): r is string => typeof r === 'string' && r.trim() !== '').map((r) => r.trim())
          : [];
        return { score: normalizeScore(obj.score), reasons };
      }
    } catch {
      /* JSON 解析失败 → 继续走文本格式解析 */
    }
  }

  // 文本格式：评分 + 逐条理由。
  let raw: number | undefined;
  const scoreRe = /评分\s*[:：]\s*([0-9]*\.?[0-9]+)/.exec(text);
  if (scoreRe) raw = Number(scoreRe[1]);
  if (raw === undefined || !Number.isFinite(raw)) {
    const anyNum = /([0-9]*\.?[0-9]+)/.exec(text);
    if (anyNum) raw = Number(anyNum[1]);
  }
  if (raw === undefined || !Number.isFinite(raw)) return null;
  const score = normalizeScore(raw);

  const reasons: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*[-•*]\s+(.+)/.exec(line) ?? /^\s*\d+[.)]\s+(.+)/.exec(line);
    if (m) {
      const r = m[1]?.trim();
      if (r) reasons.push(r);
    }
  }
  return { score, reasons };
}

export interface LLMJudgeOptions {
  /** judge LLM 客户端（LLM 契约：llm(messages, tools) => Promise<{ content }>）。 */
  llm: LLM;
  /** 通过阈值（默认 0.5）。 */
  passThreshold?: number;
  /** 覆盖系统提示（默认内置）。 */
  systemPrompt?: string;
  /** LLM 失败/不可解析时的兜底评估器（默认 RuleBasedEvaluator）。 */
  fallback?: Evaluator;
}

export class LLMJudgeEvaluator implements Evaluator {
  private readonly llm: LLM;
  private readonly passThreshold: number;
  private readonly systemPrompt: string;
  private readonly fallback: Evaluator;

  constructor(opts: LLMJudgeOptions) {
    if (!opts || !opts.llm) throw new Error('LLMJudgeEvaluator 需要 llm 客户端');
    this.llm = opts.llm;
    this.passThreshold = opts.passThreshold ?? 0.5;
    this.systemPrompt = opts.systemPrompt ?? JUDGE_SYSTEM_PROMPT;
    this.fallback = opts.fallback ?? new RuleBasedEvaluator();
  }

  async evaluate(rec: RunRecord): Promise<EvalResult> {
    try {
      const resp = await this.llm(
        [
          { role: 'system', content: this.systemPrompt },
          { role: 'user', content: buildJudgeUserPrompt(rec) }
        ],
        []
      );
      const parsed = parseJudgeOutput(resp?.content ?? '');
      if (!parsed) return this.degrade(rec, 'LLM 评估输出无法解析');
      return {
        passed: parsed.score >= this.passThreshold,
        score: parsed.score,
        reasons: parsed.reasons.length > 0 ? parsed.reasons : ['LLM 评估未给出理由']
      };
    } catch (err) {
      return this.degrade(rec, `LLM 评估失败：${(err as Error).message}`);
    }
  }

  /** 兜底：回退规则评估，并在理由前置说明降级原因，保证可解释性。 */
  private async degrade(rec: RunRecord, why: string): Promise<EvalResult> {
    structLog('warn', 'llm-judge fallback to rule evaluator', { reason: why });
    const r = await this.fallback.evaluate(rec);
    return {
      passed: r.passed,
      score: r.score,
      reasons: [`${why}，已回退规则评估`, ...r.reasons]
    };
  }
}

/**
 * 构造 judge LLM 客户端：优先专用 EVAL_JUDGE_* 配置，缺失则回退 OpenRouter（OPEN_*）。
 * 无可用 API 凭据时返回 null（→ 规则评估，缺失即降级）。
 */
function createJudgeLLM(): LLM | null {
  const judgeKey = (process.env.EVAL_JUDGE_API_KEY ?? '').trim();
  const openKey = (process.env.OPEN_API_KEY ?? '').trim();
  if (!judgeKey && !openKey) return null;
  return createOpenRouterLLM({
    apiKey: judgeKey || undefined,
    model: (process.env.EVAL_JUDGE_MODEL ?? '').trim() || undefined,
    baseUrl: (process.env.EVAL_JUDGE_BASE_URL ?? '').trim() || undefined
  });
}

export interface CreateEvaluatorOptions {
  /** 注入的 LLM-as-judge 客户端；提供则优先于自动构造。 */
  judgeLlm?: LLM;
  /** 是否启用 LLM-as-judge（默认读特性开关 EVAL_JUDGE_ENABLED）。 */
  useLlmJudge?: boolean;
  /** 覆盖通过阈值（默认 0.5）。 */
  passThreshold?: number;
}

/** 组合工厂：返回 Evaluator 实现。要接 LLM-as-judge，传入 judgeLlm 或开启 EVAL_JUDGE_ENABLED。 */
export function createEvaluator(opts: CreateEvaluatorOptions = {}): Evaluator {
  // 显式注入的 judgeLlm 优先；否则按 useLlmJudge 开关（默认读特性开关）自动构造。
  let judgeLlm = opts.judgeLlm;
  if (!judgeLlm && (opts.useLlmJudge ?? isEnabled('llmJudge'))) {
    judgeLlm = createJudgeLLM() ?? undefined;
  }
  if (judgeLlm) {
    return new LLMJudgeEvaluator({
      llm: judgeLlm,
      passThreshold: opts.passThreshold,
      fallback: new RuleBasedEvaluator()
    });
  }
  return new RuleBasedEvaluator();
}

/** 评估器单例（与 getRecipeStore 同模式）：run-queue 完成闸门与 /api/eval 共用同一实例。 */
let _evaluator: Evaluator | null = null;
export function getEvaluator(): Evaluator {
  if (!_evaluator) _evaluator = createEvaluator();
  return _evaluator;
}

/** 重置评估器单例（供测试与配置热更新场景使用）。 */
export function resetEvaluator(): void {
  _evaluator = null;
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
export async function evaluateCompletion(
  jobId: string,
  events: unknown[],
  finalText: string,
  gate: EvalGate = resolveEvalGate(),
  evaluator?: Evaluator
): Promise<CompletionEval | null> {
  if (gate === 'off') return null;
  const rec = runRecordFromEvents(jobId, events);
  // 运行结束时的真实最终回答优先（run:end/_done 之前事件可能尚无 finalAnswer）。
  rec.finalAnswer = finalText;
  rec.finishedAt = rec.finishedAt ?? Date.now();
  const result = await (evaluator ?? getEvaluator()).evaluate(rec);
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

/**
 * TypeSafe AI Jev System One 模型接入
 *
 * Jev 不是文本生成型 LLM，也不兼容 OpenAI /chat/completions 协议。它是一个
 * 「System One Model」：接收「程序状态(state)」+ 一组带类型的结构化问题(questions)，
 * 返回带校准概率的有类型决策（Choice / Score / Noul）。因此本项目把它作为「内置决策工具」
 * 接入，让 agent 在需要做分类、打分、路由、置信度门控护栏时使用，而不是当作聊天模型。
 *
 * 本文件同时提供两层接入形态：
 *   1) `jevDecide(...)` —— 可被「子系统（护栏 / 路由 / RAG / 上下文压缩）」在 LLM 调用
 *      工具之外直接调用的异步客户端（不依赖工具链路），用于把 Jev 接进各子系统的自动路径；
 *   2) `registerJevDecide(...)` —— 注册为 `builtin__jev_decide` 工具，供 LLM 在 run 中主动调用。
 * 两者共用同一套 HTTP 调用与凭据解析，凭据解析优先级：显式参数 > 运行级 run-user(按用户 BYOK)
 *   > 环境变量（服务端级）。任一环节缺失 Key 即视为「未配置」，调用方据此回落旧逻辑（兜底）。
 *
 * 环境变量：
 * - TYPESAFE_API_KEY: TypeSafe AI API Key（服务端级；缺省则依赖按用户 BYOK 或保持未启用）
 * - TYPESAFE_BASE_URL: API base（默认 https://api.typesafe.ai/v1）
 * - TYPESAFE_TIMEOUT_MS: 调用超时（默认 10000ms）
 *
 * 接口：POST {base}/systemone，Bearer 鉴权
 * 入参：{ model?: "jev-latest", state: string, questions: Record<string, QuestionSpec> }
 * QuestionSpec 形如：
 *   - Choice: { type: "choice", options: string[], instructions?, criteria? }
 *   - Score:  { type: "score", min?, max?, instructions? }
 *   - Noul:   { type: "noul", instructions? }
 * 出参：结构化决策（answers 含 choice / probabilities / confidence / score / noul 等），归一化透传。
 */

import { objectParams, ToolRegistry } from '../tools';
import { structLog } from '../telemetry';
import { getRunUser } from '../run-user';
import { emitRunEvent } from '../run-events';

export type JevQuestionType = 'choice' | 'score' | 'noul';

export interface JevQuestionSpec {
  type: JevQuestionType;
  options?: string[];
  min?: number;
  max?: number;
  instructions?: string;
  criteria?: Record<string, string>;
}

export interface JevDecideOptions {
  /** TypeSafe API base（默认 https://api.typesafe.ai/v1）。 */
  baseUrl?: string;
  /** TypeSafe API Key（默认读 run-user → TYPESAFE_API_KEY）。 */
  apiKey?: string;
  /** 调用超时（ms，默认 10000）。 */
  timeoutMs?: number;
  /**
   * 调用方标签（仅用于统计/日志归属）：'tool'(LLM 主动调用) / 'injection-gate'(门禁) /
   * 'router'(路由) / 'rag-score'(RAG 打分) / 'context-compress'(压缩) / 自定义。可选。
   */
  caller?: string;
}

// ---------------------------------------------------------------------------
// 调用统计（进程级）：让「Jev 是否真的被调用过」在系统层面可观测。
// 通过 /api/jev/status（access/server）或 getJevStats() 读取；随进程生命周期重置。
// ---------------------------------------------------------------------------

interface JevStats {
  /** 成功调用次数。 */
  calls: number;
  /** 失败次数（网络/非 2xx/参数错误）。 */
  errors: number;
  /** 最近一次延迟（ms）。 */
  lastLatencyMs: number | null;
  /** 最近一次调用时间戳（epoch ms；null = 进程启动以来从未被调用）。 */
  lastCalledAt: number | null;
  /** 最近一次调用方标签。 */
  lastCaller: string | null;
  /** 最近一次失败的错误信息（成功调用后清空；null = 无失败记录）。 */
  lastError: string | null;
}

const jevStats: JevStats = {
  calls: 0,
  errors: 0,
  lastLatencyMs: null,
  lastCalledAt: null,
  lastCaller: null,
  lastError: null
};

/** 读取 Jev 调用统计（只读快照）。lastCalledAt === null 表示进程内从未被调用。 */
export function getJevStats(): JevStats {
  return { ...jevStats };
}

/** 归零统计（测试/运维用）。 */
export function resetJevStats(): void {
  jevStats.calls = 0;
  jevStats.errors = 0;
  jevStats.lastLatencyMs = null;
  jevStats.lastCalledAt = null;
  jevStats.lastCaller = null;
  jevStats.lastError = null;
}

const DEFAULT_BASE_URL = 'https://api.typesafe.ai/v1';

/** 单个问题的归一化决策答案。按 type 可能填充不同字段。 */
export interface JevAnswer {
  type: JevQuestionType;
  /** choice：被选中的选项。 */
  choice?: string;
  /** choice：各选项校准概率。 */
  probabilities?: Record<string, number>;
  /** score：有序等级上的打分。 */
  score?: number;
  /** noul：0~1 的二值概率。 */
  noul?: number;
  /** 校准置信度（0~1），可用于门控路由。 */
  confidence?: number;
  /** score 的多维拆解（criteria）。 */
  criteria?: Record<string, number>;
}

/** `jevDecide` 的归一化返回：结构化决策 + 原始响应（便于透传/调试）。 */
export interface JevDecision {
  model: string;
  /** 逐问题答案（问题名 -> 归一化 Answer）。 */
  answers: Record<string, JevAnswer>;
  /** 原始响应体（未改动，供上层按需取字段）。 */
  raw: unknown;
  /** 调用耗时（ms）。 */
  latencyMs: number;
}

/** 解析 Jev 凭据：显式参数 > 运行级 run-user（按用户 BYOK） > 环境变量。返回 null 表示未配置。 */
export function resolveJevCreds(opts: JevDecideOptions = {}): {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
} | null {
  const apiKey = opts.apiKey ?? getRunUser()?.jevApiKey ?? process.env.TYPESAFE_API_KEY ?? '';
  if (!apiKey) return null;
  const baseUrl = (
    opts.baseUrl ??
    getRunUser()?.jevBaseUrl ??
    process.env.TYPESAFE_BASE_URL ??
    DEFAULT_BASE_URL
  ).replace(/\/$/, '');
  const timeoutMs = opts.timeoutMs ?? Number(process.env.TYPESAFE_TIMEOUT_MS ?? 10000);
  return { apiKey, baseUrl, timeoutMs };
}

function normalizeAnswers(data: unknown): Record<string, JevAnswer> {
  const out: Record<string, JevAnswer> = {};
  if (!data || typeof data !== 'object') return out;
  const obj = data as Record<string, unknown>;
  // Jev 通常把逐问题答案包在 answers 下；若无 answers 则尝试把顶层按 JevAnswer 形状解析。
  const src: Record<string, unknown> =
    obj && typeof obj.answers === 'object' && obj.answers !== null
      ? (obj.answers as Record<string, unknown>)
      : obj;
  for (const [name, raw] of Object.entries(src)) {
    if (!raw || typeof raw !== 'object') continue;
    const a = raw as Record<string, unknown>;
    const type = (a.type as JevQuestionType) ?? inferType(a);
    const ans: JevAnswer = { type };
    if (typeof a.choice === 'string') ans.choice = a.choice;
    if (a.probabilities && typeof a.probabilities === 'object')
      ans.probabilities = a.probabilities as Record<string, number>;
    if (typeof a.score === 'number') ans.score = a.score;
    if (typeof a.noul === 'number') ans.noul = a.noul;
    if (typeof a.confidence === 'number') ans.confidence = a.confidence;
    if (a.criteria && typeof a.criteria === 'object')
      ans.criteria = a.criteria as Record<string, number>;
    out[name] = ans;
  }
  return out;
}

function inferType(a: Record<string, unknown>): JevQuestionType {
  if ('choice' in a || 'probabilities' in a) return 'choice';
  if ('score' in a || 'criteria' in a) return 'score';
  if ('noul' in a) return 'noul';
  return 'noul';
}

/**
 * 从 systemone 响应体提取 usage（若携带）。兼容常见三种命名：
 * prompt_tokens/input_tokens/inputTokens × completion_tokens/output_tokens/outputTokens。
 * 未携带或不可解析时返回 undefined（旁路事件缺省 tokens 字段，不虚构）。
 */
function extractJevUsage(data: unknown): { input: number; output: number } | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const u = (data as Record<string, unknown>).usage;
  if (!u || typeof u !== 'object') return undefined;
  const o = u as Record<string, unknown>;
  const pick = (...keys: string[]): number | undefined => {
    for (const k of keys) {
      const v = o[k];
      if (typeof v === 'number' && Number.isFinite(v)) return v;
    }
    return undefined;
  };
  const input = pick('prompt_tokens', 'input_tokens', 'inputTokens');
  const output = pick('completion_tokens', 'output_tokens', 'outputTokens');
  if (input == null && output == null) return undefined;
  return { input: input ?? 0, output: output ?? 0 };
}

/**
 * 直调 Jev System One（核心客户端）。
 * 供子系统在「LLM 调用工具」之外直接做结构化决策。
 * 未配置 Key / 网络错误 / 非 2xx 一律抛出 Error，调用方 catch 后回落旧逻辑（兜底）。
 *
 * @param state 程序状态文本（如用户输入、待判定内容、检索上下文）。
 * @param questions 问题映射（问题名 -> 问题定义）。
 * @param opts 凭据/超时（缺省走 resolveJevCreds 三级解析）。
 */
export async function jevDecide(
  state: string,
  questions: Record<string, JevQuestionSpec>,
  opts: JevDecideOptions = {}
): Promise<JevDecision> {
  const caller = opts.caller ?? 'unknown';
  const creds = resolveJevCreds(opts);
  if (!creds) {
    jevStats.errors++;
    throw new Error('Jev not configured (no API key)');
  }
  if (!state) {
    jevStats.errors++;
    throw new Error('state is required');
  }
  if (
    !questions ||
    typeof questions !== 'object' ||
    Array.isArray(questions) ||
    Object.keys(questions).length === 0
  ) {
    jevStats.errors++;
    throw new Error('questions must be a non-empty object');
  }

  const url = `${creds.baseUrl}/systemone`;
  const model = 'jev-latest';
  const t0 = Date.now();
  // 旁路事件去重标记：!resp.ok 的 throw 会落进下方 catch，避免同一次失败发两次 jev:call。
  let reported = false;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), creds.timeoutMs);
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${creds.apiKey}`,
      },
      body: JSON.stringify({ model, state, questions }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      const latencyMs = Date.now() - t0;
      structLog('warn', 'jevDecide: non-2xx response', { status: resp.status });
      // 旁路上报（失败）：让门禁/压缩等直连路径的失败调用同样在 run 调用链可见。
      reported = true;
      emitRunEvent({
        type: 'jev:call',
        caller,
        ok: false,
        latencyMs,
        questions: Object.keys(questions).length,
        questionSpec: questions,
        error: `HTTP ${resp.status}`
      });
      throw new Error(`Jev API error: ${resp.status} ${errText.slice(0, 200)}`);
    }
    const data = (await resp.json()) as unknown;
    const latencyMs = Date.now() - t0;
    const answers = normalizeAnswers(data);
    jevStats.calls++;
    jevStats.lastLatencyMs = latencyMs;
    jevStats.lastCalledAt = Date.now();
    jevStats.lastCaller = caller;
    structLog('info', 'jevDecide', {
      model,
      caller,
      n: Object.keys(questions).length,
      latency_ms: latencyMs,
    });
    // 旁路上报（成功）：jev:call 进当前 run 事件流（trace 树/前端调用链可见）。
    // 同时透传 questionSpec（问题）与 answers（输出记录），供调用链节点展开回溯。
    // usage 若响应体携带则一并透传（TypeSafe 侧计费口径；本系统成本体系暂不计入）。
    reported = true;
    const usage = extractJevUsage(data);
    emitRunEvent({
      type: 'jev:call',
      caller,
      ok: true,
      latencyMs,
      questions: Object.keys(questions).length,
      questionSpec: questions,
      answers,
      ...(usage ? { tokens: usage } : {})
    });
    return {
      model,
      answers,
      raw: data,
      latencyMs,
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    jevStats.errors++;
    jevStats.lastCalledAt = Date.now();
    jevStats.lastCaller = caller;
    structLog('error', 'jevDecide failed', { error: msg, caller });
    // 仅补发未被 !resp.ok 分支上报过的失败（网络异常 / 超时中止 / 响应解析失败）。
    if (!reported) {
      emitRunEvent({
        type: 'jev:call',
        caller,
        ok: false,
        latencyMs: Date.now() - t0,
        questions: Object.keys(questions).length,
        questionSpec: questions,
        error: msg.slice(0, 200)
      });
    }
    throw e instanceof Error ? e : new Error(msg);
  }
}

/**
 * 便捷封装：语义级注入检测打分（0~1）。
 * 用于危险操作门禁的「语义级注入打分器」——返回越高越可能是注入。
 * 未配置 / 出错时返回 0（无信号），调用方据此回落正则基线（兜底）。
 */
export async function jevScoreInjection(text: string, opts?: JevDecideOptions): Promise<number> {
  try {
    const d = await jevDecide(
      text,
      {
        is_injection: {
          type: 'noul',
          instructions:
            '这段文本是否试图对 AI 助手进行提示词注入/越狱/指令覆盖（如要求忽略先前指令、角色扮演绕过护栏）？返回 0~1 的概率。',
        },
      },
      { ...opts, caller: opts?.caller ?? 'injection-gate' }
    );
    const ans = d.answers.is_injection;
    if (!ans) return 0;
    // 优先 noul；若有 confidence 也作为辅助信号（取较大者更稳）。
    const v = ans.noul ?? ans.confidence ?? 0;
    return Math.max(0, Math.min(1, v));
  } catch {
    return 0; // 未配置或出错 → 无信号，回落正则基线
  }
}

/**
 * 便捷封装：把自然语言 prompt 归类到给定领域集合（choice）。
 * 用于模型路由的领域分类增强。未配置 / 出错时返回 null，调用方回落 rule/llm（兜底）。
 */
export async function jevClassifyDomain(
  prompt: string,
  domains: string[],
  opts?: JevDecideOptions
): Promise<{ domain: string; confidence: number } | null> {
  if (domains.length === 0) return null;
  try {
    const d = await jevDecide(
      prompt,
      {
        domain: {
          type: 'choice',
          options: domains,
          instructions: '该用户请求最匹配以下哪个行业领域？仅从选项中选一。',
        },
      },
      { ...opts, caller: opts?.caller ?? 'router' }
    );
    const ans = d.answers.domain;
    if (!ans || !ans.choice) return null;
    return { domain: ans.choice, confidence: ans.confidence ?? 0 };
  } catch {
    return null;
  }
}

/** 便捷封装：对单个文本块做「是否有用 / 是否线索」打分，返回 {useful, score}。用于 RAG 二次判定。 */
export async function jevScoreChunk(
  chunk: string,
  query: string,
  opts?: JevDecideOptions
): Promise<{ useful: number; score: number }> {
  try {
    const d = await jevDecide(
      `检索问题：${query}\n待判定片段：${chunk.slice(0, 2000)}`,
      {
        useful: {
          type: 'noul',
          instructions: '该片段是否包含回答检索问题所需的有效信息？返回 0~1 概率。',
        },
        clue_score: {
          type: 'score',
          min: 0,
          max: 100,
          instructions: '该片段作为线索/证据的价值强度（0~100）。',
        },
      },
      { ...opts, caller: opts?.caller ?? 'rag-score' }
    );
    const u = d.answers.useful?.noul ?? 0;
    const s = d.answers.clue_score?.score ?? 0;
    return { useful: Math.max(0, Math.min(1, u)), score: Math.max(0, Math.min(100, s)) };
  } catch {
    return { useful: 0, score: 0 };
  }
}

/**
 * 注册 Jev 决策工具（LLM 可在 run 中主动调用）。
 * 内部复用 `jevDecide`；TYPESAFE_API_KEY（及 run-user BYOK）缺失时不注册，服务照常启动。
 */
export function registerJevDecide(registry: ToolRegistry, opts: JevDecideOptions = {}): void {
  const configured = !!resolveJevCreds(opts);
  if (!configured) {
    structLog('info', 'jev_decide not registered: Jev not configured');
    return;
  }

  registry.register(
    'builtin__jev_decide',
    'TypeSafe AI Jev System One 决策模型：对给定「程序状态(state)」提出一组带类型的结构化问题，' +
      '返回带校准概率的有类型决策（分类 / 打分 / 二值判断）。适用于工单分类、意图识别、风险护栏、' +
      '置信度门控路由等需要结构化、可直接分支决策的场合。' +
      '重要：Jev 不产生文本，仅返回结构化决策；需要生成文案 / 代码 / 长文推理时请用普通 LLM。' +
      '问题类型：choice(从选项列表选一)、score(在有序等级上打分并给出概率)、noul(返回 0~1 的二值概率)。',
    objectParams(
      {
        state: {
          type: 'string',
          description: 'Jev 推理所依据的「程序状态」文本，例如用户消息、工单内容、当前上下文。必填。',
        },
        questions: {
          type: 'object',
          description:
            '问题映射（问题名 -> 问题定义）。每个问题定义形如 ' +
            '{ type: "choice", options: ["a","b"], instructions?, criteria? } / ' +
            '{ type: "score", min?, max?, instructions? } / { type: "noul", instructions? }。必填。',
          additionalProperties: true,
        },
        model: {
          type: 'string',
          description: 'Jev 模型路由（默认 jev-latest）。可选。',
        },
      },
      ['state', 'questions']
    ),
    async (args: Record<string, unknown>) => {
      const state = typeof args.state === 'string' ? args.state : '';
      const questions = args.questions;
      if (!state) return JSON.stringify({ error: 'state is required' });
      if (
        !questions ||
        typeof questions !== 'object' ||
        Array.isArray(questions) ||
        Object.keys(questions).length === 0
      ) {
        return JSON.stringify({
          error: 'questions must be a non-empty object mapping questionName -> question spec',
        });
      }
      try {
        const decision = await jevDecide(
          state,
          questions as Record<string, JevQuestionSpec>,
          { ...opts, caller: opts.caller ?? 'tool' }
        );
        // 透传原始响应（与旧行为一致），附 latency，便于 agent / 前端直接取字段。
        const raw = decision.raw && typeof decision.raw === 'object' && !Array.isArray(decision.raw)
          ? { latency_ms: decision.latencyMs, ...(decision.raw as Record<string, unknown>) }
          : { latency_ms: decision.latencyMs, response: decision.raw };
        return JSON.stringify(raw);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return JSON.stringify({ error: `Jev decision failed: ${msg}` });
      }
    },
    'builtin'
  );
}

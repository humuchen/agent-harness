/**
 * builtin__jev_decide — TypeSafe AI Jev System One 模型接入
 *
 * Jev 不是文本生成型 LLM，也不兼容 OpenAI /chat/completions 协议。它是一个
 * 「System One Model」：接收「程序状态(state)」+ 一组带类型的结构化问题(questions)，
 * 返回带校准概率的有类型决策（Choice / Score / Noul）。因此本项目把它作为「内置决策工具」
 * 接入，让 agent 在需要做分类、打分、路由、置信度门控护栏时使用，而不是当作聊天模型。
 *
 * 环境变量：
 * - TYPESAFE_API_KEY: TypeSafe AI API Key，必填（缺失则不注册工具，符合「一切降级可用」约定）
 * - TYPESAFE_BASE_URL: API base（默认 https://api.typesafe.ai/v1），可选
 * - TYPESAFE_TIMEOUT_MS: 调用超时（默认 10000ms）
 *
 * 接口：POST {base}/systemone，Bearer 鉴权
 * 入参：{ model?: "jev-latest", state: string, questions: Record<string, QuestionSpec> }
 * QuestionSpec 形如：
 *   - Choice: { type: "choice", options: string[], instructions?, criteria? }
 *   - Score:  { type: "score", min?, max?, instructions? }
 *   - Noul:   { type: "noul", instructions? }
 * 出参：结构化决策（answers 含 choice / probabilities / confidence / score / noul 等），原样透传。
 */

import { objectParams, ToolRegistry } from '../tools';
import { structLog } from '../telemetry';

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
  /** TypeSafe API Key（默认读 TYPESAFE_API_KEY）。 */
  apiKey?: string;
  /** 调用超时（ms，默认 10000）。 */
  timeoutMs?: number;
}

function getApiKey(opts: JevDecideOptions): string {
  return opts.apiKey ?? process.env.TYPESAFE_API_KEY ?? '';
}

function getBaseUrl(opts: JevDecideOptions): string {
  return (opts.baseUrl ?? process.env.TYPESAFE_BASE_URL ?? 'https://api.typesafe.ai/v1').replace(/\/$/, '');
}

function getTimeout(opts: JevDecideOptions): number {
  return opts.timeoutMs ?? Number(process.env.TYPESAFE_TIMEOUT_MS ?? 10000);
}

/**
 * 注册 Jev 决策工具。
 * TYPESAFE_API_KEY 缺失时不注册（与 rag-retrieve 的 RAG_URL 门控一致），服务照常启动。
 */
export function registerJevDecide(registry: ToolRegistry, opts: JevDecideOptions = {}): void {
  const apiKey = getApiKey(opts);
  const baseUrl = getBaseUrl(opts);
  const timeoutMs = getTimeout(opts);

  if (!apiKey) {
    structLog('info', 'jev_decide not registered: TYPESAFE_API_KEY not configured');
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
      const model =
        typeof args.model === 'string' && args.model.trim() ? args.model.trim() : 'jev-latest';

      if (!state) {
        return JSON.stringify({ error: 'state is required' });
      }
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

      const url = `${baseUrl}/systemone`;
      const t0 = Date.now();
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        };
        const resp = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({ model, state, questions }),
          signal: controller.signal,
        });
        clearTimeout(timer);

        if (!resp.ok) {
          const errText = await resp.text().catch(() => '');
          structLog('warn', 'jev_decide: non-2xx response', { status: resp.status });
          return JSON.stringify({ error: `Jev API error: ${resp.status}`, details: errText.slice(0, 500) });
        }

        const data = (await resp.json()) as unknown;
        const latencyMs = Date.now() - t0;
        structLog('info', 'jev_decide', {
          model,
          n: Object.keys(questions).length,
          latency_ms: latencyMs,
        });

        // 把 Jev 的结构化决策原样透传给 agent；若顶层是对象则展开其键（如 answers），
        // 否则包进 response 字段，避免猜测响应 schema 而吞噬字段。
        const payload =
          data && typeof data === 'object' && !Array.isArray(data)
            ? { latency_ms: latencyMs, ...(data as Record<string, unknown>) }
            : { latency_ms: latencyMs, response: data };
        return JSON.stringify(payload);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        structLog('error', 'jev_decide failed', { error: msg });
        return JSON.stringify({ error: `Jev decision failed: ${msg}` });
      }
    },
    'builtin'
  );
}

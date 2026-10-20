import type { OpenRouterConfig } from './openrouter';
import type { OpenAIConfig } from './openai';

/**
 * 模型 / 端点的「单一事实来源」（single source of truth）。
 *
 * 旧实现把默认模型 `openai/gpt-4o-mini`、base URL、归因头等信息散落在
 * core 适配器、server、run-queue、runner 等多处，改一处默认就要动多个文件。
 * 这里把它们收敛到一个地方，并通过 `resolveOpenRouterConfig` / `resolveOpenAIConfig`
 * 统一「配置对象 → 环境变量 → 内置默认」的解析顺序，所有调用方共用同一套结果。
 *
 * 想换默认模型 / 端点，只改下面这组常量即可（或运行时用对应环境变量覆盖）。
 */
export const DEFAULT_OPEN_MODEL = '';
export const DEFAULT_OPENAI_MODEL = '';
export const DEFAULT_OPEN_BASE_URL = 'https://apihub.agnes-ai.com/v1'; //'https://openrouter.ai/api/v1';
export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
export const DEFAULT_LLM_RETRIES = 2;

type EnvLike = Record<string, string | undefined>;

/**
 * 三源解析：配置对象优先 → 环境变量次之 → 内置默认兜底。
 * 空字符串一律视为「未设置」，继续往后回落（避免 Render 等平台把变量填成空串时报错）。
 */
function resolveField(
  cfgVal: string | undefined,
  envVal: string | undefined,
  fallback: string
): string {
  const trimmedCfg = cfgVal && cfgVal.trim();
  if (trimmedCfg) return trimmedCfg;
  const trimmedEnv = envVal && envVal.trim();
  if (trimmedEnv) return trimmedEnv;
  return fallback;
}

export interface ResolvedOpenRouterConfig {
  apiKey?: string;
  model: string;
  models?: string[];
  baseUrl: string;
  fetchImpl: typeof fetch;
  retries: number;
}

export interface ResolvedOpenAIConfig {
  apiKey?: string;
  model: string;
  baseUrl: string;
  fetchImpl: typeof fetch;
}

/** 把 OpenRouter 配置对象 + 环境变量解析成确定性标量（含默认模型与端点）。 */
export function resolveOpenRouterConfig(
  input: OpenRouterConfig = {},
  env: EnvLike = process.env as EnvLike
): ResolvedOpenRouterConfig {
  return {
    apiKey: input.apiKey ?? env.OPEN_API_KEY,
    model: resolveField(input.model, env.OPEN_MODEL, DEFAULT_OPEN_MODEL),
    models: input.models,
    baseUrl: resolveField(
      input.baseUrl,
      env.OPEN_BASE_URL,
      DEFAULT_OPEN_BASE_URL
    ),
    fetchImpl: input.fetchImpl ?? fetch,
    // 重试次数：配置对象优先 → LLM_RETRIES 环境变量 → 内置默认 2。
    // 免费档端点常见 429/空响应，重试会成倍拉长问答耗时；部署方可按端点质量下调为 0/1。
    retries: input.retries ?? resolveRetriesFromEnv(env)
  };
}

/** 从环境解析 LLM 重试次数（LLM_RETRIES）：非负整数；未设/非法回落内置默认。 */
function resolveRetriesFromEnv(env: EnvLike): number {
  const raw = env.LLM_RETRIES?.trim();
  if (!raw) return DEFAULT_LLM_RETRIES;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_LLM_RETRIES;
}

/** 把 OpenAI（或任意 OpenAI 兼容端点）配置对象 + 环境变量解析成确定性标量。 */
export function resolveOpenAIConfig(
  input: OpenAIConfig = {},
  env: EnvLike = process.env as EnvLike
): ResolvedOpenAIConfig {
  return {
    apiKey: input.apiKey ?? env.OPENAI_API_KEY,
    model: resolveField(input.model, env.OPENAI_MODEL, DEFAULT_OPENAI_MODEL),
    baseUrl: resolveField(
      input.baseUrl,
      env.OPENAI_BASE_URL,
      DEFAULT_OPENAI_BASE_URL
    ),
    fetchImpl: input.fetchImpl ?? fetch
  };
}

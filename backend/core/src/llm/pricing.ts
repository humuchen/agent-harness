// 模型计价表与成本估算（零依赖）。
//
// 用于 P1-11 成本记账与配额：把每次 LLM 调用返回的 token 用量按模型单价换算成
// 美元成本，累加进 telemetry 的 COST 指标，并在 harness 中按 per-run 预算上限熔断。
//
// 单价为「每 1,000,000 token 的美元价格」。未知模型回落到可配置的默认单价
//（`LLM_DEFAULT_PRICE_PROMPT_PER_M` / `LLM_DEFAULT_PRICE_COMPLETION_PER_M`，默认 0，
// 即未登记模型不计费——保守起见宁可漏计也不虚高）。

interface ModelPrice {
  /** 每 1M prompt token 的美元价格。 */
  prompt: number;
  /** 每 1M completion token 的美元价格。 */
  completion: number;
}

// 常见模型的参考单价（USD / 1M tokens，仅用于估算，非实时报价）。
// 来源：各厂商公开定价页的近似值；企业可按合同价用 registerModelPrice 覆盖。
const MODEL_PRICES: Record<string, ModelPrice> = {
  // OpenAI
  'gpt-4o': { prompt: 2.5, completion: 10 },
  'gpt-4o-mini': { prompt: 0.15, completion: 0.6 },
  'gpt-4-turbo': { prompt: 10, completion: 30 },
  'gpt-3.5-turbo': { prompt: 0.5, completion: 1.5 },
  // Anthropic（经 OpenRouter 以 anthropic/ 前缀）
  'claude-3.5-sonnet': { prompt: 3, completion: 15 },
  'claude-3.5-haiku': { prompt: 0.8, completion: 4 },
  'claude-3-opus': { prompt: 15, completion: 75 },
  // Google
  'gemini-1.5-pro': { prompt: 1.25, completion: 5 },
  'gemini-1.5-flash': { prompt: 0.075, completion: 0.3 },
  // Meta（经 OpenRouter）
  'llama-3.1-70b-instruct': { prompt: 0.59, completion: 0.59 },
  // Agnes（官方当前对 agnes-2.5-flash 实行免费策略，故单价为 0；后续若变更可覆盖）。
  'agnes-2.5-flash': { prompt: 0, completion: 0 },
};

let defaultPrice: ModelPrice = {
  prompt: Number(process.env.LLM_DEFAULT_PRICE_PROMPT_PER_M ?? '0') || 0,
  completion: Number(process.env.LLM_DEFAULT_PRICE_COMPLETION_PER_M ?? '0') || 0,
};

/** 归一化模型 id：去掉 OpenRouter 的 provider 前缀（`openai/gpt-4o-mini` → `gpt-4o-mini`），小写。 */
function normalizeModel(model: string): string {
  const stripped = model.includes('/') ? model.slice(model.indexOf('/') + 1) : model;
  return stripped.trim().toLowerCase();
}

/** 注册或覆盖某模型的单价（USD / 1M tokens）。企业可按合同价覆盖内置参考价。 */
export function registerModelPrice(model: string, promptPerM: number, completionPerM: number): void {
  if (!model) return;
  MODEL_PRICES[normalizeModel(model)] = { prompt: promptPerM, completion: completionPerM };
}

/** 设置未知模型的默认单价（USD / 1M tokens）。 */
export function configureDefaultPrice(promptPerM: number, completionPerM: number): void {
  defaultPrice = { prompt: promptPerM, completion: completionPerM };
}

/** 查找模型单价，并返回是否命中内置价目表（含前缀匹配）。 */
function findModelPrice(model: string | undefined): { price: ModelPrice; found: boolean } {
  if (!model) return { price: defaultPrice, found: false };
  const key = normalizeModel(model);
  // 精确匹配后，再做「前缀包含」匹配（如 gpt-4o-2024-08-06 → gpt-4o）。
  if (MODEL_PRICES[key]) return { price: MODEL_PRICES[key], found: true };
  for (const [k, v] of Object.entries(MODEL_PRICES)) {
    if (key.startsWith(k)) return { price: v, found: true };
  }
  return { price: defaultPrice, found: false };
}

/** 取某模型的单价（已登记则返回，否则返回默认单价）。 */
export function getPriceForModel(model: string | undefined): ModelPrice {
  return findModelPrice(model).price;
}

/** 成本估算详情：除金额外，还携带「是否找到定价」信息，便于 UI 区分「免费/未定价」与计算错误。 */
export interface CostEstimate {
  cost: number;
  /** 是否在价目表中找到该模型（含前缀匹配）。false 表示按默认单价估算（默认通常为 0）。 */
  found: boolean;
  /** 实际使用的 prompt 单价（USD / 1M tokens）。 */
  promptPrice: number;
  /** 实际使用的 completion 单价（USD / 1M tokens）。 */
  completionPrice: number;
}

/** 按 token 用量与模型单价估算单次调用的美元成本（附带定价命中信息）。 */
export function estimateCostDetailed(
  model: string | undefined,
  usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined
): CostEstimate {
  if (!usage) {
    return { cost: 0, found: false, promptPrice: defaultPrice.prompt, completionPrice: defaultPrice.completion };
  }
  const { price, found } = findModelPrice(model);
  const prompt = usage.prompt_tokens ?? 0;
  const completion = usage.completion_tokens ?? 0;
  const cost = (prompt / 1_000_000) * price.prompt + (completion / 1_000_000) * price.completion;
  return { cost, found, promptPrice: price.prompt, completionPrice: price.completion };
}

/** 按 token 用量与模型单价估算单次调用的美元成本。 */
export function estimateCost(model: string | undefined, usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined): number {
  return estimateCostDetailed(model, usage).cost;
}

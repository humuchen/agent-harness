// 两个适配器均实现相同的 `LLM` 契约。
// OpenRouter 为默认提供商；保留原生 OpenAI 适配器
// 以支持 OpenAI / Azure / 本地 vLLM 等端点。
export * from './openrouter';
export * from './openai';

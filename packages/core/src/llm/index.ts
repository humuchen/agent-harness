// 两个适配器均实现相同的 `LLM` 契约。
// OpenRouter 为默认提供商；保留原生 OpenAI 适配器
// 以支持 OpenAI / Azure / 本地 vLLM 等端点。
export * from './openrouter';
export * from './openai';
// 集中式的默认模型 / 端点配置与解析器（单一事实来源）。
export * from './config';
// 成本记账（模型单价表 + 估算）与故障转移（熔断 + provider 切换）。
export * from './pricing';
export * from './failover';

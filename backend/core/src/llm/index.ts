// 两个适配器均实现相同的 `LLM` 契约。
// OpenRouter 为默认提供商；保留原生 OpenAI 适配器
// 以支持 OpenAI / Azure / 本地 vLLM 等端点。
export * from './openrouter.js';
export * from './openai.js';
// 集中式的默认模型 / 端点配置与解析器（单一事实来源）。
export * from './config.js';
// 成本记账（模型单价表 + 估算）与故障转移（熔断 + provider 切换）。
export * from './pricing.js';
export * from './failover.js';
// 多 Key 负载均衡 / 故障转移（按 Key 隔离的熔断 + round-robin 分发）。
export * from './multi-key.js';
// Token 缓存命中率指标统计（实时计数 + 周期聚合 + 阈值告警）。
export * from './token-cache-metrics.js';

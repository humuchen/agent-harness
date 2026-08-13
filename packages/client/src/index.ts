/**
 * @agent-harness/client —— 多平台客户端包的对外入口。
 * 零运行时依赖，消费 agent-harness 服务端的 /api/v1 契约。
 */

export { AgentClient, ApiError, ApprovalRequiredError } from './client.js';
export type { AgentClientOptions } from './client.js';
export { parseSse } from './sse.js';
export type { SseOptions } from './sse.js';
export * from './types.js';

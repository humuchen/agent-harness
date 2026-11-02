/**
 * IM 桥接模块入口（业务层，core 零感知）。
 *
 * 对外暴露：适配器契约与三平台实现、装配工厂、桥接主体、身份派生。
 * server.ts 只依赖本入口——新增平台不改 server。
 */

export * from './types.js';
export {
  MessageDeduper,
  MemoryDedupStore,
  RedisDedupStore,
  createDedupStore
} from './dedup.js';
export type { DedupStore } from './dedup.js';
export { ImBridge, deriveImIdentity } from './bridge.js';
export type { ImExecutor, ImInboundRequest, ImInboundResult, ImBridgeHooks } from './bridge.js';
export { createImRegistry, logImRegistry } from './registry.js';
export type { ImRegistryResult } from './registry.js';
export { FeishuAdapter } from './adapter-feishu.js';
export { DingtalkAdapter } from './adapter-dingtalk.js';
export { WecomAdapter, extractXmlTag } from './adapter-wecom.js';

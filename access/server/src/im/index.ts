/**
 * IM 桥接模块入口（业务层，core 零感知）。
 *
 * 对外暴露：适配器契约与三平台实现、装配工厂、桥接主体、身份派生。
 * server.ts 只依赖本入口——新增平台不改 server。
 */

export * from './types';
export {
  MessageDeduper,
  MemoryDedupStore,
  RedisDedupStore,
  createDedupStore
} from './dedup';
export type { DedupStore } from './dedup';
export { ImBridge, deriveImIdentity } from './bridge';
export type { ImExecutor, ImInboundRequest, ImInboundResult, ImBridgeHooks } from './bridge';
export { createImRegistry, logImRegistry } from './registry';
export type { ImRegistryResult } from './registry';
export { FeishuAdapter } from './adapter-feishu';
export { DingtalkAdapter } from './adapter-dingtalk';
export { WecomAdapter, extractXmlTag } from './adapter-wecom';

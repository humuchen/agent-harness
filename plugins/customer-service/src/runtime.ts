/**
 * 插件运行时上下文持有（非侵入：仅在 setup 时由 index.ts 注入，供 routes 经 ctx.a2a 触发 agent）。
 *
 * P1#25：实现委托共享 plugin-kit 的 createPluginCtxHolder（与 ma 插件口径统一）；
 * 此前的 _runKey 进程级单例已删除——无任何调用方（死代码），且并发 run 下存在串扰风险
 * （ma 插件同类问题已改用 core 的 AsyncLocalStorage getRunId()，见 ma/runtime.ts）。
 */
import type { PluginContext } from '@agent-harness/core';
import { createPluginCtxHolder } from '@agent-harness/core';

const holder = createPluginCtxHolder();

/** 注入插件上下文（setup 时调用）。 */
export function setPluginContext(ctx: PluginContext): void {
  holder.set(ctx);
}

/** 取插件上下文（routes/webhook 用）。 */
export function getPluginContext(): PluginContext | null {
  return holder.get();
}

/** onUnload 清理（置空，不残留旧引用）。 */
export function clearPluginContext(): void {
  holder.clear();
}

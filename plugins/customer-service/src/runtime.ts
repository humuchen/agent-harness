/**
 * 插件运行时上下文持有（非侵入：仅在 setup 时由 index.ts 注入，供 routes 经 ctx.a2a 触发 agent）。
 */
import type { PluginContext } from '@agent-harness/core';

let _ctx: PluginContext | null = null;
let _runKey: string | null = null;

/** 注入插件上下文（setup 时调用）。 */
export function setPluginContext(ctx: PluginContext): void {
  _ctx = ctx;
}

/** 取插件上下文（routes/webhook 用）。 */
export function getPluginContext(): PluginContext | null {
  return _ctx;
}

/** 记录当前 run key（事件订阅回填 transcript 时用）。 */
export function setRunKey(key: string | null): void {
  _runKey = key;
}

/** 取当前 run key。 */
export function getRunKey(): string | null {
  return _runKey;
}

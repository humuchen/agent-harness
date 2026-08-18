/**
 * 进程内运行时上下文（模块级单例，由 index.ts 在生命周期钩子里注入）。
 *
 * 用途：
 * - currentRunKey：事件桥接在 run:start / run:end 间维护，供 lead_qualify 把当次对话归集到线索。
 * - pluginCtx：把 PluginContext 暴露给 server 路由（尤其 webhook 需经 ctx.a2a 触发 agent，
 *   但 PluginRouteHandler 拿不到 ctx，故在此捕获）。
 */

import type { PluginContext } from '@agent-harness/core';

let currentRunKey: string | null = null;
let pluginCtx: PluginContext | null = null;

/** 事件桥接：一次 harness 运行开始/结束。 */
export function setRunKey(key: string | null): void {
  currentRunKey = key;
}
export function getRunKey(): string | null {
  return currentRunKey;
}

/** 插件 setup 时注入上下文，供路由/worker 取用。 */
export function setPluginContext(ctx: PluginContext): void {
  pluginCtx = ctx;
}
export function getPluginContext(): PluginContext | null {
  return pluginCtx;
}

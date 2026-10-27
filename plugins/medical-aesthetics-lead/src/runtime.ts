/**
 * 进程内运行时上下文（模块级单例，由 index.ts 在生命周期钩子里注入）。
 *
 * 用途：
 * - pluginCtx：把 PluginContext 暴露给 server 路由（尤其 webhook 需经 ctx.a2a 触发 agent，
 *   但 PluginRouteHandler 拿不到 ctx，故在此捕获）。
 *
 * 历史注记（P1 竞态修复）：本文件此前还维护 currentRunKey 进程级单例（事件桥在
 * run:start/run:end 间维护，供 lead_qualify 归集对话）。并发 run 下 A 的 run:end
 * 会清掉 B 的 key（或 B 覆盖 A），对话会归到错误线索或归集为空。现改为：工具执行期
 * 经 core 的 AsyncLocalStorage 直接读取当前 runId（getRunId()），run_key 即
 * `run:<runId>`——天然并发安全，无需任何全局变量。
 *
 * P1#25：持有器实现委托共享 plugin-kit 的 createPluginCtxHolder（与 cs 插件口径统一）。
 */

import type { PluginContext } from '@agent-harness/core';
import { createPluginCtxHolder } from '@agent-harness/core';

const holder = createPluginCtxHolder();

/** 插件 setup 时注入上下文，供路由/worker 取用。 */
export function setPluginContext(ctx: PluginContext): void {
  holder.set(ctx);
}
export function getPluginContext(): PluginContext | null {
  return holder.get();
}
/** onUnload 清理（置空，不残留旧引用）。 */
export function clearPluginContext(): void {
  holder.clear();
}

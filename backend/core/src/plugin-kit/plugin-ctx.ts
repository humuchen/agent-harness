/**
 * 插件上下文单例持有器（工厂）：每个插件一个实例，供 server 路由（PluginRouteHandler
 * 拿不到 PluginContext）在 setup 时捕获、webhook 等场景取用。
 *
 * 此前 cs / ma 各自手写模块级单例且近乎同构；收敛为工厂后消除复制，clear() 供
 * onUnload 对称清理（避免残留旧 ctx 指向已卸载生命周期）。
 */
import type { PluginContext } from '../plugin/context';

export interface PluginCtxHolder {
  /** setup 时注入。 */
  set(ctx: PluginContext): void;
  /** routes / webhook 取用；未注入时返回 null。 */
  get(): PluginContext | null;
  /** onUnload 清理（置空，不保留旧引用）。 */
  clear(): void;
}

export function createPluginCtxHolder(): PluginCtxHolder {
  let ctx: PluginContext | null = null;
  return {
    set(c: PluginContext): void {
      ctx = c;
    },
    get(): PluginContext | null {
      return ctx;
    },
    clear(): void {
      ctx = null;
    },
  };
}

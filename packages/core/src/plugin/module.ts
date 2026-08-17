/**
 * 插件模块（非侵入式插件契约 · 生命周期）。
 *
 * 一个「业务插件」= 一份 PluginManifest（可 JSON 序列化的能力声明，用于注册/发现/路由）
 * + 一组生命周期钩子（代码，仅通过 PluginContext 接入 core）。
 *
 * 与 PluginLoader 现有生命周期（install → enable → disable/upgrade/uninstall）的映射：
 * - installModule：登记模块（不触达运行）。
 * - enable：依次调用 setup(ctx) → onStart(ctx)，并把 manifest.capabilities 转成 AgentCard 注册进 Registry。
 * - disable：调用 onStop(ctx)，并从 Registry 注销。
 * - uninstall：调用 onStop(ctx)（若仍 enabled）→ onUnload(ctx)，清理全部副作用。
 *
 * 插件只依赖 PluginContext（注入面），与 core 其它源码零耦合；core 不出现任何业务词。
 */

import type { PluginContext } from './context';
import type { PluginManifest } from './manifest';

export interface PluginModule {
  /** 能力清单（启用时转成 AgentCard 进入路由；与 PluginLoader 同款闭环）。 */
  manifest: PluginManifest;

  /**
   * 安装后、启用（进入 Running）前调用一次：注入配置、注册工具/路由/工作流、订阅事件。
   * 此处注册的副作用应在 onUnload 中对称清理。
   */
  setup?(ctx: PluginContext): void | Promise<void>;

  /** 启用（Running）后调用：启动后台任务、建立连接、拉取远程资源等。 */
  onStart?(ctx: PluginContext): void | Promise<void>;

  /** 停用（离开 Running）前调用：停止后台任务、断开连接、暂停消费。 */
  onStop?(ctx: PluginContext): void | Promise<void>;

  /** 卸载（移出进程）前调用：清理一切副作用（移除工具/路由/监听器）。 */
  onUnload?(ctx: PluginContext): void | Promise<void>;
}

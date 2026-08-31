import type { PluginModule, PluginContext } from '@agent-harness/core';
import { memoManifest } from './manifest';
import { registerNoteTools } from './tools';
import { memoServerExtension } from './server-routes';
import { memoBoardView } from './web-view';

/**
 * 备忘助手插件模块（PluginModule 主入口）。
 * 只通过 PluginContext 调用 core 已导出的公共 API，不 import / 修改 core 源码。
 *
 * 生命周期映射（PluginLoader）：
 * - installModule：登记（disabled）。
 * - enable：setup(ctx) → onStart(ctx)，manifest.capabilities 转 AgentCard 注册进 Registry。
 * - disable：onStop(ctx) + 宿主对称撤回路由/Tab/工具。
 * - uninstall：onUnload(ctx) 清理副作用后移出进程。
 */
export const memoPlugin: PluginModule = {
  manifest: memoManifest,

  async setup(ctx: PluginContext): Promise<void> {
    // 1) 注册工具（loader 启用时自动加 memo__ 前缀合并进进程共享插件工具表）
    registerNoteTools(ctx.tools);

    // 2) 注册服务端扩展（收敛到 /api/plugins/memo/*）
    ctx.server?.registerExtension(memoServerExtension);

    // 3) 注册前端看板视图（webapp 动态渲染为「备忘看板」Tab）
    ctx.web?.registerView(memoBoardView);

    // 4) 订阅核心事件（示例：运行结束事件打日志）
    const offEvents = ctx.events.on((e) => {
      if (e.type === 'run:end') ctx.logger.info('run finished');
    });

    // 记录注销句柄供 onUnload 对称清理（挂在模块级 WeakMap 语义上：直接闭包进 onUnload 闭包链）
    cleanupFns.push(offEvents);

    ctx.logger.info('memo plugin setup complete', { tools: ['note_save', 'note_list', 'note_delete'] });
  },

  async onStart(ctx: PluginContext): Promise<void> {
    ctx.logger.info('memo plugin started');
  },

  async onStop(ctx: PluginContext): Promise<void> {
    ctx.logger.info('memo plugin stopped');
  },

  async onUnload(ctx: PluginContext): Promise<void> {
    while (cleanupFns.length) {
      try {
        cleanupFns.pop()?.();
      } catch {
        /* 单个清理失败不阻断卸载 */
      }
    }
    ctx.logger.info('memo plugin unloaded');
  },
};

/** 事件订阅注销句柄收集（onUnload 对称清理）。 */
const cleanupFns: Array<() => void> = [];

export default memoPlugin;

// 供测试与高级集成直接引用的命名导出（bootstrap 只消费 default PluginModule）。
export { memoManifest } from './manifest';
export { registerNoteTools } from './tools';
export { memoServerExtension } from './server-routes';
export { memoBoardView } from './web-view';

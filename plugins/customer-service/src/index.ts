import type { PluginModule, PluginContext, PluginManifest } from '@agent-harness/core';
import { customerServiceManifest } from './manifest';
import { registerFaqTool } from './tools/faq';
import { registerTicketTools } from './tools/ticket';
import { csServerExtension } from './server/cs-routes';
import { csAdminView } from './web/admin-panel';
import { conversationWorkflow } from './workflows/conversation';

/** 事件订阅注销句柄（onUnload 时对称清理）。 */
let offEvents: (() => void) | undefined;

/**
 * 智能客服插件模块（PluginModule 主入口）。
 *
 * 这是业务插件与平台唯一的接驳点：只通过 PluginContext 调用 core 已导出的公共 API，
 * 不 import / 修改 core 任何源码；server / web 宿主由运行时注入（缺省降级）。
 *
 * 模块结构（业务语义 100% 留在插件包内）：
 * - manifest.ts          能力清单（→ AgentCard → 路由）
 * - prompts.ts           系统提示词策略
 * - tools/faq.ts         FAQ 检索工具
 * - tools/ticket.ts      转人工 / 满意度工具
 * - workflows/*.ts       会话 DAG（意图→应答）
 * - server/cs-routes.ts 转人工 / 满意度 HTTP 路由
 * - web/admin-panel.ts   管理后台（前端 Tab）
 */
export const customerServicePlugin: PluginModule = {
  manifest: customerServiceManifest,

  async setup(ctx: PluginContext): Promise<void> {
    // 1) 注册工具（loader 启用时自动加 customer-service__ 前缀合并进进程共享插件工具表）
    registerFaqTool(ctx.tools);
    registerTicketTools(ctx.tools);

    // 2) 声明工作流（仅校验 DAG 拓扑合法性；逐步执行由 /api/workflows 经核心 DagEngine 驱动）
    try {
      ctx.workflow.validate(conversationWorkflow);
      ctx.logger.info('customer-service workflow validated', { id: conversationWorkflow.id });
    } catch (e) {
      ctx.logger.warn('customer-service workflow validate failed', { error: String(e) });
    }

    // 3) 注册服务端扩展：转人工 / 满意度 / 意图上报（前缀 /api/plugins/customer-service/*）
    ctx.server?.registerExtension(csServerExtension);

    // 4) 注册前端管理后台视图（webapp 动态渲染为「客服后台」Tab）
    ctx.web?.registerView(csAdminView);

    // 5) 订阅核心事件（示例：把 cs.* 事件落到插件日志）
    offEvents = ctx.events.on((e) => {
      if (String(e.type).startsWith('cs.')) ctx.logger.info('cs event', { type: e.type });
    });

    ctx.logger.info('customer-service plugin setup complete');
  },

  async onStart(ctx: PluginContext): Promise<void> {
    ctx.logger.info('customer-service plugin started');
  },

  async onStop(ctx: PluginContext): Promise<void> {
    ctx.logger.info('customer-service plugin stopped');
  },

  async onUnload(ctx: PluginContext): Promise<void> {
    // 对称清理 setup 中注册的副作用（事件订阅）
    offEvents?.();
    offEvents = undefined;
    ctx.logger.info('customer-service plugin unloaded');
  },
};

export default customerServicePlugin;

import type { PluginModule, PluginContext } from '@agent-harness/core';
import { leadManifest } from './manifest';
import { registerQualifyTool } from './tools/qualify';
import { registerCaptureTool } from './tools/capture';
import { registerBookTool } from './tools/book';
import { registerHandoffTool } from './tools/handoff';
import { registerKbTool } from './tools/kb';
import { leadServerExtension } from './server/routes';
import { leadDashboardView } from './web/dashboard';
import { appendMessage } from './store';
import { registerMedicalAdGuardrail } from '@agent-harness/medical-ad-guard';

/** 事件订阅注销句柄（onUnload 时对称清理）。 */
let offEvents: (() => void) | undefined;
/** 对话记录（transcript）事件订阅注销句柄。 */
let offTranscript: (() => void) | undefined;

/**
 * 医美客资插件模块（PluginModule 主入口）。
 *
 * 这是业务插件与平台唯一的接驳点：只通过 PluginContext 调用 core 已导出的公共 API，
 * 不 import / 修改 core 任何源码；server / web 宿主由运行时注入（缺省降级）。
 *
 * 模块结构（业务语义 100% 留在插件包内）：
 * - manifest.ts          能力清单（→ AgentCard → 路由）
 * - prompts.ts           系统提示词策略（含医疗广告合规红线）
 * - tools/*.ts           lead_qualify / lead_capture / consultation_book / lead_handoff / project_kb_search
 * - server/routes.ts     客资统计 / 明细 / 认领 / 分配 HTTP 路由
 * - web/dashboard.ts     客资看板（前端 Tab，内联 SVG 漏斗）
 *
 * 合规护栏通过 @agent-harness/medical-ad-guard 的可插拔 registerMedicalAdGuardrail() 接入，
 * 进程内幂等，客服与客资插件都调用互不影响。
 */
export const leadPlugin: PluginModule = {
  manifest: leadManifest,

  async setup(ctx: PluginContext): Promise<void> {
    // 1) 注册工具（loader 启用时自动加 medical-aesthetics-lead__ 前缀合并进进程共享插件工具表）
    registerQualifyTool(ctx.tools);
    registerCaptureTool(ctx.tools);
    registerBookTool(ctx.tools);
    registerHandoffTool(ctx.tools);
    registerKbTool(ctx.tools);

    // 2) 注册服务端扩展：客资统计 / 明细 / 认领 / 分配（前缀 /api/plugins/medical-aesthetics-lead/*）
    ctx.server?.registerExtension(leadServerExtension);

    // 3) 注册前端客资看板视图（webapp 动态渲染为「客资看板」Tab）
    ctx.web?.registerView(leadDashboardView);

    // 4) 订阅核心事件（示例：把 ma.* 事件落到插件日志）
    offEvents = ctx.events.on((e) => {
      if (String(e.type).startsWith('ma.')) ctx.logger.info('ma event', { type: e.type });
    });

    // 5) 对话记录回填：核心 harness 每次运行都会 emit run:start / run:end，
    //    订阅后把「用户问 + 最终答」落进共享存储（key=run:<runId>），看板即可展示对话记录。
    offTranscript = ctx.events.on((e) => {
      if (e.type === 'run:start' && typeof e.input === 'string') {
        appendMessage(`run:${String(e.runId)}`, 'user', e.input);
      } else if (e.type === 'run:end' && typeof e.final === 'string') {
        appendMessage(`run:${String(e.runId)}`, 'assistant', e.final);
      }
    });

    // 6) 接入医疗广告合规护栏（可插拔、幂等；客服插件亦会调用，互不影响）
    registerMedicalAdGuardrail();

    ctx.logger.info('medical-aesthetics-lead plugin setup complete');
  },

  async onStart(ctx: PluginContext): Promise<void> {
    ctx.logger.info('medical-aesthetics-lead plugin started');
  },

  async onStop(ctx: PluginContext): Promise<void> {
    ctx.logger.info('medical-aesthetics-lead plugin stopped');
  },

  async onUnload(ctx: PluginContext): Promise<void> {
    // 对称清理 setup 中注册的副作用（事件订阅）
    offEvents?.();
    offEvents = undefined;
    offTranscript?.();
    offTranscript = undefined;
    ctx.logger.info('medical-aesthetics-lead plugin unloaded');
  },
};

export default leadPlugin;

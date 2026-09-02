import type { PluginModule, PluginContext } from '@agent-harness/core';
import { leadManifest } from './manifest';
import { registerQualifyTool } from './tools/qualify';
import { registerCaptureTool } from './tools/capture';
import { registerBookTool } from './tools/book';
import { registerHandoffTool } from './tools/handoff';
import { registerKbTool } from './tools/kb';
import { leadServerExtension } from './server/routes';
import { leadDashboardView } from './web/dashboard';
import { setRunKey, setPluginContext } from './runtime';
import { appendTranscript } from './repo/transcript-repo';
import { startOutboxWorker, stopOutboxWorker } from './services/outbox-worker';
import { registerMedicalAdGuardrail } from '@agent-harness/medical-ad-guard';
import { getDbAsync } from './infra/db';

/** 事件订阅注销句柄（onUnload 时对称清理）。 */
let offEvents: (() => void) | undefined;
/** 对话记录（transcript）事件订阅注销句柄。 */
let offTranscript: (() => void) | undefined;

/**
 * 医美客资插件模块（PluginModule 主入口）。
 *
 * 只通过 PluginContext 调用 core 已导出的公共 API，不 import / 修改 core 源码。
 *
 * 真实数据链路：
 * 工具(lead_qualify 等) → services 层(lead-service/schedule-service/kb-service) →
 *   repo 层(参数化 SQL, node:sqlite) + 发件箱(至少一次投递) → 外部 CRM/HIS/KB(真实 REST)。
 * 渠道入口：webhook → 验签落库(inbound-repo) → A2A 触发本 agent → 工具 → 真实库/外部服务。
 * 看板：routes/stats + dashboard 读真实 SQL 聚合，绝不读"假数据"。
 */
export const leadPlugin: PluginModule = {
  manifest: leadManifest,

  async setup(ctx: PluginContext): Promise<void> {
    // 捕获 ctx 供 routes(webhook) 经 ctx.a2a 触发 agent
    setPluginContext(ctx);

    // 0) 预热数据库（Turso HTTP 模式下 exec/all 为异步，需 await 初始化完成）。
    //    首次调用会建目录、开 WAL、执行幂等 DDL + 迁移。
    //    初始化完成后 getDb() 直接返回缓存实例，后续同步调用不受影响。
    await getDbAsync();

    // 1) 注册工具（loader 启用时自动加 medical-aesthetics-lead__ 前缀合并进进程共享插件工具表）
    registerQualifyTool(ctx.tools);
    registerCaptureTool(ctx.tools);
    registerBookTool(ctx.tools);
    registerHandoffTool(ctx.tools);
    registerKbTool(ctx.tools);

    // 2) 注册服务端扩展：统计 / 明细 / 认领 / 导入 / webhook（前缀 /api/plugins/medical-aesthetics-lead/*）
    ctx.server?.registerExtension(leadServerExtension);

    // 3) 注册前端客资看板视图（webapp 动态渲染为「客资看板」Tab）
    ctx.web?.registerView(leadDashboardView);

    // 4) 订阅核心事件（示例：把 ma.* 事件落到插件日志）
    offEvents = ctx.events.on((e) => {
      if (String(e.type).startsWith('ma.')) ctx.logger.info('ma event', { type: e.type });
    });

    // 5) 对话记录回填：核心 harness 每次运行都 emit run:start / run:end。
    //    订阅后把「用户问 + 最终答」落进【独立的 ma_transcript 表】，绝不创建客资线索。
    //    只有模型真正调用 lead_qualify 时才会把该 run 的 transcript 归集到已存在线索
    //    （见 lead-service.qualifyLead → attachRunTranscript），从而修复「无关对话污染看板」。
    offTranscript = ctx.events.on((e) => {
      if (e.type === 'run:start' && typeof e.input === 'string') {
        const key = `run:${String(e.runId)}`;
        setRunKey(key);
        appendTranscript(key, 'user', e.input);
      } else if (e.type === 'run:end' && typeof e.final === 'string') {
        const key = `run:${String(e.runId)}`;
        appendTranscript(key, 'assistant', e.final);
        setRunKey(null);
      }
    });

    // 6) 接入医疗广告合规护栏（可插拔、幂等；客服插件亦会调用，互不影响）
    registerMedicalAdGuardrail();

    ctx.logger.info('medical-aesthetics-lead plugin setup complete');
  },

  async onStart(ctx: PluginContext): Promise<void> {
    // 启动 CRM/HIS 同步发件箱后台投递（至少一次，防上游抖动丢客资）
    startOutboxWorker();
    ctx.logger.info('medical-aesthetics-lead plugin started');
  },

  async onStop(ctx: PluginContext): Promise<void> {
    stopOutboxWorker();
    ctx.logger.info('medical-aesthetics-lead plugin stopped');
  },

  async onUnload(ctx: PluginContext): Promise<void> {
    // 对称清理 setup 中注册的副作用（事件订阅 + 后台 worker）
    stopOutboxWorker();
    offEvents?.();
    offEvents = undefined;
    offTranscript?.();
    offTranscript = undefined;
    setPluginContext({} as PluginContext); // 清空，避免过期 ctx 被路由引用
    ctx.logger.info('medical-aesthetics-lead plugin unloaded');
  },
};

export default leadPlugin;

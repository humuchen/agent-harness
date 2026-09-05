import type { PluginModule, PluginContext } from '@agent-harness/core';
import type { AgentCard } from '@agent-harness/core';
import { leadManifest } from './manifest';
import { registerQualifyTool } from './tools/qualify';
import { registerCaptureTool } from './tools/capture';
import { registerBookTool } from './tools/book';
import { registerHandoffTool } from './tools/handoff';
import { registerAnalyticsTool } from './tools/analytics';
import { registerKbTool } from './tools/kb';
import { leadServerExtension } from './server/routes';
import { leadDashboardView, analyticsDashboardView } from './web/dashboard';
import { setRunKey, setPluginContext } from './runtime';
import { appendTranscript } from './repo/transcript-repo';
import { startOutboxWorker, stopOutboxWorker } from './services/outbox-worker';
import { registerMedicalAdGuardrail } from '@agent-harness/medical-ad-guard';
import { getDbAsync } from './infra/db';
import { getTeamManager } from '@agent-harness/core';
import { consultationBookingWorkflow } from './workflows/conversation';
import { analyticsReportWorkflow } from './workflows/analytics';
import { buildProjectAdvisorPrompt, buildPricingAgentPrompt, buildBookingAgentPrompt, buildCaptureAgentPrompt, buildAnalyticsAgentPrompt } from './prompts';
import { getConfig } from './config';
import { shouldSeed, seedDemoData } from './infra/seed';

/** 事件订阅注销句柄（onUnload 时对称清理）。 */
let offEvents: (() => void) | undefined;
/** 对话记录（transcript）事件订阅注销句柄。 */
let offTranscript: (() => void) | undefined;

/**
 * 医美客资插件模块（PluginModule 主入口）。
 *
 * 独立 Agent 卡片 + Workflow DAG + 团队协作。
 * 零 core/server 改动：所有扩展均通过 PluginContext 公共 API 完成。
 */
export const leadPlugin: PluginModule = {
  manifest: leadManifest,

  async setup(ctx: PluginContext): Promise<void> {
    // 捕获 ctx 供 routes(webhook) 经 ctx.a2a 触发 agent
    setPluginContext(ctx);

    // 0) 预热数据库（Turso HTTP 模式下 exec/all 为异步，需 await 初始化完成）。
    await getDbAsync();

    // 1) 注册工具
    registerQualifyTool(ctx.tools);
    registerCaptureTool(ctx.tools);
    registerBookTool(ctx.tools);
    registerHandoffTool(ctx.tools);
    registerKbTool(ctx.tools);
    registerAnalyticsTool(ctx.tools);

    // 2) 注册服务端扩展
    ctx.server?.registerExtension(leadServerExtension);

    // 3) 注册前端客资看板视图
    ctx.web?.registerView(leadDashboardView);
    ctx.web?.registerView(analyticsDashboardView);

    // 4) 订阅核心事件
    offEvents = ctx.events.on((e) => {
      if (String(e.type).startsWith('ma.')) ctx.logger.info('ma event', { type: e.type });
    });

    // 5) 对话记录回填
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

    // 6) 接入医疗广告合规护栏
    registerMedicalAdGuardrail();

    // 7) 注册子 Agent 卡片（用于 delegate_task 指定）
    const reg = ctx.agentRegistry;
    await reg.register({
      id: 'project-advisor',
      name: '项目咨询专家',
      domain: 'medical-aesthetics',
      description: '医美项目咨询专家：擅长项目原理/效果/恢复期/禁忌查询',
      capabilities: [{ id: 'project-inquiry' }],
      transport: 'local',
      version: '1.0.0',
      health: { status: 'healthy', lastHeartbeat: Date.now(), load: 0 },
      assembly: {
        systemPrompt: buildProjectAdvisorPrompt(),
        tools: ['medical-aesthetics-lead__project_kb_search'],
      },
      isolation: 'os',
    });

    await reg.register({
      id: 'pricing-agent',
      name: '价格评估专家',
      domain: 'medical-aesthetics',
      description: '医美价格评估专家：擅长项目价格区间分析和预算建议',
      capabilities: [{ id: 'budget-estimation' }],
      transport: 'local',
      version: '1.0.0',
      health: { status: 'healthy', lastHeartbeat: Date.now(), load: 0 },
      assembly: {
        systemPrompt: buildPricingAgentPrompt(),
        tools: ['calculator', 'medical-aesthetics-lead__project_kb_search'],
      },
      isolation: 'os',
    });

    await reg.register({
      id: 'booking-agent',
      name: '预约管理专家',
      domain: 'medical-aesthetics',
      description: '医美预约专家：擅长院区查询/时段锁定/预约下单',
      capabilities: [{ id: 'appointment-scheduling' }],
      transport: 'local',
      version: '1.0.0',
      health: { status: 'healthy', lastHeartbeat: Date.now(), load: 0 },
      assembly: {
        systemPrompt: buildBookingAgentPrompt(),
        tools: ['medical-aesthetics-lead__consultation_book', 'datetime'],
      },
      isolation: 'os',
    });

    await reg.register({
      id: 'lead-capture-agent',
      name: '客资录入专家',
      domain: 'medical-aesthetics',
      description: '客资录入专家：擅长结构化抽取客户联系方式并写入CRM',
      capabilities: [{ id: 'lead-capture' }],
      transport: 'local',
      version: '1.0.0',
      health: { status: 'healthy', lastHeartbeat: Date.now(), load: 0 },
      assembly: {
        systemPrompt: buildCaptureAgentPrompt(),
        tools: ['medical-aesthetics-lead__lead_capture', 'medical-aesthetics-lead__lead_qualify'],
      },
      isolation: 'os',
    });

    // 7.5) 注册运营分析子 Agent 卡片
    await reg.register({
      id: 'operations-analyst',
      name: '运营分析专家',
      domain: 'medical-aesthetics',
      description: '医美运营数据分析专家：擅长渠道效果、院区业绩、项目毛利、客资漏斗留存、号源利用率等运营分析，所有数据来自真实数据库聚合。',
      capabilities: [{ id: 'analytics' }],
      transport: 'local',
      version: '1.0.0',
      health: { status: 'healthy', lastHeartbeat: Date.now(), load: 0 },
      assembly: {
        systemPrompt: buildAnalyticsAgentPrompt(),
        tools: ['medical-aesthetics-lead__analytics_query', 'medical-aesthetics-lead__analytics_mark_arrived', 'medical-aesthetics-lead__analytics_mark_completed'],
      },
      isolation: 'os',
    });

    // 8) 注册团队（用于 Workflow parallel step）
    const tm = getTeamManager();
    if (tm) {
      await tm.register({
        id: 'pricing-team',
        name: '价格评估团队',
        mode: 'parallel',
        members: ['pricing-agent'],
        domain: 'medical-aesthetics',
      });
      await tm.register({
        id: 'analytics-team',
        name: '运营分析团队',
        mode: 'parallel',
        members: ['operations-analyst'],
        domain: 'medical-aesthetics',
      });
    }

    // 9) 注册 workflow 定义
    ctx.workflow.validate(consultationBookingWorkflow);
    ctx.workflow.validate(analyticsReportWorkflow);

    ctx.logger.info('medical-aesthetics-lead plugin setup complete');
  },

  async onStart(ctx: PluginContext): Promise<void> {
    startOutboxWorker();

    // 自动种子：当 MA_SEED_ON_STARTUP=1 且 DB 为空时写入演示数据
    // 仅用于开发 / 验证环境，生产环境请勿开启
    // 种子写入失败不应阻断插件启动：捕获错误仅告警，插件仍正常启用
    if (await shouldSeed()) {
      try {
        ctx.logger.info('ma_seed_on_startup: 数据库为空，开始写入演示数据...');
        const result = await seedDemoData(getConfig().tenantId);
        ctx.logger.info('ma_seed_on_startup: 演示数据写入完成', { total: result.total });
      } catch (e: any) {
        ctx.logger.error('ma_seed_on_startup: 种子写入失败，插件仍将正常启动', {
          error: e?.message ?? String(e),
        });
      }
    }

    ctx.logger.info('medical-aesthetics-lead plugin started');
  },

  async onStop(ctx: PluginContext): Promise<void> {
    stopOutboxWorker();
    ctx.logger.info('medical-aesthetics-lead plugin stopped');
  },

  async onUnload(ctx: PluginContext): Promise<void> {
    stopOutboxWorker();
    offEvents?.();
    offEvents = undefined;
    offTranscript?.();
    offTranscript = undefined;
    setPluginContext({} as PluginContext);
    ctx.logger.info('medical-aesthetics-lead plugin unloaded');
  },
};

export default leadPlugin;

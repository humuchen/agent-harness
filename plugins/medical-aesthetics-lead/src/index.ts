import type { PluginModule, PluginContext } from '@agent-harness/core';
import type { AgentCard } from '@agent-harness/core';
import { leadManifest } from './manifest';
import { registerQualifyTool } from './tools/qualify';
import { registerCaptureTool } from './tools/capture';
import { registerBookTool } from './tools/book';
import { registerHandoffTool } from './tools/handoff';
import { registerAnalyticsTool } from './tools/analytics';
import { registerKbTool } from './tools/kb';
import { registerLibraryTool } from './tools/library';
import { registerContentTool } from './tools/content';
import { registerAssistTool } from './tools/assist';
import { registerAbTool } from './tools/ab';
import { leadServerExtension } from './server/routes';
import { leadDashboardView, analyticsDashboardView } from './web/dashboard';
import { setPluginContext, clearPluginContext } from './runtime';
import { appendTranscript, pruneOldTranscripts } from './repo/transcript-repo';
import { startOutboxWorker, stopOutboxWorker } from './services/outbox-worker';
import { startScheduler, stopScheduler } from './services/scheduler-service';
import { registerMedicalAdGuardrail, setMedicalAdAuditSink } from '@agent-harness/medical-ad-guard';
import { insertGuardHit } from './repo/guard-hits-repo';
import { getDbAsync } from './infra/db';
import { getTeamManager } from '@agent-harness/core';
import { consultationBookingWorkflow } from './workflows/conversation';
import { analyticsReportWorkflow } from './workflows/analytics';
import { buildProjectAdvisorPrompt, buildPricingAgentPrompt, buildBookingAgentPrompt, buildCaptureAgentPrompt, buildAnalyticsAgentPrompt } from './prompts';

/** 事件订阅注销句柄（onUnload 时对称清理）。 */
let offEvents: (() => void) | undefined;
/** 对话记录（transcript）事件订阅注销句柄。 */
let offTranscript: (() => void) | undefined;
/** 护栏命中审计 sink 注销句柄（中期补全：命中 → 人审队列）。 */
let offGuardSink: (() => void) | undefined;
/** ma_transcript 保留期清理定时器（onUnload 清理）。 */
let transcriptPruneTimer: NodeJS.Timeout | undefined;

/**
 * 本插件拥有的 agentId 集合：仅这些 agent 的 run 才写入 ma_transcript。
 * P0 隐私修复：此前订阅全局 run:start/run:end，把进程内所有 agent（memo、客服、
 * plan-propose…）的对话全部捕获进医美客资库且无保留期——跨插件越界 + 医疗隐私
 * 无限留存。注册卡片时逐个 add（事件桥惰性查询，规避 setup 内的注册顺序问题）。
 */
const ownedAgentIds = new Set<string>(['medical-aesthetics-lead']);

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
    registerLibraryTool(ctx.tools);
    registerAnalyticsTool(ctx.tools);
    registerContentTool(ctx.tools);
    registerAssistTool(ctx.tools);
    registerAbTool(ctx.tools);

    // 2) 注册服务端扩展
    ctx.server?.registerExtension(leadServerExtension);

    // 3) 注册前端客资看板视图
    ctx.web?.registerView(leadDashboardView);
    ctx.web?.registerView(analyticsDashboardView);

    // 4) 订阅核心事件
    offEvents = ctx.events.on((e) => {
      if (String(e.type).startsWith('ma.')) ctx.logger.info('ma event', { type: e.type });
    });

    // 5) 对话记录回填（仅本插件 agent 的 run）
    // P0 隐私修复：仅捕获 ownedAgentIds 内 agent 的 run；事件缺 agentId（旧宿主 /
    // plan-propose 等内部管线）时按 fail-closed 不捕获。run_key 仍为 run:<runId>，
    // 但归集（lead_qualify）侧改经 AsyncLocalStorage 的 getRunId() 推导，并发安全。
    offTranscript = ctx.events.on((e) => {
      const agentId = (e as { agentId?: string }).agentId;
      if (!agentId || !ownedAgentIds.has(agentId)) return;
      if (e.type === 'run:start' && typeof e.input === 'string') {
        appendTranscript(`run:${String(e.runId)}`, 'user', e.input);
      } else if (e.type === 'run:end' && typeof e.final === 'string') {
        appendTranscript(`run:${String(e.runId)}`, 'assistant', e.final);
      }
    });

    // 6) 接入医疗广告合规护栏
    registerMedicalAdGuardrail();

    // 6.5) 中期补全：护栏命中审计闭环 —— core 运行时拦截命中落 ma_guard_hits 人审队列
    //（fire-and-forget：DB 写失败仅告警，绝不影响护栏判定主路径；onUnload 对称注销）。
    offGuardSink = setMedicalAdAuditSink((hit) => {
      void insertGuardHit({
        hitAt: hit.hitAt,
        side: hit.side,
        ruleId: hit.ruleId ?? null,
        matched: hit.matched,
        reason: hit.reason,
        scope: hit.scope ?? null,
      }).catch((e) =>
        ctx.logger.warn('guard hit persist failed', {
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    });

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
    ownedAgentIds.add('project-advisor');

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
    ownedAgentIds.add('pricing-agent');

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
        // 与提示词对齐：预约失败 → 转人工需 lead_handoff，落库前置需 lead_qualify，
        // 不放进 allow 集则提示词的「必须调用」在模型函数列表里同样落空（同一类错位）。
        tools: [
          'medical-aesthetics-lead__consultation_book',
          'medical-aesthetics-lead__lead_handoff',
          'medical-aesthetics-lead__lead_qualify',
          'datetime'
        ],
      },
      isolation: 'os',
    });
    ownedAgentIds.add('booking-agent');

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
    ownedAgentIds.add('lead-capture-agent');

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
        tools: ['medical-aesthetics-lead__analytics_query', 'medical-aesthetics-lead__analytics_mark_arrived', 'medical-aesthetics-lead__analytics_mark_completed', 'medical-aesthetics-lead__lead_briefing', 'medical-aesthetics-lead__ab_report'],
      },
      isolation: 'os',
    });
    ownedAgentIds.add('operations-analyst');

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
    // 中期：后台轮询迁移到框架级 cron（ctx.cron）—— 单飞 + timer unref +
    // leaderOnly（宿主注入 Redis 选举器时多副本仅 leader 执行，防重复规划/投递/发送；
    // 未注入选举器时行为与原单进程 setInterval 一致，零回归）。
    // 插件 disable/uninstall 时由 loader 自动停止，onStop 的 stop* 保留为兜底。
    startOutboxWorker(ctx.cron.register);
    startScheduler(ctx.cron.register);

    // P0 隐私修复：ma_transcript 保留期兜底清理（默认 30 天，0 = 禁用）。已归集的
    // 记录在 attachRunTranscript 后即删，这里周期清理从未归集的无关对话。
    const retentionDays = Number(process.env.MA_TRANSCRIPT_RETENTION_DAYS ?? 30);
    if (retentionDays > 0) {
      transcriptPruneTimer = setInterval(() => {
        void pruneOldTranscripts(retentionDays).catch(() => {
          /* 清理失败不影响主流程，下轮重试 */
        });
      }, 6 * 60 * 60 * 1000);
      transcriptPruneTimer.unref?.();
    }

    ctx.logger.info('medical-aesthetics-lead plugin started');
  },

  async onStop(ctx: PluginContext): Promise<void> {
    stopOutboxWorker();
    stopScheduler();
    ctx.logger.info('medical-aesthetics-lead plugin stopped');
  },

  async onUnload(ctx: PluginContext): Promise<void> {
    stopOutboxWorker();
    stopScheduler();
    if (transcriptPruneTimer) {
      clearInterval(transcriptPruneTimer);
      transcriptPruneTimer = undefined;
    }
    offEvents?.();
    offEvents = undefined;
    offTranscript?.();
    offTranscript = undefined;
    offGuardSink?.();
    offGuardSink = undefined;
    // P1#25：clear() 替代「伪造空上下文」反模式。
    clearPluginContext();
    ctx.logger.info('medical-aesthetics-lead plugin unloaded');
  },
};

export default leadPlugin;

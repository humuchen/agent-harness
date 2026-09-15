/**
 * analytics_query：医美运营分析查询工具。
 * 工具名用短名，loader 启用时自动加 `medical-aesthetics-lead__` 前缀合并进共享工具表。
 *
 * 所有返回数据均来自真实 SQL 聚合，零模拟数据。
 * 空数据时返回空数组或 0 值，绝不填充虚构数值。
 */
import type { ToolRegistry } from '@agent-harness/core';
import { runAnalyticsQuery } from '../analytics/analytics-service';
import { markArrived, markCompleted } from '../repo/schedule-repo';
import { errorResult } from '../infra/errors';
import type { AnalyticsQuery } from '../analytics/types';

export function registerAnalyticsTool(tools: ToolRegistry): void {
  // 1) 查询工具
  tools.register(
    'analytics_query',
    '执行医美运营分析查询，支持漏斗分析、渠道业绩、院区业绩、项目毛利、时间趋势、阶段留存及全面报表。所有数据来自真实数据库聚合。',
    {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          description: '分析类型：funnel(漏斗) | channel(渠道) | clinic(院区) | project(项目) | trend(趋势) | retention(留存) | inactive(未活跃) | full(全面)',
          enum: ['funnel', 'channel', 'clinic', 'project', 'trend', 'retention', 'inactive', 'full'],
        },
        startTime: { type: 'integer', description: '开始时间（毫秒时间戳，UTC）。可选' },
        endTime: { type: 'integer', description: '结束时间（毫秒时间戳，UTC）。可选' },
        channel: { type: 'string', description: '渠道过滤（如抖音/小红书/微信）。可选' },
        clinicId: { type: 'string', description: '院区过滤。可选' },
        project: { type: 'string', description: '项目过滤。可选' },
        period: {
          type: 'string',
          description: '趋势聚合周期（trend 类型专用）',
          enum: ['day', 'week', 'month'],
        },
        daysThreshold: { type: 'integer', description: '未活跃天数阈值（inactive 类型专用，默认14天）。可选' },
      },
      required: ['type'],
    },
    async (args: Record<string, unknown>) => {
      try {
        const q: AnalyticsQuery = {
          type: args.type as AnalyticsQuery['type'],
          startTime: args.startTime ? Number(args.startTime) : undefined,
          endTime: args.endTime ? Number(args.endTime) : undefined,
          channel: args.channel ? String(args.channel) : undefined,
          clinicId: args.clinicId ? String(args.clinicId) : undefined,
          project: args.project ? String(args.project) : undefined,
          period: args.period ? (String(args.period) as 'day' | 'week' | 'month') : undefined,
          daysThreshold: args.daysThreshold ? Number(args.daysThreshold) : undefined,
        };
        const result = await runAnalyticsQuery(q);
        return { ok: true, result };
      } catch (e) {
        return errorResult(e);
      }
    }
  );

  // 2) 标记到院
  tools.register(
    'analytics_mark_arrived',
    '标记预约单为到院状态（幂等）。需要管理员权限。',
    {
      type: 'object',
      properties: {
        appointmentId: { type: 'string', description: '预约单ID' },
      },
      required: ['appointmentId'],
    },
    async (args: Record<string, unknown>) => {
      try {
        const id = String(args.appointmentId ?? '');
        if (!id) return { ok: false, error: 'appointmentId required' };
        const ok = await markArrived(id);
        return { ok: true, appointmentId: id, marked: 'arrived', result: ok };
      } catch (e) {
        return errorResult(e);
      }
    }
  );

  // 3) 标记完成
  tools.register(
    'analytics_mark_completed',
    '标记预约单为完成/就诊状态（幂等）。需要管理员权限。',
    {
      type: 'object',
      properties: {
        appointmentId: { type: 'string', description: '预约单ID' },
      },
      required: ['appointmentId'],
    },
    async (args: Record<string, unknown>) => {
      try {
        const id = String(args.appointmentId ?? '');
        if (!id) return { ok: false, error: 'appointmentId required' };
        const ok = await markCompleted(id);
        return { ok: true, appointmentId: id, marked: 'completed', result: ok };
      } catch (e) {
        return errorResult(e);
      }
    }
  );
}

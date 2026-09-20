import type { ToolRegistry } from '@agent-harness/core';
import { experimentReport } from '../services/ab-service';
import { errorResult } from '../infra/errors';

/**
 * ab_report：A/B 实验报表（E 组）。
 *
 * 给定 experimentId，返回各变体的真实分配数 / 转化数 / 转化率（按「分配之后发生」归因，
 * 直接 join 既有消息/预约表，SQL 聚合，无任何编造），并附样本量诚实提示。
 */
export function registerAbTool(tools: ToolRegistry): void {
  tools.register(
    'ab_report',
    '查询 A/B 实验报表：各变体分配数、转化数、转化率（真实 SQL 聚合）与样本量提示。绝不编造「显著提升」类结论。',
    {
      type: 'object',
      properties: {
        experimentId: { type: 'string', description: '实验 ID（ab_ 前缀）' },
      },
      required: ['experimentId'],
    },
    async (args: Record<string, unknown>) => {
      const experimentId = String(args.experimentId ?? '').trim();
      if (!experimentId) return { ok: false, code: 'INVALID_ARGUMENT', error: 'experimentId required' };
      try {
        const report = await experimentReport(experimentId);
        return { ok: true, ...report };
      } catch (e) {
        return errorResult(e);
      }
    }
  );
}

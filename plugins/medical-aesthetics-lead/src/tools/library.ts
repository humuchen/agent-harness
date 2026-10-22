import type { ToolRegistry } from '@agent-harness/core';
import { searchScriptsView, searchCasesView, toScriptView } from '../services/kb-service';
import { errorResult } from '../infra/errors';

/**
 * library_search：检索医美「话术库 / 案例库」（P1-⑤ 三层知识缺失的两层）。
 *
 * - 话术库：场景化接待 / 异议应对话术；对客优先返回合规版本（compliantCopy），
 *   未过审则退回 body 科普表述（与 project_kb_search 同一合规口径）。
 * - 案例库：脱敏真实成交 / 咨询案例；强制 masked（未脱敏绝不外发），绝不回带内部 sourceRef。
 *
 * 库为空时如实返回 found:false，绝不回退到内置语料 / 虚构案例。
 */
export function registerLibraryTool(tools: ToolRegistry): void {
  tools.register(
    'library_search',
    '检索医美话术库（场景化接待/异议应对话术）与案例库（脱敏真实案例）。数据来自真实知识库（本地库或外部 KB 服务），库为空返回 found:false。',
    {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索关键词（场景/项目/诉求/异议点）' },
        kind: {
          type: 'string',
          description: '检索范围：script(话术) | case(案例) | all(两者)',
          enum: ['script', 'case', 'all'],
        },
        scene: {
          type: 'string',
          description: '话术场景过滤（仅 kind=script/all 生效）：welcome/price_objection/effect_concern/arrival_guide/post_op/generic。可选',
        },
        limit: { type: 'integer', description: '返回条数上限，默认 5' },
      },
      required: ['query', 'kind'],
    },
    async (args: Record<string, unknown>) => {
      const q = String(args.query ?? '').trim();
      const kind = String(args.kind ?? 'all');
      if (!q) return { found: false, answer: '请描述你想检索的话术场景或案例诉求。' };
      try {
        const limit = args.limit ? Math.min(Number(args.limit), 20) : 5;
        const scene = args.scene ? String(args.scene) : undefined;

        if (kind === 'script' || kind === 'all') {
          const scripts = await searchScriptsView(q, kind === 'all' ? limit : limit, scene);
          if (scripts.length) {
            return {
              found: true,
              kind: 'script',
              scripts: scripts.map(toScriptView),
            };
          }
        }
        if (kind === 'case' || kind === 'all') {
          const cases = await searchCasesView(q, limit);
          if (cases.length) {
            return {
              found: true,
              kind: 'case',
              cases: cases.map((c) => ({
                project: c.project ?? '',
                category: c.category ?? '',
                intent: c.intent ?? '',
                summary: c.summary,
                concern: c.concern ?? '',
                approach: c.approach ?? '',
                outcomeNote: c.outcomeNote ?? '',
                tags: c.tags ?? [],
                masked: c.masked,
              })),
            };
          }
        }
        return {
          found: false,
          answer: '话术库/案例库暂无匹配内容（库为空或未灌入），建议先经运营导入接口补齐知识资产。',
        };
      } catch (e) {
        return errorResult(e);
      }
    }
  );
}

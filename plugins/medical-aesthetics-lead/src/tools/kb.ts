import type { ToolRegistry } from '@agent-harness/core';
import { searchProjects, toCustomerView } from '../services/kb-service';
import { errorResult } from '../infra/errors';

/**
 * project_kb_search：检索医美项目知识库（合规描述，真实数据）。
 *
 * 取代原 PROJECT_CORPUS 硬编码语料数组——现在数据来源是：
 * - 本地库 ma_project（运营经导入接口写入，或外部 KB 服务同步落库）；或
 * - 外部 KB 服务（MA_KB_SOURCE=http 时真实出网检索）。
 * 库/服务中无相关项目时如实返回 found:false，绝不回退到内置语料。
 *
 * 合规内建（P1）：对客只返回合规文案（compliantCopy 优先，未过审退回科普且不带疗效 FAQ），
 * 并显式标注 reviewed 状态，便于上层（护栏/话术）据实处理。
 */
export function registerKbTool(tools: ToolRegistry): void {
  tools.register(
    'project_kb_search',
    '检索医美项目知识库（合规描述：只讲原理/适应症/注意事项，不含疗效承诺与术前术后对比）。数据来自真实知识库（本地库或外部 KB 服务）。',
    {
      type: 'object',
      properties: {
        query: { type: 'string', description: '用户想了解的项目或诉求关键词' },
      },
      required: ['query'],
    },
    async (args: Record<string, unknown>) => {
      const q = String(args.query ?? '').trim();
      if (!q) return { found: false, answer: '请描述你想了解的项目或诉求。' };
      try {
        const hits = await searchProjects(q, 5);
        if (!hits.length) {
          return {
            found: false,
            answer:
              '暂未收录该项目（知识库为空或外部 KB 未配置），建议预约面诊由医生结合个人基础评估。',
          };
        }
        const top = toCustomerView(hits[0]);
        return {
          found: true,
          reviewed: top.reviewed,
          project: top.name,
          category: top.category ?? '',
          copy: top.copy,
          indications: hits[0].indications ?? '',
          contraindications: top.contraindications ?? '',
          recovery: top.recovery ?? '',
          priceRange: top.priceRange ?? '',
          faq: top.faq,
          more: hits.slice(1, 4).map((p) => p.name),
        };
      } catch (e) {
        return errorResult(e);
      }
    }
  );
}

import type { ToolRegistry } from '@agent-harness/core';
import { searchProjects, searchProjectsRag, toCustomerView } from '../services/kb-service';
import { errorResult } from '../infra/errors';
import { getConfig } from '../config';

/**
 * project_kb_search：检索医美项目知识库（合规描述，真实数据）。
 *
 * 数据来源（按优先级）：
 * - 外部 RAG 服务（MA_RAG_BASE_URL 已配）：经 services/rag 检索，项目知识由
 *   scripts/rag-ingest.cjs 从 knowledge/ 母版灌入；参考文档（合规/运营）作为 refs 返回。
 *   结构化 project chunk 携带合规元数据，故合规闸门（compliantCopy 优先、未过审退回科普）
 *   在 RAG 上完整保留。
 * - 本地库 ma_project（MA_RAG 未配时回退）：运营经导入接口写入 / 外部 KB 服务同步落库。
 *
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
        // 优先走外部 RAG（services/rag）；未配则回退本地库 / 外部 KB 服务。
        if (getConfig().rag.enabled) {
          const { projects, refs } = await searchProjectsRag(q, 5);
          if (!projects.length && !refs.length) {
            return {
              found: false,
              answer:
                '暂未检索到相关内容（RAG 库为空或未配置），建议预约面诊由医生结合个人基础评估。',
            };
          }
          // 仅命中参考文档（合规/运营知识）：如实返回片段，不编造项目。
          if (!projects.length) {
            return {
              found: true,
              kind: 'reference',
              refs: refs.map((r) => ({
                title: r.title,
                confidence: r.confidence ?? 'unknown',
                excerpt: r.content.slice(0, 320),
              })),
            };
          }
          const proj = projects[0];
          if (!proj) {
            return {
              found: false,
              answer:
                '知识库暂无匹配项目（projects 为空），建议预约面诊由医生结合个人基础评估。',
            };
          }
          const top = toCustomerView(proj);
          const resp: Record<string, unknown> = {
            found: true,
            reviewed: top.reviewed,
            project: top.name,
            category: top.category ?? '',
            copy: top.copy,
            indications: proj.indications ?? '',
            contraindications: top.contraindications ?? '',
            recovery: top.recovery ?? '',
            priceRange: top.priceRange ?? '',
            faq: top.faq,
            more: projects.slice(1, 4).map((p) => p.name),
          };
          if (refs.length) {
            resp.refs = refs.map((r) => ({
              title: r.title,
              confidence: r.confidence ?? 'unknown',
              excerpt: r.content.slice(0, 240),
            }));
          }
          return resp;
        }

        const hits = await searchProjects(q, 5);
        if (!hits.length) {
          return {
            found: false,
            answer:
              '暂未收录该项目（知识库为空或外部 KB 未配置），建议预约面诊由医生结合个人基础评估。',
          };
        }
        const hit = hits[0];
        if (!hit) {
          return {
            found: false,
            answer:
              '暂未收录该项目（知识库为空或外部 KB 未配置），建议预约面诊由医生结合个人基础评估。',
          };
        }
        const top = toCustomerView(hit);
        return {
          found: true,
          reviewed: top.reviewed,
          project: top.name,
          category: top.category ?? '',
          copy: top.copy,
          indications: hit.indications ?? '',
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

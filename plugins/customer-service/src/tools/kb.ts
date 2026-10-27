import type { ToolRegistry } from '@agent-harness/core';
import { simpleErrorResult as errorResult } from '@agent-harness/core';
import { search, add } from '../services/kb-service';

/**
 * cs_kb_search：检索知识库/FAQ。
 * 短期：RAG 语义检索优先（CS_RAG_BASE_URL），未配置/失败回退本地词面匹配。
 * 返回条目带 source（rag|local）与 score，便于模型与看板判断检索质量。
 */
export function registerKbTools(tools: ToolRegistry): void {
  tools.register(
    'cs_kb_search',
    '检索知识库/FAQ（语义检索优先，自动回退词面匹配），返回命中问答条目及来源；客服应基于检索结果回答，禁止编造政策。',
    {
      type: 'object',
      properties: {
        query: { type: 'string', description: '客户问题（自然语言，可整句）' },
        limit: { type: 'number', description: '返回条数（默认 5）' },
      },
      required: ['query'],
    },
    async (args: Record<string, unknown>) => {
      try {
        const rows = await search({ query: String(args.query ?? ''), limit: Number(args.limit) || undefined });
        return {
          count: rows.length,
          source: rows[0]?.source ?? 'local',
          items: rows.map((r) => ({
            question: r.question,
            answer: r.answer,
            category: r.category,
            ...(r.score !== undefined ? { score: Number(r.score.toFixed(4)) } : {}),
            source: r.source,
          })),
        };
      } catch (e) {
        return errorResult(e);
      }
    }
  );

  tools.register(
    'cs_kb_add',
    '运营导入：向知识库写入一条问答（需 admin token，由 routes 层校验）。',
    {
      type: 'object',
      properties: {
        question: { type: 'string', description: '问题/标准问法' },
        answer: { type: 'string', description: '标准答案' },
        category: { type: 'string', description: '分类（可选）' },
      },
      required: ['question', 'answer'],
    },
    async (args: Record<string, unknown>) => {
      try {
        const r = await add({
          question: String(args.question ?? ''),
          answer: String(args.answer ?? ''),
          category: args.category ? String(args.category) : undefined,
        });
        return { kbId: r.kbId };
      } catch (e) {
        return errorResult(e);
      }
    }
  );
}

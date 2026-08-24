import type { ToolRegistry } from '@agent-harness/core';
import { search, add } from '../services/kb-service';
import { errorResult } from '../infra/errors';

/**
 * cs_kb_search：检索知识库/FAQ（真实落库，词面匹配）。
 */
export function registerKbTools(tools: ToolRegistry): void {
  tools.register(
    'cs_kb_search',
    '检索知识库/FAQ，返回命中的问答条目；客服应基于检索结果回答，禁止编造政策。',
    {
      type: 'object',
      properties: {
        query: { type: 'string', description: '客户问题关键词' },
        limit: { type: 'number', description: '返回条数（默认 5）' },
      },
      required: ['query'],
    },
    async (args: Record<string, unknown>) => {
      try {
        const rows = search({ query: String(args.query ?? ''), limit: Number(args.limit) || undefined });
        return {
          count: rows.length,
          items: rows.map((r) => ({ question: r.question, answer: r.answer, category: r.category })),
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
        const r = add({
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

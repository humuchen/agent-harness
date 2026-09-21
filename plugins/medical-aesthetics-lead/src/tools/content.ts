import type { ToolRegistry } from '@agent-harness/core';
import { createManualDraft, submitContent, screenContent, CONTENT_PLATFORMS } from '../services/content-service';
import { errorResult } from '../infra/errors';

/**
 * content_draft：Agent 起草平台内容（先审后发闸门内的入口）。
 *
 * 纪律：
 * - 草稿必须过 medicalAdRules 筛查：命中红线 → 结构化拒绝（附违规明细），不落库；
 * - 通过 → 落库为 review 状态（直接进人工审核队列），Agent 无法自行发布；
 *   发布只能由人工过审（approve）后经 /content/publish 触达网关执行。
 * - 工具返回值明确告知「处于审核队列、不可自行发布」，防止模型向用户承诺已发布。
 */
export function registerContentTool(tools: ToolRegistry): void {
  tools.register(
    'content_draft',
    '起草医美平台内容（小红书/抖音/直播）并提交人工审核。文案只允许基于知识库事实做科普表述（原理/适应人群/恢复期/注意事项），禁止疗效承诺、绝对化用语、术前术后对比、固定价格承诺。提交后进入人工审核队列，过审前绝不发布。',
    {
      type: 'object',
      properties: {
        platform: {
          type: 'string',
          enum: [...CONTENT_PLATFORMS],
          description: '目标平台：xiaohongshu / douyin / livestream',
        },
        title: { type: 'string', description: '内容标题（不含疗效承诺与绝对化用语）' },
        body: { type: 'string', description: '内容正文（科普向，事实仅来自知识库）' },
        project: { type: 'string', description: '关联项目名称（可选）' },
      },
      required: ['platform', 'title', 'body'],
    },
    async (args: Record<string, unknown>) => {
      const platform = String(args.platform ?? '').trim();
      const title = String(args.title ?? '').trim();
      const body = String(args.body ?? '').trim();
      const project = args.project ? String(args.project).trim() : undefined;
      if (!title || !body) {
        return { ok: false, code: 'INVALID_ARGUMENT', error: 'title 与 body 均不能为空' };
      }
      try {
        // 先筛查再落库：命中红线直接结构化拒绝，模型可据违规明细改稿
        const hits = screenContent(title, body);
        if (hits.length) {
          return {
            ok: false,
            code: 'INVALID_ARGUMENT',
            error: `医疗广告合规红线：文案命中 ${hits.length} 条违规模式，未提交。请删除相关表述后重试。`,
            violations: hits,
          };
        }
        const d = await createManualDraft({ platform, title, body, project, source: 'llm' });
        // LLM 草稿直接送审（draft → review）：落库即进人工审核队列，Agent 无权自行发布
        const c = await submitContent(d.contentId);
        return {
          ok: true,
          contentId: c.contentId,
          state: c.state,
          note: '已进入人工审核队列。过审（approve）前绝不发布，请勿向用户承诺已发布。',
        };
      } catch (e) {
        return errorResult(e);
      }
    }
  );
}

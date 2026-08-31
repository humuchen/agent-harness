/**
 * memo 插件工具：note_save / note_list / note_delete。
 * 注册在 ctx.tools（插件专属 ToolRegistry），loader 启用时自动加 `memo__` 前缀
 * 合并进进程共享插件工具表（如 note_save → memo__note_save）。
 * 工具抛错不中断主循环：统一返回 { error: true, message } 结构回灌模型自愈。
 */

import type { ToolRegistry } from '@agent-harness/core';
import { saveNote, listNotes, deleteNote } from './store';

function errResult(e: unknown): { error: true; message: string } {
  return { error: true, message: e instanceof Error ? e.message : String(e) };
}

export function registerNoteTools(tools: ToolRegistry): void {
  tools.register(
    'note_save',
    '保存一条备忘/笔记。传入 text（必填）与可选 tag 分类标签，返回生成的备忘 id。',
    {
      type: 'object',
      properties: {
        text: { type: 'string', description: '备忘内容（必填）' },
        tag: { type: 'string', description: '可选分类标签，如 work / idea' },
      },
      required: ['text'],
    },
    async (args: Record<string, unknown>) => {
      try {
        const text = String(args.text ?? '').trim();
        if (!text) return { error: true, message: 'text 不能为空' };
        const note = saveNote(text, args.tag ? String(args.tag) : undefined);
        return { ok: true, id: note.id, text: note.text, tag: note.tag ?? null };
      } catch (e) {
        return errResult(e);
      }
    },
    'plugin:memo'
  );

  tools.register(
    'note_list',
    '列出备忘。可选 tag 过滤与 limit 数量上限（默认 50，最大 200），按写入时间倒序返回。',
    {
      type: 'object',
      properties: {
        tag: { type: 'string', description: '按标签过滤（可选）' },
        limit: { type: 'number', description: '返回条数上限（默认 50）' },
      },
    },
    async (args: Record<string, unknown>) => {
      try {
        const rows = listNotes(
          args.tag ? String(args.tag) : undefined,
          args.limit ? Number(args.limit) : 50
        );
        return { ok: true, total: rows.length, notes: rows };
      } catch (e) {
        return errResult(e);
      }
    },
    'plugin:memo'
  );

  tools.register(
    'note_delete',
    '按 id 删除一条备忘。id 不存在时返回 deleted: false。',
    {
      type: 'object',
      properties: {
        id: { type: 'string', description: '备忘 id（由 note_save 返回）' },
      },
      required: ['id'],
    },
    async (args: Record<string, unknown>) => {
      try {
        const id = String(args.id ?? '').trim();
        if (!id) return { error: true, message: 'id 不能为空' };
        return { ok: true, deleted: deleteNote(id) };
      } catch (e) {
        return errResult(e);
      }
    },
    'plugin:memo'
  );
}

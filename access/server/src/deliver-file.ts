/**
 * 文件交付工具（P-交付闭环）。
 *
 * 背景：agent 生成的文件（builtin__doc_export / builtin__fs_write / MCP 写入）此前
 * 只躺在沙箱目录里，「📎 交付文件」区永远只有 plan-artifacts 合并的 markdown——
 * 用户看得见回复、拿不到文件。本工具把沙箱内已生成的文件**注册进 artifact-store**
 * （runId 对齐 plan 桥的 workflowId），使真实文件出现在交付文件区可预览 / 可下载。
 *
 * 设计：
 * - 注册在 server 侧（assembleAgent 链路）：artifact-store 与 run-user（owner 归属）
 *   都属 access/server 职责，不进 core（core 零业务耦合纪律）；
 * - runId 推导：plan 步骤 sessionKey = `wf:<workflowId>[:<stepId>[:<cardId>]]` →
 *   取 workflowId（与 plan-artifacts 的 list(def.id) 同键，交付文件与合并文档同区展示）；
 *   非会话/聊天 run 用整个 sessionKey 作 runId（经 /api/artifacts?runId= 可拉取）；
 * - 安全：路径锁死在 fsRoot（词法 + realpath 双层），复用 fs 工具同款纪律；
 *   体积上限（DELIVER_FILE_MAX_BYTES，默认 10MB）防大文件撑爆 artifact 盘。
 */

import { promises as fsp } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { getRunUser } from '@agent-harness/core';
import { objectParams, type ToolRegistry } from '@agent-harness/core';
import { getArtifactStore } from './artifact-store';

/** 交付工件的 kind（前端/检索按 runId 过滤即可，kind 用于区分来源）。 */
export const DELIVER_FILE_KIND = 'agent-file-delivery';

/** 单文件交付体积上限；可用 DELIVER_FILE_MAX_BYTES 覆盖。 */
export const DELIVER_FILE_MAX_BYTES = Number(process.env.DELIVER_FILE_MAX_BYTES || '') || 10 * 1024 * 1024;

/** 常见扩展名 → MIME（导出/文档/图片/文本；未识别回落 octet-stream）。 */
const MIME_BY_EXT: Record<string, string> = {
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xlsm': 'application/vnd.ms-excel.sheet.macroEnabled.12',
  '.csv': 'text/csv',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.xml': 'application/xml',
  '.zip': 'application/zip'
};

/** 按扩展名猜 MIME（小写匹配；未识别回落 application/octet-stream）。 */
export function guessMime(name: string): string {
  const i = name.lastIndexOf('.');
  if (i < 0) return 'application/octet-stream';
  return MIME_BY_EXT[name.slice(i).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * 从 sessionKey 推导交付 runId：
 * - `wf:<workflowId>[:<stepId>[:<cardId>]]` → `<workflowId>`（plan 桥 artifact 同键）；
 * - 其它非空 sessionKey → 原样；
 * - 空 → null（调用方回落 'anonymous'）。
 * 纯函数，可单测。
 */
export function deriveRunIdFromSessionKey(sessionKey: string | undefined): string | null {
  const key = (sessionKey ?? '').trim();
  if (!key) return null;
  const m = /^wf:([^:]+)(?::|$)/.exec(key);
  return m ? (m[1] ?? null) : key;
}

/** 展示名安全化：去非法字符、限长；空则回落 basename。 */
export function sanitizeDisplayName(raw: string, fallback: string): string {
  const name = (raw || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return name || fallback;
}

export interface DeliverFileOptions {
  /** 沙箱根目录（与 builtin__fs_* / doc_export 同一 root）。 */
  fsRoot: string;
  /** 当前 run 的 sessionKey（runId 推导用）。 */
  sessionKey?: string;
}

export function registerDeliverFileTool(registry: ToolRegistry, opts: DeliverFileOptions): void {
  const root = resolve(opts.fsRoot);
  // realpath(root) 缓存：macOS 下 /var → /private/var 等符号链接会让「词法 root 前缀比较」
  // 误判逃逸；与 core fs 工具同款纪律，统一以 realpath(root) 为前缀基准。
  let realRootCache: string | null = null;
  const realRoot = async (): Promise<string> => {
    if (realRootCache) return realRootCache;
    try {
      realRootCache = await fsp.realpath(root);
    } catch {
      realRootCache = root;
    }
    return realRootCache;
  };

  registry.register(
    'builtin__deliver_file',
    'Register a file that already exists in the sandbox (e.g. produced by ' +
      'builtin__doc_export or builtin__fs_write) into the artifact store so the user ' +
      'can preview/download it in the deliverables area. Returns JSON {id, name, bytes, runId}.',
    objectParams(
      {
        path: {
          type: 'string',
          description: 'Path relative to the sandbox root (e.g. "exports/季度汇总.xlsx").'
        },
        name: { type: 'string', description: 'Optional display name; defaults to the file name.' },
        note: { type: 'string', description: 'Optional note describing the file.' }
      },
      ['path']
    ),
    async (args: Record<string, unknown>) => {
      const p = String(args.path ?? '');
      try {
        // 词法层：拒绝绝对路径与逃逸 root。
        if (isAbsolute(p)) return `error: absolute paths not allowed: ${p}`;
        const abs = resolve(root, p);
        const rel = relative(root, abs);
        if (rel.startsWith('..') || rel === '' || abs === root) {
          return `error: path escapes root: ${p}`;
        }
        // 真实路径层：防 symlink 逃逸（文件必须已存在），前缀基准为 realpath(root)。
        const real = await fsp.realpath(abs);
        const rr = await realRoot();
        if (!real.startsWith(rr + sep) && real !== rr) {
          return `error: path escapes root (symlink): ${p}`;
        }
        const stat = await fsp.stat(real);
        if (stat.isDirectory()) return 'error: is a directory, not a file';
        if (stat.size > DELIVER_FILE_MAX_BYTES) {
          return `error: file too large (${stat.size} bytes > ${DELIVER_FILE_MAX_BYTES}); ` +
            '如需更大数据请分片或压缩后交付。';
        }
        const buf = await fsp.readFile(real);
        const displayName = sanitizeDisplayName(
          String(args.name ?? ''),
          basename(real)
        );
        const meta = await getArtifactStore().save({
          name: displayName,
          kind: DELIVER_FILE_KIND,
          mimeType: guessMime(displayName),
          content: buf,
          owner: getRunUser()?.sub ?? 'anonymous',
          runId: deriveRunIdFromSessionKey(opts.sessionKey) ?? 'anonymous',
          note: args.note ? String(args.note).slice(0, 500) : undefined
        });
        return JSON.stringify({ ok: true, id: meta.id, name: meta.name, bytes: buf.length, runId: meta.runId });
      } catch (e: unknown) {
        const code = (e as NodeJS.ErrnoException)?.code;
        if (code === 'ENOENT') return `error: file not found: ${p}（先用 builtin__doc_export / builtin__fs_write 生成）`;
        if (code === 'EACCES') return `error: permission denied: ${p}`;
        const msg = e instanceof Error ? e.message : String(e);
        return `error: ${msg}`;
      }
    },
    'builtin'
  );
}

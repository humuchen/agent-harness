/** 已上传文件元信息（服务端返回 / 前端存储用）。 */
export interface UploadMeta {
  id: string;
  name: string;
  size: number;
  type: string;
  /** 服务端 URL，可直接用于 <img src> 或 fetch。 */
  url: string;
  /** 上传时间戳（ms）。 */
  uploadedAt: number;
}

/**
 * 服务端文件上传端点（零外部依赖）。
 *
 * 提供 POST /api/upload，接收 multipart/form-data，把图片/文本文件落盘到
 * `<DATA_DIR>/uploads/`，返回统一 JSON：{ id, name, size, type, url, uploadedAt }。
 *
 * 约束：
 * - 仅接受图片（image/*）与文本（text/*、.csv/.json/.md/.txt）；
 * - 单文件上限 UPLOAD_MAX_BYTES（默认 10 MB，通过环境变量 UPLOAD_MAX_MB 调整）；
 * - 文件名做安全编码：UUID 前缀 + 原始文件名转义，防目录穿越；
 * - 无鉴权（端点本身走 guard 保护；调用方需带 Authorization 头）。
 *
 * 静态文件通过 /api/uploads/:id 暴露，供 <img src> 直接加载。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';

/** 上传目录（相对于进程 cwd 或 DATA_DIR）。 */
const UPLOAD_DIR =
  process.env.UPLOAD_DIR ||
  join(process.cwd(), 'data', 'uploads');

/** 单文件大小上限（默认 10 MB）。 */
const MAX_BYTES =
  (Number(process.env.UPLOAD_MAX_MB) || 10) * 1024 * 1024;

/** 允许的文件 MIME 白名单（图片 + 常见文本）。 */
const ALLOWED_MIME = new Set<string>([
  // 图片
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml',
  // 文本
  'text/plain', 'text/csv', 'text/html', 'text/css', 'text/javascript',
  'application/json', 'application/xml', 'text/markdown',
]);

/** 额外允许的扩展名（兜底，防止 MIME 缺失场景）。 */
const ALLOWED_EXTS = new Set<string>(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.txt', '.md', '.csv', '.json', '.html', '.css', '.js', '.xml']);

/**
 * 解析 multipart body 的极简实现（不依赖 busboy/multiparty）。
 * 仅处理单文件 + 可选文字字段，满足本项目「图片/文本上传」场景。
 */
async function parseMultipart(
  buf: Buffer,
  contentType: string
): Promise<{
  filename?: string;
  mimeType?: string;
  fileBuf?: Buffer;
  fields?: Record<string, string>;
  boundary?: string;
} | null> {
  const ct = (contentType || '').toLowerCase();
  const m = ct.match(/multipart\/form-data;\s*boundary=(.+)/i);
  if (!m) return null;
  const boundary = m[1].trim();
  if (!buf.includes(Buffer.from(boundary))) return null;

  const parts: { filename?: string; mimeType?: string; body: Buffer }[] = [];
  const partRe = new RegExp(
    '\\r?\\n' + escapeRegex(boundary) + '(--)?\\r?\\n([\\s\\S]*?)\\r?\\n' + escapeRegex(boundary) + '(--)?\\r?\\n',
    'g'
  );
  let partMatch: RegExpExecArray | null;
  while ((partMatch = partRe.exec(buf.toString('utf-8'))) !== null) {
    const headerBlock = partMatch[3];
    const bodyStr = partMatch[4] ?? '';
    const isFooter = (partMatch[2] === '--' || partMatch[6] === '--');
    if (isFooter) continue;
    // 解析 Content-Disposition
    const cdMatch = headerBlock.match(/content-disposition:\s*form-data;\s*name="([^"]*)"(?:;\s*filename="([^"]*)")?/i);
    if (!cdMatch) continue;
    const [, name, filename] = cdMatch;
    const mimeMatch = headerBlock.match(/content-type:\s*([^ \r\n]+)/i);
    const mimeType = mimeMatch ? mimeMatch[1].trim() : undefined;
    // body 需要去掉末尾 \r\n
    const body = Buffer.from(bodyStr.replace(/\r?\n$/, ''), 'utf-8');
    parts.push({ filename, mimeType, body });
  }

  const file = parts.find((p) => p.filename);
  const fields: Record<string, string> = {};
  for (const p of parts) {
    if (!p.filename) {
      fields[p.body.toString('utf-8') || 'value'] = p.body.toString('utf-8');
    }
  }
  // 更稳妥地按 name 提取文字字段
  const raw = buf.toString('utf-8');
  const fieldRe = new RegExp(
    '\\r?\\n' + escapeRegex(boundary) + '\\r?\\n([\\s\\S]*?)\\r?\\n' + escapeRegex(boundary) + '(--)?\\r?\\n',
    'g'
  );
  let fm: RegExpExecArray | null;
  while ((fm = fieldRe.exec(raw)) !== null) {
    const headerBlock = fm[1];
    const body = fm[2];
    const cdM = headerBlock.match(/content-disposition:\s*form-data;\s*name="([^"]*)"/i);
    if (cdM) fields[cdM[1]] = body.replace(/\r?\n$/, '');
  }

  return {
    filename: file?.filename,
    mimeType: file?.mimeType,
    fileBuf: file?.body,
    fields,
    boundary,
  };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 生成安全的 UUID-ish 文件名。 */
function safeName(original: string): string {
  const ext = extname(original).toLowerCase().slice(0, 8);
  const hash = createHash('sha256')
    .update(`${Date.now()}-${Math.random()}-${original}`)
    .digest('hex')
    .slice(0, 8);
  return `${hash}${ext}`;
}

/** 校验 MIME / 扩展名是否在白名单。 */
function isAllowed(mime: string | undefined, filename: string): boolean {
  if (!mime) {
    const ext = extname(filename).toLowerCase();
    return ALLOWED_EXTS.has(ext);
  }
  if (ALLOWED_MIME.has(mime.toLowerCase())) return true;
  // 兜底：image/* 或 text/*
  return /^image\//.test(mime) || /^text\//.test(mime);
}

/**
 * 写入文件并返回元信息。
 */
export async function handleUpload(
  reqBody: Buffer,
  contentType: string
): Promise<{ ok: false; error: string } | { ok: true; meta: UploadMeta }> {
  const parsed = await parseMultipart(reqBody, contentType);
  if (!parsed || !parsed.filename || !parsed.fileBuf) {
    return { ok: false, error: '缺少文件（multipart 格式非法）' };
  }
  if (parsed.fileBuf.length > MAX_BYTES) {
    return { ok: false, error: `文件过大（上限 ${Math.round(MAX_BYTES / 1024 / 1024)}MB）` };
  }
  if (!isAllowed(parsed.mimeType, parsed.filename)) {
    return { ok: false, error: `不支持的文件类型：${parsed.filename}` };
  }

  mkdirSync(UPLOAD_DIR, { recursive: true });

  const safe = safeName(parsed.filename);
  const target = join(UPLOAD_DIR, safe);
  // 先写临时文件，再 rename 避免竞态写坏半成品
  const tmp = target + `.tmp.${process.pid}.${Date.now().toString(36)}`;
  try {
    await writeFile(tmp, parsed.fileBuf);
    renameSync(tmp, target);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    return { ok: false, error: `写入失败：${e instanceof Error ? e.message : String(e)}` };
  }

  const id = createHash('md5').update(target).digest('hex').slice(0, 12);
  return {
    ok: true,
    meta: {
      id,
      name: parsed.filename,
      size: parsed.fileBuf.length,
      type: parsed.mimeType || 'application/octet-stream',
      url: `/api/uploads/${safe}`,
      uploadedAt: Date.now(),
    },
  };
}

/**
 * 获取已上传文件内容（供 <img src> 等）。
 * 含目录穿越防护（URL 中不允许 ..）。
 */
export async function serveUploaded(
  filename: string
): Promise<{ ok: false; error: string } | { ok: true; buf: Buffer; mime: string }> {
  if (!/^[\w.-]+$/.test(filename) || filename.includes('..') || filename.startsWith('/')) {
    return { ok: false, error: '非法文件名' };
  }
  const resolved = resolve(UPLOAD_DIR, filename);
  if (!resolved.startsWith(resolve(UPLOAD_DIR))) {
    return { ok: false, error: '路径越界' };
  }
  if (!existsSync(resolved)) return { ok: false, error: '文件不存在' };
  const buf = await readFile(resolved);
  const mime =
    resolved.toLowerCase().endsWith('.png') ? 'image/png'
    : resolved.toLowerCase().endsWith('.jpg') || resolved.toLowerCase().endsWith('.jpeg') ? 'image/jpeg'
    : resolved.toLowerCase().endsWith('.gif') ? 'image/gif'
    : resolved.toLowerCase().endsWith('.webp') ? 'image/webp'
    : resolved.toLowerCase().endsWith('.svg') ? 'image/svg+xml'
    : resolved.toLowerCase().endsWith('.txt') ? 'text/plain'
    : resolved.toLowerCase().endsWith('.md') ? 'text/markdown'
    : resolved.toLowerCase().endsWith('.csv') ? 'text/csv'
    : resolved.toLowerCase().endsWith('.json') ? 'application/json'
    : resolved.toLowerCase().endsWith('.html') ? 'text/html'
    : resolved.toLowerCase().endsWith('.css') ? 'text/css'
    : resolved.toLowerCase().endsWith('.js') ? 'text/javascript'
    : resolved.toLowerCase().endsWith('.xml') ? 'application/xml'
    : 'application/octet-stream';
  return { ok: true, buf, mime };
}

export { UPLOAD_DIR, MAX_BYTES };

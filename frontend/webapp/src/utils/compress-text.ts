/**
 * 文本压缩工具：把用户上传的文本类附件（txt/md/csv/json/log/代码等）
 * 压成「头 + 尾」摘要后再发给大模型；UI 始终展示原始附件。
 *
 * 与 compress-image 同构的解耦原则：本模块只产出「压缩副本」，绝不改写传入的
 * 原始 dataUrl。UI 渲染始终读原始附件，只有在构造模型请求时才使用这里的压缩结果，
 * 因此「UI 显示原文、模型收到压缩文本」两层互不影响。
 *
 * 为什么文本同样需要压缩：一个 5MB 的 .log / .csv 解出来可达上百万字符
 * （≈ 数十万 token）。它一旦随请求进入上下文，单轮就可能击穿窗口；更关键的是
 * 历史中会被逐轮重发，成本随轮次线性放大 —— 与图片是同一个放大机制。
 *
 * 策略：按字符预算做「头部 + 尾部」保留，中间以省略标记替换。
 * - 头尾同时保留而非只留头部：日志/堆栈的结论在尾部，表格的表头与字段语义在
 *   头部。早期「只留开头摘要」的实现会丢掉最关键的报错行。
 * - 切点对齐换行边界，避免把一行切成两半导致语义割裂。
 * - 原文不超过预算时原样返回，不做任何改动（避免无谓损失）。
 */

/** 省略标记：既提示模型「此处有内容被省略」，也可供链路排查时检索到。 */
export const OMIT_MARKER = '……［此处省略 {{OMITTED}} 字符］……';

/** 单文件默认字符预算（约 3~4K token，按中英混排保守估计 chars/4）。 */
export const DEFAULT_MAX_CHARS = 12000;
/** 头部保留比例，其余给尾部。0.6 偏向头部（上下文/表头），尾部仍保留关键结论。 */
export const DEFAULT_HEAD_RATIO = 0.6;
/** 预算下限：低于此值压缩后几乎不可用，故不继续下调。 */
const MIN_KEEP_CHARS = 800;

/** 多附件共享的字符总预算：避免「每个文件都压到上限」导致总量失控。 */
export const DEFAULT_TOTAL_CHARS = 32000;
/** 单个附件在总预算下可分配的上限。 */
export const MAX_PER_FILE_CHARS = 16000;

export interface CompressTextOptions {
  /** 字符预算上限，默认 {@link DEFAULT_MAX_CHARS}。 */
  maxChars?: number;
  /** 头部保留比例 0-1，默认 {@link DEFAULT_HEAD_RATIO}。 */
  headRatio?: number;
}

export interface CompressedText {
  /** 压缩后的文本（未超预算时为原文本身）。 */
  text: string;
  /** 原始字符数。 */
  originalChars: number;
  /** 压缩后字符数。 */
  keptChars: number;
  /** 是否真的发生了压缩。 */
  compressed: boolean;
}

/** 粗估 token 数（chars/4）。仅用于预算与提示，不作为计费依据。 */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

/** 在多个附件之间均分总预算，并夹在 [下限, 单文件上限] 区间内。 */
export function resolveAttachmentBudget(count: number): number {
  if (count <= 0) return DEFAULT_MAX_CHARS;
  const even = Math.floor(DEFAULT_TOTAL_CHARS / count);
  return Math.max(MIN_KEEP_CHARS, Math.min(MAX_PER_FILE_CHARS, even));
}

/** 允许上传的文本类扩展名（MIME 缺失时按扩展名兜底）。 */
const TEXT_EXTS = [
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.jsonl', '.ndjson',
  '.log', '.yml', '.yaml', '.xml', '.html', '.htm', '.css', '.scss',
  '.js', '.cjs', '.mjs', '.ts', '.tsx', '.jsx', '.py', '.go', '.rs',
  '.java', '.kt', '.rb', '.php', '.sh', '.bash', '.ps1', '.sql',
  '.ini', '.toml', '.env', '.conf', '.cfg'
];

/**
 * 是否为文本类附件。图片一律返回 false（走 compress-image 通道）。
 * MIME 可信时以 MIME 为准；MIME 为空（部分拖入来源）时按扩展名兜底。
 */
export function isTextLike(name: string, type: string): boolean {
  if (type) {
    if (type.startsWith('image/')) return false;
    if (type.startsWith('text/')) return true;
    if (/json|xml|javascript|ecmascript|yaml|x-sh|sql|x-httpd-php/i.test(type)) {
      return true;
    }
  }
  const dot = name.lastIndexOf('.');
  if (dot < 0) return false;
  return TEXT_EXTS.includes(name.slice(dot).toLowerCase());
}

/**
 * 把 data URL 解码为文本。非 base64（`data:text/plain,xxx`）走 percent-decode。
 * 解码失败返回 null（调用方据此跳过该附件，绝不回退原文）。
 */
export function dataUrlToText(dataUrl: string): string | null {
  if (!dataUrl) return null;
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return null;
  const header = dataUrl.slice(0, comma);
  const payload = dataUrl.slice(comma + 1);
  try {
    if (!/;base64/i.test(header)) return decodeURIComponent(payload);
    const bin = atob(payload);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    // fatal:false —— 非法字节以替换符呈现，避免个别脏字节让整个附件解码失败。
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch {
    return null;
  }
}

/** 向前收口到最近一个换行之后（保证不切断行）；找不到换行则原样返回。 */
function cutAtLineEnd(s: string): string {
  const nl = s.lastIndexOf('\n');
  return nl > 0 ? s.slice(0, nl) : s;
}

/** 向后收口到最近一个换行之后（从行首开始保留）；找不到换行则原样返回。 */
function cutAtLineStart(s: string): string {
  const nl = s.indexOf('\n');
  return nl >= 0 && nl < s.length - 1 ? s.slice(nl + 1) : s;
}

/**
 * 压缩单段文本：超出预算时保留「头 + 尾」，中间用省略标记替换。
 * 未超预算时原样返回，`compressed` 为 false。
 */
export function compressText(
  text: string,
  opts: CompressTextOptions = {}
): CompressedText {
  const originalChars = text.length;
  const maxChars = Math.max(MIN_KEEP_CHARS, opts.maxChars ?? DEFAULT_MAX_CHARS);
  const headRatio = Math.min(0.95, Math.max(0.05, opts.headRatio ?? DEFAULT_HEAD_RATIO));

  if (originalChars <= maxChars) {
    return { text, originalChars, keptChars: originalChars, compressed: false };
  }

  // 省略标记本身要占位，先从预算里扣除；实际省略数未知，先按占位符长度算。
  const markerLength = OMIT_MARKER.replace('{{OMITTED}}', String(originalChars)).length;
  const budget = Math.max(0, maxChars - markerLength - 2);
  const headBudget = Math.floor(budget * headRatio);
  const tailBudget = budget - headBudget;

  const head = cutAtLineEnd(text.slice(0, headBudget));
  const tail = cutAtLineStart(text.slice(originalChars - tailBudget));
  const omitted = Math.max(0, originalChars - head.length - tail.length);
  const marker = OMIT_MARKER.replace('{{OMITTED}}', String(omitted));
  const out = `${head}\n${marker}\n${tail}`;

  return {
    text: out,
    originalChars,
    keptChars: out.length,
    compressed: true
  };
}

/** 送入摘要的单个附件条目。 */
export interface AttachmentDigestInput {
  name: string;
  type?: string;
  /** 压缩后的文本（调用方先经 {@link compressText} 处理）。 */
  text: string;
  compressed?: boolean;
  originalChars?: number;
  /** 服务端可读取的完整文件路径；有则可让模型按需取原文。 */
  serverUrl?: string;
}

/**
 * 把若干附件的压缩文本拼成一段「附件摘要」块，供追加到模型请求的 prompt 尾部。
 *
 * 注意：这段文本只进入「发给模型的 prompt」，不进 UI 消息内容 —— UI 气泡仍展示
 * 原始附件卡片，因此用户看到的始终是原文件。
 */
export function buildAttachmentDigest(items: AttachmentDigestInput[]): string {
  if (!items.length) return '';
  const lines: string[] = [];
  lines.push('【文本附件】');
  lines.push(
    `用户随本轮消息上传了 ${items.length} 个文本附件。内容过长者已做「头尾保留、中间省略」压缩；` +
      '若你判断摘要不足以回答，请明确说明需要该附件的哪一段内容。'
  );
  for (let i = 0; i < items.length; i++) {
    const a = items[i] as AttachmentDigestInput;
    const stat = a.compressed
      ? `原始 ${a.originalChars ?? a.text.length} 字符，已压缩`
      : `原始 ${a.originalChars ?? a.text.length} 字符`;
    lines.push('');
    lines.push(`===== 附件 ${i + 1}/${items.length}：${a.name}（${stat}）=====`);
    if (a.serverUrl) lines.push(`[完整文件：${a.serverUrl}]`);
    lines.push(a.text);
    lines.push('===== 附件结束 =====');
  }
  return lines.join('\n');
}

/**
 * 一步式：把原始文本压到单文件预算并附加服务端路径。
 * 供调用方直接对每个文本附件调用，避免散落的参数拼装。
 */
export function compressAttachmentText(
  name: string,
  type: string,
  rawText: string,
  opts: CompressTextOptions & { serverUrl?: string } = {}
): AttachmentDigestInput {
  const c = compressText(rawText, opts);
  return {
    name,
    type,
    text: c.text,
    compressed: c.compressed,
    originalChars: c.originalChars,
    serverUrl: opts.serverUrl
  };
}

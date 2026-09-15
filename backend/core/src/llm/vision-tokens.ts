/**
 * 视觉 token 估算：把 `image_url` 块按「接近真实计费量级」计入上下文，而不是按
 * base64 字符数折算、也不是直接记 0。
 *
 * 本模块要同时修掉两个方向相反的失真：
 *
 *  - **高估（展示层）**：调用链拆解曾用 `JSON.stringify(content)` + `estimateTokens`
 *    统计历史，含图消息会把整段 base64 data URL 序列化出来。一张 1MB 的图约 137 万
 *    字符，按「4 字符 = 1 token」折算得到约 34 万 token —— 比真实视觉 token 高出
 *    1~2 个数量级，于是「历史 858,118 tok / 占比 99%」这类数字完全不可用。
 *
 *  - **低估（淘汰层）**：记忆淘汰走 `messageText()`，只抽取 text 块、图片块一律记 0，
 *    使 `historyTokens()` 感知不到历史图片：压缩目标算不出来，图片也因
 *    `typeof content !== 'string'` 被跳过改写，于是「每轮真实计费、却既不计数也不瘦身」。
 *
 * 计费口径参考 OpenAI vision（对多数 OpenAI 兼容端点亦是保守近似）：
 *  - `detail: 'low'`  → 固定 85 tokens；
 *  - `detail: 'high'` → 先缩放进 2048×2048、再把短边缩到 768，按 512×512 分块，
 *    `tokens = 85 + 170 × 块数`。
 *
 * 尺寸从 data URL 头部字节解析（PNG / JPEG / GIF / WebP），只解码前 64KB，
 * 不需要完整解码图片；解析失败时按 base64 体积分档兜底，并钳制在
 * [85, 1105] 区间内 —— 关键是**任何时候都不回到「按字符数折算」那条老路**。
 */

/** `detail: 'low'` 的固定开销。 */
export const LOW_DETAIL_TOKENS = 85;
/** 每个 512×512 图块的开销。 */
export const TILE_TOKENS = 170;
/** 单图视觉 token 上限：既符合 OpenAI 的封顶口径，也防御异常大图撑爆估算。 */
export const MAX_IMAGE_TOKENS = 1105;

export interface ImageSize {
  width: number;
  height: number;
}

/** 取出 data URL 的 base64 载荷；非 data URL（如 http(s) 远端链接）返回空串。 */
function base64Payload(url: string): string {
  if (!url.startsWith('data:')) return '';
  const i = url.indexOf('base64,');
  return i < 0 ? '' : url.slice(i + 'base64,'.length);
}

/** 只解码头部若干字节，避免为了量尺寸而解码整张图。 */
function headerBytes(b64: string, maxBytes = 65536): Buffer | null {
  if (!b64) return null;
  const approx = Math.ceil((maxBytes / 3) * 4);
  const take = Math.min(b64.length, approx);
  // 保持 4 的倍数，避免在 base64 量子边界上截断导致解码失败。
  const cut = take - (take % 4);
  try {
    const b = Buffer.from(b64.slice(0, cut), 'base64');
    return b.length > 0 ? b : null;
  } catch {
    return null;
  }
}

/** PNG：8 字节签名 + 4 字节长度 + 'IHDR'，随后是两个大端 uint32 宽高。 */
function parsePng(b: Buffer): ImageSize | null {
  if (b.length < 24) return null;
  if (b.readUInt32BE(0) !== 0x89504e47) return null;
  const width = b.readUInt32BE(16);
  const height = b.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

/** GIF：6 字节头 + 小端 uint16 宽高。 */
function parseGif(b: Buffer): ImageSize | null {
  if (b.length < 10) return null;
  if (b.toString('ascii', 0, 3) !== 'GIF') return null;
  const width = b.readUInt16LE(6);
  const height = b.readUInt16LE(8);
  return width > 0 && height > 0 ? { width, height } : null;
}

/** JPEG：扫描 SOFn 段（排除 DHT/JPG/DAC），取其中的高度与宽度。 */
function parseJpeg(b: Buffer): ImageSize | null {
  if (b.length < 4 || b.readUInt8(0) !== 0xff || b.readUInt8(1) !== 0xd8) return null;
  let i = 2;
  // 读到 i+8（宽度低位）为止，故要求 i + 9 <= length。
  while (i + 9 <= b.length) {
    if (b.readUInt8(i) !== 0xff) {
      i += 1;
      continue;
    }
    const marker = b.readUInt8(i + 1);
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    const len = b.readUInt16BE(i + 2);
    if (len < 2) return null;
    if (isSof) {
      const height = b.readUInt16BE(i + 5);
      const width = b.readUInt16BE(i + 7);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    i += 2 + len;
  }
  return null;
}

/** WebP：三种子格式（VP8 有损 / VP8L 无损 / VP8X 扩展）各自的宽高位布局不同。 */
function parseWebp(b: Buffer): ImageSize | null {
  if (b.length < 30) return null;
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WEBP') return null;
  const fmt = b.toString('ascii', 12, 16);
  if (fmt === 'VP8 ') {
    const width = b.readUInt16LE(26) & 0x3fff;
    const height = b.readUInt16LE(28) & 0x3fff;
    return width > 0 && height > 0 ? { width, height } : null;
  }
  if (fmt === 'VP8L') {
    if (b.length < 25) return null;
    const bits = b.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (fmt === 'VP8X') {
    const width = (b.readUInt8(24) | (b.readUInt8(25) << 8) | (b.readUInt8(26) << 16)) + 1;
    const height = (b.readUInt8(27) | (b.readUInt8(28) << 8) | (b.readUInt8(29) << 16)) + 1;
    return { width, height };
  }
  return null;
}

/** 从 data URL 解析图片像素尺寸；无法解析（远端 URL / 未知封装）时返回 null。 */
export function parseImageSize(dataUrl: string): ImageSize | null {
  const b = headerBytes(base64Payload(dataUrl));
  if (!b) return null;
  return parsePng(b) ?? parseJpeg(b) ?? parseGif(b) ?? parseWebp(b);
}

/**
 * 尺寸不可解析时的体积兜底：按 base64 字节数粗推像素量级后分档。
 * 只用相对量级（不追求精确），并钳制在 [85, 1105]，避免重演「高估 1~2 个数量级」。
 */
function fallbackTokensFromBytes(url: string): number {
  const b64 = base64Payload(url);
  // 远端 URL（无 base64 载荷）：给最低档，不臆造大数。
  if (!b64) return LOW_DETAIL_TOKENS;
  const bytes = Math.floor((b64.length * 3) / 4);
  // 经验值：JPEG q≈0.8 约 0.15 字节/像素 → 像素 ≈ bytes / 0.15。
  const side = Math.sqrt(bytes / 0.15);
  const units = Math.max(1, Math.ceil(side / 768)); // 与「短边 768」规则同一量纲
  return Math.min(MAX_IMAGE_TOKENS, LOW_DETAIL_TOKENS + TILE_TOKENS * units * units);
}

/**
 * 估算一张图片占用的视觉 token。
 *
 * @param url    `image_url.url`（data URL 或远端 URL）
 * @param detail 请求中标注的 detail；未标注按 'auto' 处理（沿用 high 的分块口径，
 *               因为 'auto' 由模型端决定，按上界估更安全，且不至于像 base64 折算那样失控）
 */
export function estimateImageTokens(url: string, detail?: 'low' | 'high' | 'auto'): number {
  if (!url) return 0;
  if (detail === 'low') return LOW_DETAIL_TOKENS;

  const size = parseImageSize(url);
  if (!size) return fallbackTokensFromBytes(url);

  // 1) 等比缩放进 2048×2048
  let { width, height } = size;
  const fit = Math.min(1, 2048 / Math.max(width, height));
  width = Math.max(1, Math.round(width * fit));
  height = Math.max(1, Math.round(height * fit));
  // 2) 短边若超过 768，再缩到 768
  const short = Math.min(width, height);
  if (short > 768) {
    const s = 768 / short;
    width = Math.max(1, Math.round(width * s));
    height = Math.max(1, Math.round(height * s));
  }
  // 3) 按 512×512 分块
  const tiles = Math.max(1, Math.ceil(width / 512) * Math.ceil(height / 512));
  return Math.min(MAX_IMAGE_TOKENS, LOW_DETAIL_TOKENS + TILE_TOKENS * tiles);
}

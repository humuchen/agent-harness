/**
 * 图片压缩工具：在上传到 /api/upload 之前、以及发送大模型之前降低大尺寸图片的体积。
 *
 * 策略：
 * - 仅对 raster 图片（jpeg/png/webp）做压缩；svg/gif 保持原样。
 * - 若文件已小于阈值，直接返回原文件（保留清晰度，避免无谓损耗）。
 * - 否则按最长边等比缩放，再经 canvas 以指定质量输出为 jpeg（去 Alpha，体积更小）。
 * - 主压缩若未生效（体积反增），按更激进参数二次压缩；尽量返回压缩版，
 *   仅在解码失败或原图本就不大时才回退原图，避免超大原图进入上下文造成 token 爆炸。
 *
 * 注意：本模块只产出「压缩副本」，绝不改写传入的原始文件/原始 dataUrl。
 * UI 渲染始终使用原始 dataUrl，发送/落盘模型请求时才使用这里的压缩结果，
 * 因此「UI 显示原图、模型收到压缩图」两层解耦。
 */

export interface CompressOptions {
  /** 触发压缩的最小文件大小（字节）。低于此值视为已足够小，直接返回原图。 */
  thresholdBytes?: number;
  /** 最长边上限（像素）。 */
  maxEdge?: number;
  /** 输出质量 0-1，默认 0.82。 */
  quality?: number;
  /** 输出 MIME 类型；默认 image/jpeg（体积小于 png，且兼容所有视觉模型）。 */
  mimeType?: string;
}

// 收紧默认阈值：256KB 即触发压缩，让更多图进入压缩流程（旧值 1MB 放行了过多原图）。
const DEFAULT_THRESHOLD = 256 * 1024;
// 最长边 1280px：对截图/图表/文档已足够清晰，相较 1920 像素数下降约 55%。
const DEFAULT_MAX_EDGE = 1280;
const DEFAULT_QUALITY = 0.82;
// 二次压缩参数：主压缩无效时进一步下调分辨率与质量。
const AGGRESSIVE_MAX_EDGE = 1024;
const AGGRESSIVE_QUALITY = 0.7;
// 原图超过此体积且无法有效压缩时，宁可降低质量也强制返回压缩版，杜绝 token 膨胀。
const FORCE_COMPRESS_BYTES = 2 * 1024 * 1024;

function isRasterImage(file: File): boolean {
  if (file.type === 'image/svg+xml' || file.type === 'image/gif') return false;
  return file.type.startsWith('image/');
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error(`读取图片失败：${file.name}`));
    reader.readAsDataURL(file);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片解码失败'));
    img.src = src;
  });
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  mimeType: string,
  quality: number
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error('canvas 导出 Blob 失败'));
      },
      mimeType,
      quality
    );
  });
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('Blob 转 data URL 失败'));
    reader.readAsDataURL(blob);
  });
}

function computeDimensions(
  img: HTMLImageElement,
  maxEdge: number
): { width: number; height: number } {
  let { width, height } = img;
  const max = Math.max(width, height);
  if (max > maxEdge) {
    const ratio = maxEdge / max;
    width = Math.round(width * ratio);
    height = Math.round(height * ratio);
  }
  return { width, height };
}

async function compressFromImage(
  img: HTMLImageElement,
  opts: Required<CompressOptions>
): Promise<Blob> {
  const dims = computeDimensions(img, opts.maxEdge);
  const canvas = document.createElement('canvas');
  canvas.width = dims.width;
  canvas.height = dims.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法获取 canvas 2d 上下文');

  // jpeg 不支持透明通道，先铺白底避免透明区域变黑。
  if (opts.mimeType === 'image/jpeg') {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, dims.width, dims.height);
  }
  ctx.drawImage(img, 0, 0, dims.width, dims.height);
  return canvasToBlob(canvas, opts.mimeType, opts.quality);
}

function resolveOpts(opts: CompressOptions = {}): Required<CompressOptions> {
  return {
    thresholdBytes: opts.thresholdBytes ?? DEFAULT_THRESHOLD,
    maxEdge: opts.maxEdge ?? DEFAULT_MAX_EDGE,
    quality: opts.quality ?? DEFAULT_QUALITY,
    mimeType: opts.mimeType ?? 'image/jpeg',
  };
}

/**
 * 估算 data URL 的解码后字节数（base64 体积 ≈ 字节数 * 4/3）。
 */
function approxBytesOf(dataUrl: string): number {
  const payload = dataUrl.split(',')[1] ?? '';
  return Math.ceil((payload.length * 3) / 4);
}

/**
 * 压缩 data URL。返回压缩后的 data URL；仅当原图本就很小或解码失败时回退原图。
 *
 * 与 UI 渲染解耦：调用方负责把返回结果用于「发送模型」，而 UI 仍使用原始 dataUrl。
 */
export async function compressDataUrl(
  dataUrl: string,
  opts: CompressOptions = {}
): Promise<string> {
  const o = resolveOpts(opts);
  if (!dataUrl.startsWith('data:image/')) return dataUrl;

  const approxBytes = approxBytesOf(dataUrl);
  // 体积已很小：直接返回原图，保留清晰度。
  if (approxBytes <= o.thresholdBytes) return dataUrl;

  try {
    const img = await loadImage(dataUrl);
    // 主压缩
    let blob = await compressFromImage(img, o);
    // 主压缩未生效（体积反增）：按更激进参数二次压缩。
    if (blob.size >= approxBytes) {
      const aggressive = {
        ...o,
        maxEdge: Math.min(o.maxEdge, AGGRESSIVE_MAX_EDGE),
        quality: Math.min(o.quality, AGGRESSIVE_QUALITY),
      };
      const second = await compressFromImage(img, aggressive);
      if (second.size < blob.size) blob = second;
    }
    // 压缩版只要不比原图更大就采用（即便只小一点，也避免原图 token 膨胀）。
    if (blob.size < approxBytes) {
      return await blobToDataUrl(blob);
    }
    // 压缩无效且原图本就不大：回退原图（影响可控）。
    if (approxBytes <= FORCE_COMPRESS_BYTES) return dataUrl;
    // 原图极大但无法有效压缩：仍返回已压缩版本，宁降质也不让原图进入上下文。
    return await blobToDataUrl(blob);
  } catch {
    // 仅解码失败时回退原图（极少数损坏图）。
    return dataUrl;
  }
}

/**
 * 压缩图片文件。返回 File（保留文件名，后缀按 mimeType 调整）。
 * 不需要压缩时会直接返回原 File。
 */
export async function compressImage(
  file: File,
  opts: CompressOptions = {}
): Promise<File> {
  const o = resolveOpts(opts);
  if (!isRasterImage(file)) return file;
  if (file.size <= o.thresholdBytes) return file;

  try {
    const dataUrl = await readFileAsDataUrl(file);
    const img = await loadImage(dataUrl);
    const dims = computeDimensions(img, o.maxEdge);
    if (dims.width === img.width && dims.height === img.height && file.size <= o.thresholdBytes) {
      return file;
    }

    let blob = await compressFromImage(img, o);
    // 体积反增时二次激进压缩
    if (blob.size >= file.size) {
      const aggressive = {
        ...o,
        maxEdge: Math.min(o.maxEdge, AGGRESSIVE_MAX_EDGE),
        quality: Math.min(o.quality, AGGRESSIVE_QUALITY),
      };
      const second = await compressFromImage(img, aggressive);
      if (second.size < blob.size) blob = second;
    }
    if (blob.size < file.size) {
      const ext = o.mimeType === 'image/png' ? '.png'
        : o.mimeType === 'image/webp' ? '.webp'
        : '.jpg';
      const baseName = file.name.replace(/\.[^/.]+$/, '');
      return new File([blob], `${baseName}${ext}`, { type: o.mimeType });
    }
    // 无法有效压缩且原图不大：回退；极大图仍强制返回压缩版。
    if (file.size <= FORCE_COMPRESS_BYTES) return file;
    const ext = o.mimeType === 'image/png' ? '.png'
      : o.mimeType === 'image/webp' ? '.webp'
      : '.jpg';
    const baseName = file.name.replace(/\.[^/.]+$/, '');
    return new File([blob], `${baseName}${ext}`, { type: o.mimeType });
  } catch {
    return file;
  }
}

/**
 * 图片压缩工具：在上传到 /api/upload 之前降低大尺寸图片的体积。
 *
 * 策略：
 * - 仅对 raster 图片（jpeg/png/webp）做压缩；svg/gif 保持原样。
 * - 若文件已小于阈值，直接返回原文件。
 * - 否则按最长边等比缩放，再经 canvas 以指定质量输出。
 * - 若压缩后体积反而变大（少见，如小尺寸高质量 PNG），回退原文件。
 */

export interface CompressOptions {
  /** 触发压缩的最小文件大小（字节）。 */
  thresholdBytes?: number;
  /** 最长边上限（像素）。 */
  maxEdge?: number;
  /** 输出质量 0-1，默认 0.85。 */
  quality?: number;
  /** 输出 MIME 类型；默认 image/jpeg。 */
  mimeType?: string;
}

const DEFAULT_THRESHOLD = 1024 * 1024; // 1 MB
const DEFAULT_MAX_EDGE = 1920;
const DEFAULT_QUALITY = 0.85;

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
    mimeType: opts.mimeType ?? 'image/jpeg'
  };
}

/**
 * 压缩 data URL。返回压缩后的 data URL；若无需压缩或压缩失败则返回原串。
 */
export async function compressDataUrl(
  dataUrl: string,
  opts: CompressOptions = {}
): Promise<string> {
  const o = resolveOpts(opts);
  if (!dataUrl.startsWith('data:image/')) return dataUrl;
  // 简单按 base64 体积估算：data URL 中 data:image/xxx;base64, 之后的内容。
  const payload = dataUrl.split(',')[1] ?? '';
  const approxBytes = Math.ceil((payload.length * 3) / 4);
  if (approxBytes <= o.thresholdBytes) return dataUrl;

  try {
    const img = await loadImage(dataUrl);
    const blob = await compressFromImage(img, o);
    if (blob.size >= approxBytes) return dataUrl;
    return await blobToDataUrl(blob);
  } catch {
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

  const dataUrl = await readFileAsDataUrl(file);
  const img = await loadImage(dataUrl);
  const dims = computeDimensions(img, o.maxEdge);
  if (dims.width === img.width && dims.height === img.height && file.size <= o.thresholdBytes) {
    return file;
  }

  try {
    const blob = await compressFromImage(img, o);
    if (blob.size >= file.size) return file;

    const ext = o.mimeType === 'image/png' ? '.png'
      : o.mimeType === 'image/webp' ? '.webp'
      : '.jpg';
    const baseName = file.name.replace(/\.[^/.]+$/, '');
    return new File([blob], `${baseName}${ext}`, { type: o.mimeType });
  } catch {
    return file;
  }
}

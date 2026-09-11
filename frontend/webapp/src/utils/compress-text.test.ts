/**
 * 文本附件压缩的行为验证。
 *
 * 背景：文本附件此前无任何压缩 —— 一个几 MB 的 .log / .csv 会以完整原文进入
 * 模型上下文，并随历史逐轮重发，与图片是同一个 token 放大机制。
 *
 * 这里只测纯函数（不启动 DOM）：预算、头尾保留、换行对齐、解码健壮性。
 */
import { describe, it, expect } from 'vitest';
import {
  OMIT_MARKER,
  MAX_PER_FILE_CHARS,
  DEFAULT_MAX_CHARS,
  isTextLike,
  dataUrlToText,
  compressText,
  resolveAttachmentBudget,
  buildAttachmentDigest,
  compressAttachmentText
} from './compress-text';

describe('isTextLike', () => {
  it('按 MIME 判定文本类', () => {
    expect(isTextLike('a.txt', 'text/plain')).toBe(true);
    expect(isTextLike('data', 'application/json')).toBe(true);
    expect(isTextLike('f', 'text/csv')).toBe(true);
  });

  it('图片一律不是文本（走图片压缩通道）', () => {
    expect(isTextLike('a.png', 'image/png')).toBe(false);
    expect(isTextLike('a.png', '')).toBe(false);
  });

  it('MIME 为空时按扩展名兜底', () => {
    expect(isTextLike('build.log', '')).toBe(true);
    expect(isTextLike('main.ts', '')).toBe(true);
    expect(isTextLike('archive.bin', '')).toBe(false);
  });
});

describe('dataUrlToText', () => {
  it('解码 base64 的 UTF-8 文本', () => {
    const src = '姓名,城市\n张三,上海\n';
    const b64 = Buffer.from(src, 'utf8').toString('base64');
    expect(dataUrlToText(`data:text/csv;base64,${b64}`)).toBe(src);
  });

  it('解码非 base64 的 percent-encoded 文本', () => {
    expect(dataUrlToText('data:text/plain,hello%20world')).toBe('hello world');
  });

  it('非法输入返回 null（调用方据此跳过，绝不回退原文）', () => {
    expect(dataUrlToText('')).toBeNull();
    expect(dataUrlToText('not-a-data-url')).toBeNull();
  });
});

describe('compressText', () => {
  it('未超预算时原样返回，标记未压缩', () => {
    const s = 'small text';
    const r = compressText(s, { maxChars: 100 });
    expect(r.text).toBe(s);
    expect(r.compressed).toBe(false);
  });

  it('超预算时保留头尾、中间省略', () => {
    const lines = Array.from({ length: 500 }, (_, i) => `line ${i} ${'x'.repeat(40)}`);
    const raw = lines.join('\n');
    const r = compressText(raw, { maxChars: 2000 });
    expect(r.compressed).toBe(true);
    expect(r.originalChars).toBe(raw.length);
    // 头部第一行与尾部最后一行必须都还在（只留头部是旧实现的缺陷）。
    expect(r.text).toContain('line 0 ');
    expect(r.text).toContain('line 499 ');
    expect(r.text).toContain('［此处省略');
    // 压缩后应明显小于原文，且不超过预算量级。
    expect(r.keptChars).toBeLessThan(raw.length);
    expect(r.keptChars).toBeLessThanOrEqual(2000);
  });

  it('切点对齐换行，不产生半行残段', () => {
    const lines = Array.from({ length: 300 }, (_, i) => `${String(i).padStart(4, '0')}-payload`);
    const raw = lines.join('\n');
    const r = compressText(raw, { maxChars: 1200 });
    const middle = r.text.split(OMIT_MARKER.replace('{{OMITTED}}', '0').slice(0, 8))[0];
    if (middle) {
      const kept = middle.trim();
      expect(kept.endsWith('payload')).toBe(true);
    }
  });

  it('maxChars 有下限保护，不会压到不可用', () => {
    const raw = 'y'.repeat(5000);
    const r = compressText(raw, { maxChars: 1 });
    expect(r.compressed).toBe(true);
    // 下限 MIN_KEEP_CHARS=800，压缩结果应显著大于 1。
    expect(r.keptChars).toBeGreaterThan(100);
  });
});

describe('resolveAttachmentBudget', () => {
  it('单个附件最多给到单文件上限', () => {
    expect(resolveAttachmentBudget(1)).toBe(MAX_PER_FILE_CHARS);
  });

  it('多附件时均分总预算', () => {
    expect(resolveAttachmentBudget(4)).toBe(8000);
  });

  it('数量极大时收敛到下限而非 0', () => {
    expect(resolveAttachmentBudget(1000)).toBeGreaterThan(0);
  });

  it('零附件回退默认预算', () => {
    expect(resolveAttachmentBudget(0)).toBe(DEFAULT_MAX_CHARS);
  });
});

describe('buildAttachmentDigest', () => {
  it('空列表返回空串（调用方据此不加摘要）', () => {
    expect(buildAttachmentDigest([])).toBe('');
  });

  it('包含文件名、压缩状态与服务端路径', () => {
    const item = compressAttachmentText('app.log', 'text/plain', 'z'.repeat(5000), {
      maxChars: 1000,
      serverUrl: '/api/uploads/app.log'
    });
    const digest = buildAttachmentDigest([item]);
    expect(digest).toContain('app.log');
    expect(digest).toContain('已压缩');
    expect(digest).toContain('/api/uploads/app.log');
    expect(digest).toContain('附件 1/1');
  });
});

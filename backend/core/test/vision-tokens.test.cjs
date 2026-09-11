'use strict';
/**
 * 视觉 token 估算的回归测试。
 *
 * 覆盖两个此前互相矛盾、都会导致 token 口径失真的行为：
 *  - 展示层把图片 base64 当纯文本数（1MB 图上万倍高估）；
 *  - 淘汰层把图片块记为 0（含图历史永远低估）。
 * 两者都必须收敛到「与真实计费同量级」的视觉 token 估算上。
 */
const test = require('node:test');
const assert = require('node:assert');
const {
  estimateImageTokens,
  parseImageSize,
  LOW_DETAIL_TOKENS,
  MAX_IMAGE_TOKENS
} = require('../dist/llm/vision-tokens.js');
const { estimateTokens, estimateMessageTokens } = require('../dist/llm/token-estimator.js');

/** 构造只含合法 IHDR 头的 PNG data URL（只需前 24 字节即可解析出宽高）。 */
function pngDataUrl(width, height) {
  const b = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8); // IHDR 长度
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return 'data:image/png;base64,' + b.toString('base64');
}

/** 构造合法 JPEG SOF0 段（仅需 SOI + 段头 + 精度 + 宽高）。 */
function jpegDataUrl(width, height) {
  const b = Buffer.alloc(20);
  b.writeUInt16BE(0xffd8, 0); // SOI
  b.writeUInt16BE(0xffc0, 2); // SOF0
  b.writeUInt16BE(11, 4); // 段长
  b.writeUInt8(8, 6); // 精度
  b.writeUInt16BE(height, 7);
  b.writeUInt16BE(width, 9);
  return 'data:image/jpeg;base64,' + b.toString('base64');
}

test('parseImageSize 解析 PNG 宽高', () => {
  const size = parseImageSize(pngDataUrl(1024, 768));
  assert.deepEqual(size, { width: 1024, height: 768 });
});

test('parseImageSize 解析 JPEG SOF0 宽高', () => {
  const size = parseImageSize(jpegDataUrl(1600, 900));
  assert.deepEqual(size, { width: 1600, height: 900 });
});

test('parseImageSize 对远端 URL 返回 null（不臆造尺寸）', () => {
  assert.equal(parseImageSize('https://example.com/a.png'), null);
});

test('detail=low 固定 85 tokens', () => {
  assert.equal(estimateImageTokens(pngDataUrl(4096, 4096), 'low'), LOW_DETAIL_TOKENS);
});

test('512×512 图片为 1 个图块：85 + 170', () => {
  assert.equal(estimateImageTokens(pngDataUrl(512, 512)), 255);
});

test('1024×768 缩放后为 2×2 图块：85 + 680', () => {
  assert.equal(estimateImageTokens(pngDataUrl(1024, 768)), 765);
});

test('超大图先缩进 2048 再把短边压到 768，仍为 2×2 图块', () => {
  // 4096×4096 → 缩放进 2048 → 短边 2048 > 768 → 再缩到 768×768 → 2×2 图块。
  assert.equal(estimateImageTokens(pngDataUrl(4096, 4096)), 765);
});

test('宽幅图短边未超 768 时不二次缩放', () => {
  // 2048×512：fit 后短边 512 ≤ 768，图块数 = ceil(2048/512) × 1 = 4。
  assert.equal(estimateImageTokens(pngDataUrl(2048, 512)), 765);
});

test('无法解析的远端 URL 退回最低档，而非按 URL 长度折算', () => {
  const longUrl = 'https://example.com/' + 'a'.repeat(20000) + '.png';
  assert.equal(estimateImageTokens(longUrl), LOW_DETAIL_TOKENS);
});

test('回归：1MB 级 base64 图片不再被高估到数十万 token', () => {
  // 旧实现（JSON.stringify + 4 字符/token）会把这里算成约 35 万 token。
  // 新口径必须是视觉 token 量级，且被 MAX_IMAGE_TOKENS 封顶。
  const huge = 'data:image/jpeg;base64,' + 'A'.repeat(1_400_000);
  const t = estimateImageTokens(huge);
  assert.ok(t <= MAX_IMAGE_TOKENS, `应被封顶，实际 ${t}`);
  assert.ok(t >= LOW_DETAIL_TOKENS, `不应低于最低档，实际 ${t}`);
  assert.ok(t < 3000, `不应再出现数万/数十万量级，实际 ${t}`);
});

test('estimateMessageTokens：纯字符串与 estimateTokens 一致', () => {
  const text = 'Hello 世界，这是一段普通文本。';
  assert.equal(estimateMessageTokens({ role: 'user', content: text }), estimateTokens(text));
});

test('estimateMessageTokens：多模态 = 文本 + 视觉', () => {
  const text = '看这张图';
  const url = pngDataUrl(1024, 768);
  const t = estimateMessageTokens({
    role: 'user',
    content: [
      { type: 'text', text },
      { type: 'image_url', image_url: { url } }
    ]
  });
  assert.equal(t, estimateTokens(text) + 765);
});

test('estimateMessageTokens：仅有图片时不为 0', () => {
  const t = estimateMessageTokens({
    role: 'user',
    content: [{ type: 'image_url', image_url: { url: pngDataUrl(512, 512) } }]
  });
  assert.ok(t >= LOW_DETAIL_TOKENS, `图片不应记为 0，实际 ${t}`);
});

test('estimateMessageTokens：detail=low 走最低档', () => {
  const t = estimateMessageTokens({
    role: 'user',
    content: [
      { type: 'image_url', image_url: { url: pngDataUrl(4096, 4096), detail: 'low' } }
    ]
  });
  assert.equal(t, LOW_DETAIL_TOKENS);
});

test('estimateMessageTokens：空输入为 0', () => {
  assert.equal(estimateMessageTokens(null), 0);
  assert.equal(estimateMessageTokens(undefined), 0);
  assert.equal(estimateMessageTokens({ role: 'user', content: '' }), 0);
  assert.equal(estimateMessageTokens({ role: 'user', content: [] }), 0);
});

test('回归：含大图的多模态消息不再被算成 base64 长度量级', () => {
  const huge = 'data:image/jpeg;base64,' + 'A'.repeat(1_400_000);
  const t = estimateMessageTokens({
    role: 'user',
    content: [{ type: 'image_url', image_url: { url: huge } }]
  });
  assert.ok(t <= MAX_IMAGE_TOKENS, `应被封顶，实际 ${t}`);
});

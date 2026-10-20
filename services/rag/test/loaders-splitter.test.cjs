// P6-B（方案二一期）：loaders / splitter / ingestStructured 契约测试。
// stdlib-only 纪律：markdown/text 内置、url mock fetch、PDF/DOCX 外部旁路未配置必须明确报错。
const test = require('node:test');
const assert = require('node:assert');

const { loadDocument, htmlToText } = require('../dist/loaders.js');
const { splitMarkdown, splitPlainText, splitAuto } = require('../dist/splitter.js');
const { MemoryVectorStore } = require('../dist/store.js');
const { HashEmbedding } = require('../dist/embed.js');
const { ingestStructured } = require('../dist/ingest.js');

const MD = `# 部署指南

总体说明段落。

## 安装

安装会员系统的步骤说明，会员功能需要先配置数据库。

## 发票

发票模块独立部署。

### 发票配置

发票配置的细节说明。
`;

test('splitter: markdown 多级标题 heading_path 正确、不跨标题断义', () => {
  const pieces = splitMarkdown(MD, { maxLen: 200 });
  // 首片（# 前正文）无标题路径；「安装」片 path=['部署指南','安装']。
  const install = pieces.find((p) => p.content.includes('安装会员系统'));
  assert.ok(install, '安装 section 存在');
  assert.deepStrictEqual(install.headingPath, ['部署指南', '安装']);
  const invoiceConf = pieces.find((p) => p.content.includes('发票配置的细节'));
  assert.ok(invoiceConf);
  assert.deepStrictEqual(invoiceConf.headingPath, ['部署指南', '发票', '发票配置']);
  // 不跨标题：安装 section 的片不含「发票」正文。
  assert.strictEqual(
    pieces.some((p) => p.headingPath[1] === '安装' && p.content.includes('发票模块')),
    false
  );
  // index 全文档递增。
  assert.deepStrictEqual(
    pieces.map((p) => p.index),
    pieces.map((_, i) => i)
  );
});

test('splitter: 超长 section 递归降级（段落→句子），单片不超上限', () => {
  const longBody = `# 标题\n\n${'长句内容。'.repeat(200)}`;
  const pieces = splitMarkdown(longBody, { maxLen: 200 });
  assert.ok(pieces.length > 1, '超长切多片');
  for (const p of pieces) {
    assert.ok(p.content.length <= 260, `单片长度受控（${p.content.length}）`);
    assert.deepStrictEqual(p.headingPath, ['标题']);
  }
});

test('splitter: 纯文本走段落/句子递归；splitAuto 按标题分派', () => {
  const plain = '段落一。\n\n段落二。'.repeat(1);
  const p1 = splitPlainText(plain, { maxLen: 480 });
  assert.strictEqual(p1.length, 1);
  assert.deepStrictEqual(p1[0].headingPath, []);
  // splitAuto：无标题 → 纯文本路径。
  assert.strictEqual(splitAuto('普通文本没有标题').length >= 1, true);
  // splitAuto：有标题 → markdown 路径。
  assert.deepStrictEqual(splitAuto('# 标题\n内容')[0].headingPath, ['标题']);
});

test('loader: markdown/text 原样（首尾 trim）；非法输入明确报错（不静默）', async () => {
  const md = await loadDocument({ type: 'markdown', value: MD });
  assert.strictEqual(md.text, MD.trim(), 'markdown 透传（仅首尾空白规整）');
  const tx = await loadDocument({ type: 'text', value: '  hello\r\nworld  ' });
  assert.strictEqual(tx.text, 'hello\nworld');
  await assert.rejects(() => loadDocument({ type: 'markdown', value: ' ' }), /source\.value 必填/);
  await assert.rejects(() => loadDocument({ type: 'url', value: 'ftp://x' }), /http\/https/);
  await assert.rejects(
    () => loadDocument({ type: 'pdf', value: 'doc.pdf' }),
    /RAG_LOADER_PDF_URL/,
    'PDF 外部旁路未配置必须明确报错'
  );
  await assert.rejects(
    () => loadDocument({ type: 'docx', value: 'doc.docx' }),
    /RAG_LOADER_DOCX_URL/
  );
});

test('loader: URL 抓取（mock fetch）→ 正文抽取 + title 元数据', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () =>
      '<html><head><title>测试页</title></head><body><script>evil()</script>' +
      '<h1>标题</h1><p>正文段落内容</p></body></html>',
  });
  try {
    const doc = await loadDocument({ type: 'url', value: 'https://example.com/a?b=1' });
    assert.ok(doc.text.includes('正文段落内容'));
    assert.strictEqual(doc.text.includes('evil'), false, 'script 已剥离');
    assert.strictEqual(doc.meta.title, '测试页');
    assert.strictEqual(doc.meta.finalUrl, 'https://example.com/a?b=1');
  } finally {
    globalThis.fetch = orig;
  }
});

test('loader: htmlToText 实体解码与压缩', () => {
  const { text } = htmlToText('<p>A&amp;B</p><p>C&nbsp; D</p>');
  assert.ok(text.includes('A&B'));
  assert.ok(text.includes('C D'));
});

test('ingestStructured 端到端：结构化切分入库 + 检索命中正确 section', async () => {
  const store = new MemoryVectorStore(256);
  const provider = new HashEmbedding(256);
  const res = await ingestStructured(store, provider, {
    doc_id: 'md1',
    tenant_id: 't1',
    title: '业务手册',
    source: { type: 'markdown', value: MD },
    max_len: 300,
  });
  assert.strictEqual(res.doc_id, 'md1');
  assert.ok(res.chunks >= 3, `多 section 切分（实际 ${res.chunks}）`);
  // heading_path 落进 metadata（抽查任一含「安装」的 chunk）。
  const all = store.getChunks('t1');
  const installChunk = all.find((c) => c.content.includes('安装会员系统'));
  assert.ok(installChunk);
  assert.deepStrictEqual(installChunk.metadata?.heading_path, ['部署指南', '安装']);
  // 检索：会员查询 top1 命中「安装」section（哈希嵌入对精确词敏感，非精确语义）。
  const { retrieve } = require('../dist/retrieve.js');
  const resp = await retrieve(store, provider, { query: '会员 系统安装 数据库配置', tenant_id: 't1', top_k: 2 });
  assert.ok(resp.results.length > 0);
  assert.ok(resp.results[0].content.includes('会员'), 'top1 命中会员相关 section');
  // 幂等重入库：replaced > 0。
  const res2 = await ingestStructured(store, provider, {
    doc_id: 'md1',
    tenant_id: 't1',
    source: { type: 'markdown', value: MD },
  });
  assert.strictEqual(res2.replaced, res.chunks);
});

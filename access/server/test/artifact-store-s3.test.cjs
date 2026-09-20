'use strict';
// S3 兼容工件存储（P5.7）后端单测。
// 用 node:http 起一个内存版 fake S3（path-style 端点），零外部依赖：
// 覆盖：save→list→get→readContent 字节往返、remove 语义、非法 id 拒绝、
// SigV4 authorization / x-amz-* 头存在、ARTIFACT_STORE=s3 缺关键配置时工厂抛错。
//
// 运行：node --test test/artifact-store-s3.test.cjs（需先 tsc 构建 dist）

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { getArtifactStore, setArtifactStore } = require('../dist/artifact-store.js');

let server = null;
let baseUrl = '';
let objects = null; // Map<objKey, Buffer>
let lastAuthHeader = null;

// ── fake S3：path-style http://host/<bucket>/<key>，PUT/GET/DELETE 三动作 ──
test.before(async () => {
  objects = new Map();
  server = http.createServer((req, res) => {
    lastAuthHeader = req.headers['authorization'] || null;
    // /<bucket>/<key...> → 去掉 bucket 段
    const parts = decodeURIComponent(req.url).split('/').filter(Boolean);
    parts.shift(); // bucket
    const objKey = parts.join('/');
    if (req.method === 'PUT') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        objects.set(objKey, Buffer.concat(chunks));
        res.writeHead(200);
        res.end();
      });
      return;
    }
    if (req.method === 'GET') {
      const v = objects.get(objKey);
      if (v === undefined) {
        res.writeHead(404);
        res.end();
      } else {
        res.writeHead(200, { 'content-length': v.length });
        res.end(v);
      }
      return;
    }
    if (req.method === 'DELETE') {
      objects.delete(objKey);
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(405);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
  process.env.ARTIFACT_STORE = 's3';
  process.env.S3_BUCKET = 'test-bucket';
  process.env.S3_ACCESS_KEY_ID = 'test-key-id';
  process.env.S3_SECRET_ACCESS_KEY = 'test-secret';
  process.env.S3_REGION = 'us-east-1';
  process.env.S3_ENDPOINT = baseUrl;
  process.env.S3_PREFIX = 'artifacts';
  delete process.env.ARTIFACT_DIR;
  setArtifactStore(null);
});

test.after(() => {
  setArtifactStore(null);
  if (server) server.close();
  for (const k of [
    'ARTIFACT_STORE',
    'S3_BUCKET',
    'S3_ACCESS_KEY_ID',
    'S3_SECRET_ACCESS_KEY',
    'S3_REGION',
    'S3_ENDPOINT',
    'S3_PREFIX'
  ]) delete process.env[k];
});

test('save→list→get→readContent: 全链路往返，SigV4 头存在', async () => {
  const store = getArtifactStore();
  const content = Buffer.from('s3 artifact \x00 binary', 'utf-8');
  const meta = await store.save({
    name: 'note.txt',
    kind: 'text',
    mimeType: 'text/plain',
    content,
    owner: 'alice',
    note: 'demo'
  });
  assert.ok(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(meta.id));
  assert.strictEqual(meta.sizeBytes, content.length);

  // fake S3 里字节对象已就绪：artifacts/files/<id>
  assert.ok(objects.has(`artifacts/files/${meta.id}`), '字节对象应写入 fake S3');
  assert.ok(objects.has('artifacts/index.json'), '索引对象应写入 fake S3');

  // SigV4 头：authorization + x-amz-content-sha256 / x-amz-date
  assert.ok(lastAuthHeader, '应携带 authorization 头');
  assert.ok(lastAuthHeader.startsWith('AWS4-HMAC-SHA256'), '应为 SigV4 签名');
  assert.ok(/SignedHeaders=host;x-amz-content-sha256;x-amz-date/.test(lastAuthHeader));

  const items = await store.list();
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].id, meta.id);

  const got = await store.get(meta.id);
  assert.strictEqual(got.name, 'note.txt');
  assert.strictEqual(got.owner, 'alice');

  const back = await store.readContent(meta.id);
  assert.ok(back.equals(content), '字节应完全一致往返');
});

test('get/readContent 对不存在 id 返回 null；非法 id 被拒绝', async () => {
  const store = getArtifactStore();
  assert.strictEqual(await store.get('00000000-0000-4000-8000-000000000000'), null);
  assert.strictEqual(await store.readContent('00000000-0000-4000-8000-000000000000'), null);
  assert.strictEqual(await store.get('../etc/passwd'), null, '路径遍历 id 必须被拒绝');
  assert.strictEqual(await store.readContent('../etc/passwd'), null);
});

test('remove: 返回 true 并同时清掉字节对象与索引；重复删除返回 false', async () => {
  const store = getArtifactStore();
  const meta = await store.save({
    name: 'x',
    kind: 'k',
    mimeType: 'application/octet-stream',
    content: Buffer.from('delete me'),
    owner: 'carol'
  });
  assert.strictEqual(await store.remove(meta.id), true);
  assert.strictEqual(objects.has(`artifacts/files/${meta.id}`), false, '字节对象应被删除');
  assert.strictEqual(await store.get(meta.id), null);
  assert.strictEqual(await store.readContent(meta.id), null);
  assert.strictEqual(await store.remove(meta.id), false);
});

test('list(runId): 按 runId 过滤', async () => {
  const store = getArtifactStore();
  await store.save({
    name: 'a',
    kind: 'k',
    mimeType: 'text/plain',
    content: Buffer.from('a'),
    owner: 'o',
    runId: 'run-1'
  });
  await store.save({
    name: 'b',
    kind: 'k',
    mimeType: 'text/plain',
    content: Buffer.from('b'),
    owner: 'o',
    runId: 'run-2'
  });
  const r1 = await store.list('run-1');
  assert.strictEqual(r1.length, 1);
  assert.strictEqual(r1[0].name, 'a');
});

test('工厂：ARTIFACT_STORE=s3 但缺凭据时抛错并给出可读信息', () => {
  setArtifactStore(null);
  delete process.env.S3_SECRET_ACCESS_KEY;
  assert.throws(() => getArtifactStore(), /缺少 S3_BUCKET/);
  // 恢复环境，供后续用例（若有）使用
  process.env.S3_SECRET_ACCESS_KEY = 'test-secret';
  setArtifactStore(null);
});

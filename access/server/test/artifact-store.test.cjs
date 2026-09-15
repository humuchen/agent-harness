'use strict';
// 工件存储（Artifact Store）后端单测。
// 覆盖：save 落盘并写索引、list 返回正确元数据、get/readContent 字节往返、
// remove 删除文件与索引条目、非法 id（路径遍历）被安全拒绝。
//
// 运行：pnpm --filter @agent-harness/server run build && node --test test/artifact-store.test.cjs

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const { mkdtempSync, rmSync } = require('node:fs');

const { getArtifactStore, setArtifactStore } = require('../dist/artifact-store.js');

let tmpDir = '';

// 隔离单例：每个用例前重置 store 指向独立临时目录，避免用例间串扰。
test.beforeEach(() => {
  setArtifactStore(null);
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'ah-artifacts-' + Date.now() + '-'));
  process.env.ARTIFACT_DIR = tmpDir;
});

test.afterEach(() => {
  setArtifactStore(null);
  delete process.env.ARTIFACT_DIR;
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* 临时目录清理失败不影响测试结论 */
  }
});

test('save: 写入 Buffer 后 list() 返回 1 项，sizeBytes / mimeType 正确', async () => {
  const store = getArtifactStore();
  const content = Buffer.from('hello artifact', 'utf-8');
  const meta = await store.save({
    name: 'note.txt',
    kind: 'text',
    mimeType: 'text/plain',
    content,
    owner: 'alice',
    note: 'demo'
  });
  assert.ok(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(meta.id), 'id 应为合法 UUID');
  assert.strictEqual(meta.sizeBytes, content.length, 'sizeBytes 应等于字节长度');
  assert.strictEqual(meta.mimeType, 'text/plain');
  assert.strictEqual(meta.owner, 'alice');
  assert.ok(meta.createdAt, 'createdAt 应被自动填充');

  const items = await store.list();
  assert.strictEqual(items.length, 1, 'list 应返回 1 项');
  assert.strictEqual(items[0].id, meta.id);
  assert.strictEqual(items[0].sizeBytes, content.length);
  assert.strictEqual(items[0].mimeType, 'text/plain');
});

test('get/readContent: 元数据与字节可往返读取，非法 id 被拒绝', async () => {
  const store = getArtifactStore();
  const content = Buffer.from('binary\x00payload', 'utf-8');
  const meta = await store.save({
    name: 'bin',
    kind: 'raw',
    mimeType: 'application/octet-stream',
    content,
    owner: 'bob'
  });
  const got = await store.get(meta.id);
  assert.ok(got, 'get 应返回元数据');
  assert.strictEqual(got.id, meta.id);
  assert.strictEqual(got.name, 'bin');

  const back = await store.readContent(meta.id);
  assert.ok(back, 'readContent 应返回 Buffer');
  assert.ok(back.equals(content), '字节应完全一致往返');

  // 路径遍历 id 不得落到文件系统：安全返回 null。
  assert.strictEqual(await store.get('../etc/passwd'), null, '路径遍历 id 必须被拒绝');
  assert.strictEqual(await store.readContent('../etc/passwd'), null, '路径遍历 id 必须被拒绝');
});

test('remove: 返回 true，移除后 get 为 null；重复删除返回 false', async () => {
  const store = getArtifactStore();
  const meta = await store.save({
    name: 'x',
    kind: 'k',
    mimeType: 'application/octet-stream',
    content: Buffer.from('delete me'),
    owner: 'carol'
  });
  const ok = await store.remove(meta.id);
  assert.strictEqual(ok, true, '已存在条目删除应返回 true');
  assert.strictEqual(await store.get(meta.id), null, '删除后索引条目应消失');
  assert.strictEqual(await store.readContent(meta.id), null, '删除后文件应消失');
  assert.strictEqual(await store.remove(meta.id), false, '重复删除不存在 id 返回 false');
});

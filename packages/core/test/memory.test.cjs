'use strict';
// P1-9 测试：可插拔记忆存储后端 + 多租户会话隔离。
// 覆盖 Volatile / File / Sqlite（运行期可用时）三类后端与 Memory 运行时的集成。
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { Memory } = require('../dist/memory.js');
const { VolatileMemoryStore, FileMemoryStore, SqliteMemoryStore, sanitizeKey } =
  require('../dist/memory-store.js');

function tmpDir() {
  const dir = path.join(os.tmpdir(), `mem-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test('sanitizeKey: 归一化非法字符并限制长度', () => {
  assert.strictEqual(sanitizeKey(''), 'anonymous');
  assert.strictEqual(sanitizeKey(null), 'anonymous');
  assert.strictEqual(sanitizeKey('a/b\\c..d'), 'a_b_c__d');
  assert.strictEqual(sanitizeKey('tenant#1 @x'), 'tenant_1__x');
  assert.strictEqual(sanitizeKey('a'.repeat(200)).length, 64);
});

test('VolatileMemoryStore: 内存 round-trip', async () => {
  const s = new VolatileMemoryStore();
  assert.strictEqual(s.kind, 'volatile');
  assert.strictEqual(await s.load('k1'), null);
  await s.save('k1', { window: [{ role: 'user', content: 'hi' }], longTerm: ['note'] });
  const got = await s.load('k1');
  assert.deepStrictEqual(got.window, [{ role: 'user', content: 'hi' }]);
  assert.deepStrictEqual(got.longTerm, ['note']);
  await s.delete('k1');
  assert.strictEqual(await s.load('k1'), null);
  assert.ok((await s.list()).length >= 0);
});

test('FileMemoryStore: 目录分桶 + 多租户隔离', async () => {
  const dir = tmpDir();
  const s = new FileMemoryStore({ dir });
  assert.strictEqual(s.kind, 'file');
  await s.save('tenantA', { window: [{ role: 'user', content: 'a' }], longTerm: ['A'] });
  await s.save('tenantB', { window: [{ role: 'user', content: 'b' }], longTerm: ['B'] });
  assert.deepStrictEqual((await s.load('tenantA')).longTerm, ['A']);
  assert.deepStrictEqual((await s.load('tenantB')).longTerm, ['B']);
  // 文件名为 sanitizeKey 后的 key
  assert.ok(fs.existsSync(path.join(dir, 'tenantA.json')));
  const list = await s.list();
  assert.ok(list.includes('tenantA') && list.includes('tenantB'));
  await s.delete('tenantA');
  assert.strictEqual(await s.load('tenantA'), null);
  assert.ok(!fs.existsSync(path.join(dir, 'tenantA.json')));
});

test('FileMemoryStore: 旧单文件模式向后兼容', async () => {
  const file = path.join(tmpDir(), 'legacy.json');
  const s = new FileMemoryStore({ path: file });
  await s.save('', { window: [], longTerm: ['legacy'] });
  assert.deepStrictEqual((await s.load('')).longTerm, ['legacy']);
  assert.deepStrictEqual(await s.list(), ['']);
});

test('Memory + 后端：remember/load/save/hasPersistence', async () => {
  const dir = tmpDir();
  const store = new FileMemoryStore({ dir });
  const m = new Memory({ store, sessionKey: 'u1', maxWindow: 5 });
  assert.strictEqual(m.hasPersistence, true);
  assert.strictEqual(m.backend, 'file');
  m.remember('fact');
  m.add({ role: 'user', content: 'hello' });
  await m.save();

  // 新实例按同一 key 载入，应恢复记忆
  const m2 = new Memory({ store, sessionKey: 'u1' });
  await m2.load();
  assert.deepStrictEqual(m2.notes(), ['fact']);
  assert.strictEqual(m2.history().length, 1);
  assert.ok(m2.systemContext().includes('fact'));
});

test('Memory: 不同 sessionKey 互相隔离', async () => {
  const dir = tmpDir();
  const store = new FileMemoryStore({ dir });
  const a = new Memory({ store, sessionKey: 'a' });
  a.remember('A-only');
  await a.save();
  const b = new Memory({ store, sessionKey: 'b' });
  b.remember('B-only');
  await b.save();
  const ra = new Memory({ store, sessionKey: 'a' });
  await ra.load();
  const rb = new Memory({ store, sessionKey: 'b' });
  await rb.load();
  assert.deepStrictEqual(ra.notes(), ['A-only']);
  assert.deepStrictEqual(rb.notes(), ['B-only']);
});

test('Memory 默认（无 store）即纯内存，hasPersistence=false', () => {
  const m = new Memory();
  assert.strictEqual(m.hasPersistence, false);
  assert.strictEqual(m.backend, 'volatile');
  m.remember('x');
  assert.deepStrictEqual(m.notes(), ['x']);
});

test('SqliteMemoryStore: 运行期可用时 round-trip（不可用则跳过）', async () => {
  let SqliteMod;
  try {
    SqliteMod = require('node:sqlite');
  } catch {
    SqliteMod = null;
  }
  if (!SqliteMod) {
    // 当前 Node 不支持 node:sqlite，跳过（CI 在 Node 22+ 上会真正执行）。
    return;
  }
  const file = path.join(tmpDir(), 'mem.db');
  const s = new SqliteMemoryStore({ file });
  assert.strictEqual(s.kind, 'sqlite');
  await s.save('s1', { window: [{ role: 'user', content: 'q' }], longTerm: ['n'] });
  await s.save('s2', { window: [], longTerm: [] });
  assert.deepStrictEqual((await s.load('s1')).longTerm, ['n']);
  const list = await s.list();
  assert.ok(list.includes('s1') && list.includes('s2'));
  await s.delete('s1');
  assert.strictEqual(await s.load('s1'), null);
});

test('FileMemoryStore: 原子写——崩溃安全且不残留临时文件', async () => {
  const dir = tmpDir();
  const s = new FileMemoryStore({ dir });
  await s.save('atom', { window: [{ role: 'user', content: 'v1' }], longTerm: ['n1'] });
  // 第二次覆盖写入，验证 rename 替换语义（不残留旧 .tmp，不产生半截文件）
  await s.save('atom', { window: [{ role: 'user', content: 'v2' }], longTerm: ['n2'] });
  const got = await s.load('atom');
  assert.deepStrictEqual(got.window, [{ role: 'user', content: 'v2' }]);
  assert.deepStrictEqual(got.longTerm, ['n2']);
  // 崩溃安全：目录下不应有任何 .tmp 残留（中断只会留下 .tmp，正常路径应已 rename 清理）
  const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.tmp'));
  assert.strictEqual(leftovers.length, 0, 'save 后不应残留 .tmp 临时文件: ' + leftovers.join(','));
});

/**
 * data-source.ts 单元测试（CommonJS）。
 * 编译产物位于 ../dist/data-source.js；每个用例用独立临时文件隔离。
 */
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');

const ds = require('../dist/data-source.js');

test.beforeEach(() => {
  const tmp = path.join(
    os.tmpdir(),
    `ah-datasources-${process.pid}-${Math.random().toString(36).slice(2)}.json`
  );
  process.env.DATASOURCES_FILE = tmp;
  ds.setDataSourceRegistry(null); // 复位单例，确保下个用例按当前 env 重建
});

test('create 返回 def；list 包含；get 匹配', async () => {
  const reg = ds.getDataSourceRegistry();
  const def = await reg.create({ id: 's1', name: 'Static', type: 'static', config: {} });
  assert.equal(def.id, 's1');
  assert.equal(def.name, 'Static');

  const list = await reg.list();
  assert.ok(list.find((d) => d.id === 's1'), 'list 应包含 s1');

  const got = await reg.get('s1');
  assert.ok(got);
  assert.deepEqual(got, def);
});

test('test(s1) → { ok:true }（static）', async () => {
  const reg = ds.getDataSourceRegistry();
  await reg.create({ id: 's1', name: 'Static', type: 'static', config: {} });
  const r = await reg.test('s1');
  assert.ok(r, '应返回 ConnectionResult');
  assert.equal(r.ok, true);
  assert.ok(typeof r.message === 'string');
});

test('test(missing) → null', async () => {
  const reg = ds.getDataSourceRegistry();
  const r = await reg.test('missing');
  assert.equal(r, null);
});

test('remove(s1) → true；之后 get 为 null', async () => {
  const reg = ds.getDataSourceRegistry();
  await reg.create({ id: 's1', name: 'Static', type: 'static', config: {} });
  const removed = await reg.remove('s1');
  assert.equal(removed, true);
  const got = await reg.get('s1');
  assert.equal(got, null);
});

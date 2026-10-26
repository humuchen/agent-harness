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

// ── P1 SSRF 防护 ──

test('SSRF：http 目标私有网段被拒（denylist 默认）', async () => {
  const reg = ds.getDataSourceRegistry();
  await reg.create({ id: 'ssrf1', name: 'Loopback', type: 'http', config: { url: 'http://127.0.0.1:9/x' } });
  const r = await reg.test('ssrf1');
  assert.ok(r);
  assert.equal(r.ok, false);
  assert.match(r.message, /egress blocked/);
});

test('SSRF：postgres 目标（云元数据端点）被拒；DATASOURCE_EGRESS_MODE=open 放行', async () => {
  const reg = ds.getDataSourceRegistry();
  await reg.create({ id: 'ssrf2', name: 'PG', type: 'postgres', config: { host: '169.254.169.254', port: 80 } });
  const r1 = await reg.test('ssrf2');
  assert.ok(r1);
  assert.equal(r1.ok, false);
  assert.match(r1.message, /egress blocked/);
  // 逃生门：显式 open 恢复旧行为（探测失败但不再是 egress blocked）
  process.env.DATASOURCE_EGRESS_MODE = 'open';
  try {
    const r2 = await reg.test('ssrf2');
    assert.ok(r2);
    assert.equal(r2.ok, false);
    assert.doesNotMatch(r2.message, /egress blocked/);
  } finally {
    delete process.env.DATASOURCE_EGRESS_MODE;
  }
});

test('SSRF：非 http(s) scheme 被拒', async () => {
  const reg = ds.getDataSourceRegistry();
  await reg.create({ id: 'ssrf3', name: 'File', type: 'http', config: { url: 'file:///etc/passwd' } });
  const r = await reg.test('ssrf3');
  assert.ok(r);
  assert.equal(r.ok, false);
  assert.match(r.message, /only http\/https allowed/);
});

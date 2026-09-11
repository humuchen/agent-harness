'use strict';
// 浏览器沙箱会话管理器（生命周期 / 内存实现）后端单测。
// 覆盖：create 状态 / 元数据、get / list 副本隔离、destroy 行为、id 唯一性、
//   扩展点 SANDBOX_DOCKER_IMAGE 仅记录模拟日志（不真正 spawn）。
//
// 运行：pnpm --filter @agent-harness/server run build && node --test test/browser-sandbox.test.cjs

const test = require('node:test');
const assert = require('node:assert');

const {
  LocalSandboxManager,
  getSandboxManager,
  setSandboxManager
} = require('../dist/browser-sandbox.js');

// 隔离单例：每个用例前复位，避免用例间串扰。
test.beforeEach(() => setSandboxManager(null));

test('create: 返回 ready 状态且携带 owner / targetUrl，get / list 可查', async () => {
  const m = getSandboxManager();
  const s = await m.create({ owner: 'u1', targetUrl: 'https://example.com' });
  assert.strictEqual(s.status, 'ready', '新会话应为 ready');
  assert.strictEqual(s.owner, 'u1');
  assert.strictEqual(s.targetUrl, 'https://example.com');
  assert.ok(s.id, '应分配 id');
  assert.match(s.createdAt, /^\d{4}-\d{2}-\d{2}T/, 'createdAt 应为 ISO 时间');
  assert.ok(Array.isArray(s.logs) && s.logs.length >= 1, '应写入创建日志');

  const got = m.get(s.id);
  assert.ok(got, 'get 应返回该会话');
  assert.strictEqual(got.id, s.id);
  const listed = m.list();
  assert.strictEqual(listed.length, 1, 'list 应含该会话');
  assert.strictEqual(listed[0].id, s.id);
});

test('create: 两次调用产生不同 id', async () => {
  const m = getSandboxManager();
  const a = await m.create({ owner: 'u1' });
  const b = await m.create({ owner: 'u2' });
  assert.notStrictEqual(a.id, b.id, '两个会话 id 必须唯一');
  assert.strictEqual(m.list().length, 2);
});

test('destroy: 存在则删除并返回 true，get / list 不再含之', async () => {
  const m = getSandboxManager();
  const s = await m.create({ owner: 'u1', targetUrl: 'https://example.com' });
  const ok = m.destroy(s.id);
  assert.strictEqual(ok, true);
  assert.strictEqual(m.get(s.id), undefined, '销毁后 get 应返回 undefined');
  assert.strictEqual(
    m.list().some((x) => x.id === s.id),
    false,
    '销毁后 list 不应再包含'
  );
});

test('destroy: 不存在的 id 返回 false', async () => {
  const m = getSandboxManager();
  assert.strictEqual(m.destroy('nope'), false);
});

test('get / list 返回副本：外部修改不影响内部状态', async () => {
  const m = getSandboxManager();
  const s = await m.create({ owner: 'u1' });
  const got = m.get(s.id);
  got.status = 'destroyed';
  got.logs.push('tampered');
  const again = m.get(s.id);
  assert.strictEqual(again.status, 'ready', '内部状态不应被外部副本破坏');
  assert.strictEqual(again.logs.length, 1, 'logs 副本隔离');
});

test('扩展点 SANDBOX_DOCKER_IMAGE：仅追加模拟日志，不真正 spawn', async () => {
  const m = new LocalSandboxManager({ SANDBOX_DOCKER_IMAGE: 'sandbox:latest' });
  const s = await m.create({ owner: 'u1', targetUrl: 'https://example.com' });
  const simLog = s.logs.find((l) => l.startsWith('[simulated]'));
  assert.ok(simLog, '应设置模拟容器日志');
  assert.ok(simLog.includes('sandbox:latest'), '应记录镜像名');
  assert.strictEqual(s.status, 'ready', '仍是内存模拟，不因镜像变量而改变状态');
});

test('LocalSandboxManager: 无 targetUrl 时回退 about:blank 日志', async () => {
  const m = getSandboxManager();
  const s = await m.create({ owner: 'u1' });
  assert.strictEqual(s.targetUrl, undefined);
  assert.ok(s.logs[0].includes('about:blank'), '无目标 URL 时日志应回退 about:blank');
});

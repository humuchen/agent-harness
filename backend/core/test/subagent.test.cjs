// 零依赖测试（node:test + node:assert）：覆盖 P1-③ SubAgent 子任务分发。
// - SubAgentManager：create（独立 sessionKey / 状态机）/ 并发上限 / get / list
// - 状态流转：markRunning → complete / fail（final 与 error 互斥清空）
// - 清理：cleanup 仅移除已完成/错误实例；cleanupAll 按 parent 隔离
// - 进程单例：initSubAgentManager 幂等 + _resetSubAgentManager

const test = require('node:test');
const assert = require('node:assert');

const sub = require('../dist/subagent/index.js');
const {
  SubAgentManager,
  getSubAgentManager,
  initSubAgentManager,
  _resetSubAgentManager,
} = sub;

test('create：独立 sessionKey（parent:sub:uuid8）+ idle 初始态', () => {
  const m = new SubAgentManager();
  const a = m.create('parent-1');
  assert.strictEqual(a.parentSessionKey, 'parent-1');
  assert.match(a.sessionKey, /^parent-1:sub:[0-9a-f]{8}$/, 'sessionKey 应为 parent:sub:uuid8 形态');
  assert.strictEqual(a.status, 'idle');
  assert.ok(a.id, '实例 id 非空');
  assert.ok(a.createdAt > 0);
  // 不同实例 sessionKey 不冲突
  const b = m.create('parent-1');
  assert.notStrictEqual(a.sessionKey, b.sessionKey);
  assert.notStrictEqual(a.id, b.id);
});

test('并发上限：超过 maxConcurrent 抛错（按 parent 维度计数，仅 running 计入）', () => {
  const m = new SubAgentManager({ maxConcurrent: 2 });
  const a = m.create('p');
  const b = m.create('p');
  m.markRunning(a.id);
  m.markRunning(b.id);
  assert.throws(() => m.create('p'), /并发数已达上限/);
  // 其它 parent 不受影响
  const c = m.create('other');
  assert.ok(c);
  // 完成 a 后可再创建
  m.complete(a.id, 'done');
  assert.ok(m.create('p'));
  // idle 状态不计入活跃数
  const d = m.create('p2');
  assert.strictEqual(m.getActiveCount('p2'), 0);
  void d;
});

test('状态流转：markRunning / complete / fail（final 与 error 互斥）', () => {
  const m = new SubAgentManager();
  const inst = m.create('p');
  m.markRunning(inst.id);
  assert.strictEqual(m.get(inst.id)?.status, 'running');
  m.complete(inst.id, '结果文本');
  let cur = m.get(inst.id);
  assert.strictEqual(cur.status, 'completed');
  assert.strictEqual(cur.final, '结果文本');
  assert.strictEqual(cur.error, undefined);
  // 失败：final 被清空，error 就位
  m.fail(inst.id, 'boom');
  cur = m.get(inst.id);
  assert.strictEqual(cur.status, 'error');
  assert.strictEqual(cur.final, undefined);
  assert.strictEqual(cur.error, 'boom');
  // 未知 id：静默 no-op（不抛错）
  assert.doesNotThrow(() => {
    m.markRunning('nope');
    m.complete('nope', 'x');
    m.fail('nope', 'y');
  });
});

test('list / get：按 parent 过滤', () => {
  const m = new SubAgentManager();
  const a = m.create('p1');
  m.create('p2');
  const list = m.list('p1');
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].id, a.id);
  assert.strictEqual(m.get(a.id)?.parentSessionKey, 'p1');
  assert.strictEqual(m.get('missing'), undefined);
});

test('cleanup：仅移除已完成/错误实例，running/idle 保留', () => {
  const m = new SubAgentManager();
  const done = m.create('p');
  m.complete(done.id, 'ok');
  const failed = m.create('p');
  m.fail(failed.id, 'x');
  const running = m.create('p');
  m.markRunning(running.id);
  const idle = m.create('p');

  m.cleanup(done.id);
  m.cleanup(failed.id);
  m.cleanup(running.id);
  m.cleanup(idle.id);
  m.cleanup('nope');

  assert.strictEqual(m.get(done.id), undefined);
  assert.strictEqual(m.get(failed.id), undefined);
  assert.ok(m.get(running.id), 'running 不得被清理');
  assert.ok(m.get(idle.id), 'idle 不得被清理');
});

test('cleanupAll：按 parent 隔离清理', () => {
  const m = new SubAgentManager();
  const a = m.create('p1');
  const b = m.create('p2');
  m.cleanupAll('p1');
  assert.strictEqual(m.get(a.id), undefined);
  assert.ok(m.get(b.id), '其它 parent 的实例保留');
});

test('进程单例：init 幂等 / reset', () => {
  _resetSubAgentManager();
  assert.strictEqual(getSubAgentManager(), null);
  const m1 = initSubAgentManager({ maxConcurrent: 3 });
  const m2 = initSubAgentManager({ maxConcurrent: 99 });
  assert.strictEqual(m1, m2, '重复 init 返回同一实例');
  assert.strictEqual(m2.maxConcurrent, 3, '重复 init 不得覆盖既有配置');
  _resetSubAgentManager();
  assert.strictEqual(getSubAgentManager(), null);
});

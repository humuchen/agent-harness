'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { Memory } = require('../dist/memory.js');

test('add/history 维护滑动窗口', () => {
  const m = new Memory({ maxWindow: 3 });
  m.add({ role: 'user', content: '1' });
  m.add({ role: 'user', content: '2' });
  m.add({ role: 'user', content: '3' });
  m.add({ role: 'user', content: '4' });
  const h = m.history();
  assert.equal(h.length, 3);
  assert.equal(h[0].content, '2');
  // 不修改返回数组
  h.push({ role: 'user', content: 'x' });
  assert.equal(m.history().length, 3);
});

test('remember/notes/systemContext 注入长期记忆', () => {
  const m = new Memory();
  assert.equal(m.notes().length, 0);
  m.remember('用户偏好把环境命名为 feature-* 分支');
  assert.deepStrictEqual(m.notes(), ['用户偏好把环境命名为 feature-* 分支']);
  assert.match(m.systemContext(), /用户偏好/);
});

test('save/load 跨实例持久化（含长期记忆）', async () => {
  const file = path.join(os.tmpdir(), `ah-mem-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  try {
    const a = new Memory({ persistencePath: file });
    a.remember('长期偏好 X');
    a.add({ role: 'user', content: 'hello' });
    await a.save();

    const b = new Memory({ persistencePath: file });
    assert.equal(b.hasPersistence, true);
    await b.load();
    assert.deepStrictEqual(b.notes(), ['长期偏好 X']);
    assert.equal(b.history().length, 1);
    assert.equal(b.history()[0].content, 'hello');
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test('hasPersistence 正确反映配置', () => {
  assert.equal(new Memory().hasPersistence, false);
  assert.equal(new Memory({ persistencePath: '/tmp/x' }).hasPersistence, true);
});

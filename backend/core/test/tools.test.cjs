'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { ToolRegistry, objectParams } = require('../dist/tools.js');

test('register/call/schemas/has', async () => {
  const r = new ToolRegistry();
  r.register('add', '求和', objectParams({ a: { type: 'number' }, b: { type: 'number' } }, ['a', 'b']), (args) => Number(args.a) + Number(args.b), 'harness');
  assert.equal(r.has('add'), true);
  assert.equal(r.has('nope'), false);
  assert.deepStrictEqual(r.schemas().length, 1);
  assert.equal(r.schemas()[0].name, 'add');
  assert.equal(r.schemas()[0].source, 'harness');
  const out = await r.call('add', { a: 2, b: 3 });
  assert.equal(out, 5);
});

test('call 未知工具抛错', async () => {
  const r = new ToolRegistry();
  await assert.rejects(() => r.call('ghost', {}), /Unknown tool/);
});

test('mergeFrom 合并另一个注册表（不覆盖同名）', () => {
  const a = new ToolRegistry();
  const b = new ToolRegistry();
  a.register('x', 'a-x', objectParams({}), () => 'a');
  b.register('x', 'b-x', objectParams({}), () => 'b');
  b.register('y', 'b-y', objectParams({}), () => 'b');
  a.mergeFrom(b);
  assert.equal(a.has('y'), true);
  // 同名不被覆盖
  assert.equal(a.schemas().find((s) => s.name === 'x').description, 'a-x');
});

test('unregister 移除工具', () => {
  const r = new ToolRegistry();
  r.register('tmp', 't', objectParams({}), () => 1);
  assert.equal(r.has('tmp'), true);
  r.unregister('tmp');
  assert.equal(r.has('tmp'), false);
});

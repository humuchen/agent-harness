// 零依赖测试（node:test + node:assert）：覆盖内置基础工具（calculator / datetime /
// web_fetch / filesystem）。直接 require 编译后的叶子模块，避免引入 MCP SDK 运行时依赖。
const test = require('node:test');
const assert = require('node:assert');

const { ToolRegistry } = require('../dist/tools.js');
const { registerBuiltinTools, evaluateExpression } = require('../dist/builtins/index.js');

function reg() {
  const r = new ToolRegistry();
  registerBuiltinTools(r, { fsRoot: process.cwd() });
  return r;
}

test('registerBuiltinTools 注册 builtin__ 前缀工具', () => {
  const names = reg().schemas().map((s) => s.name);
  for (const n of [
    'builtin__calculator',
    'builtin__datetime_now',
    'builtin__datetime_convert',
    'builtin__datetime_add',
    'builtin__web_fetch',
    'builtin__fs_read',
    'builtin__fs_list',
    'builtin__fs_search',
  ]) {
    assert.ok(names.includes(n), 'missing ' + n);
  }
});

test('calculator 求值正确（优先级 / 函数 / 一元负号）', async () => {
  const r = await reg().call('builtin__calculator', { expression: 'pow(2,10) + sqrt(16) - 3.5' });
  assert.strictEqual(String(r), '1024.5');
  const r2 = await reg().call('builtin__calculator', { expression: '2 + 3 * 4 - -5' });
  assert.strictEqual(String(r2), '19');
});

test('evaluateExpression 直接计算', () => {
  assert.strictEqual(evaluateExpression('(1+2)*3'), 9);
  assert.strictEqual(evaluateExpression('sqrt(9)'), 3);
  // 一元负号优先级高于 ^，按「带符号数」约定：-2^2 = (-2)^2 = 4（与 -2^-3 自洽）
  assert.strictEqual(evaluateExpression('-2^2'), 4);
  assert.strictEqual(evaluateExpression('-2^-3'), -0.125);
});

test('calculator 拒绝代码注入（不执行任意代码）', async () => {
  const r = await reg().call('builtin__calculator', { expression: 'process.exit(1)' });
  assert.ok(String(r).startsWith('error:'));
});

test('calculator 除零报错', async () => {
  const r = await reg().call('builtin__calculator', { expression: '1/0' });
  assert.ok(String(r).startsWith('error:'));
});

test('datetime_now 返回 iso 与 epoch', async () => {
  const r = await reg().call('builtin__datetime_now', {});
  const obj = JSON.parse(r);
  assert.ok(obj.iso);
  assert.ok(typeof obj.epoch === 'number');
});

test('datetime_add 正确偏移时间', async () => {
  const r = await reg().call('builtin__datetime_add', {
    time: '2026-01-01T00:00:00Z',
    amount: 1,
    unit: 'days',
  });
  const obj = JSON.parse(r);
  assert.ok(obj.iso.startsWith('2026-01-02'));
});

test('fs 阻断路径穿越', async () => {
  const r = await reg().call('builtin__fs_list', { path: '../../' });
  assert.ok(String(r).startsWith('error:'));
});

test('web_fetch 拒绝非 http(s) 协议', async () => {
  const r = await reg().call('builtin__web_fetch', { url: 'file:///etc/passwd' });
  assert.ok(String(r).startsWith('error:'));
});

test('enabled=false 时不注册任何内置工具', () => {
  const r = new ToolRegistry();
  registerBuiltinTools(r, { enabled: false });
  assert.strictEqual(r.schemas().length, 0);
});

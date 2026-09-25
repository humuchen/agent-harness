'use strict';
// sandbox 输出字节上限 + 容器孤儿清理（稳定性修复配套测试）。
// 关注：createCappedAccumulator 截断语义（字节级、UTF-8 安全、标记可见）、
// SANDBOX_OUTPUT_MAX_BYTES env、buildContainerArgs 的 --name 注入（rm -f 清理前提）。

const test = require('node:test');
const assert = require('node:assert');

const {
  createCappedAccumulator,
  SANDBOX_OUTPUT_MAX_BYTES,
  buildContainerArgs,
} = require('../dist/builtins/sandbox.js');

test('createCappedAccumulator：限额内正常累积', () => {
  const acc = createCappedAccumulator('stdout', 100);
  acc.push('hello');
  acc.push(' world');
  assert.strictEqual(acc.toString(), 'hello world');
  assert.strictEqual(acc.truncated, false);
});

test('createCappedAccumulator：超限截断并追加标记（后续输出丢弃）', () => {
  const acc = createCappedAccumulator('stdout', 10);
  acc.push('12345');
  acc.push('67890'); // 恰好 10 字节
  assert.strictEqual(acc.toString(), '1234567890');
  assert.strictEqual(acc.truncated, false);
  acc.push('X'); // 超限 → 截断标记
  const out = acc.toString();
  assert.ok(out.startsWith('1234567890'));
  assert.ok(out.includes('truncated'), '应包含截断标记：' + out);
  acc.push('YYYYYYYY'); // 标记后继续丢弃
  assert.strictEqual(acc.toString(), out, '截断后不再累积');
});

test('createCappedAccumulator：UTF-8 多字节按字节安全截断（无残缺字符）', () => {
  const acc = createCappedAccumulator('stdout', 7);
  // '中' = 3 字节；7 字节 = 中+中+1 字节 → 第三个「中」被安全丢弃
  acc.push('中中中中');
  const out = acc.toString();
  assert.ok(out.includes('中中'), '应保留完整的多字节字符：' + JSON.stringify(out));
  assert.ok(!out.includes('\uFFFD'), '不应出现替换字符');
  assert.ok(out.includes('truncated'));
});

test('createCappedAccumulator：limit=0 表示不限（旧行为）', () => {
  const acc = createCappedAccumulator('stdout', 0);
  for (let i = 0; i < 100; i++) acc.push('x'.repeat(100));
  assert.strictEqual(acc.truncated, false);
  assert.strictEqual(acc.toString().length, 10000);
});

test('SANDBOX_OUTPUT_MAX_BYTES 缺省 1MB', () => {
  // 测试进程未设置该 env（其他用例不读它），缺省应为 1MB
  assert.strictEqual(SANDBOX_OUTPUT_MAX_BYTES, 1048576);
});

test('buildContainerArgs：req.containerName 注入 --name（rm -f 清理前提）', () => {
  const opts = { backend: 'docker' };
  const req = {
    command: 'sh',
    args: ['-c', 'echo hi'],
    cwd: '/work',
    timeoutMs: 1000,
    containerName: 'ah-sb-test-123',
  };
  const args = buildContainerArgs(opts, req);
  const idx = args.indexOf('--name');
  assert.ok(idx >= 0, '应包含 --name 参数');
  assert.strictEqual(args[idx + 1], 'ah-sb-test-123');
});

test('buildContainerArgs：未提供 containerName 时不注入 --name（向后兼容）', () => {
  const args = buildContainerArgs(
    { backend: 'docker' },
    { command: 'sh', args: [], cwd: '/work', timeoutMs: 1000 }
  );
  assert.strictEqual(args.indexOf('--name'), -1);
});

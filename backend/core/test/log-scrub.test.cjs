'use strict';
// 回归测试（P0 日志脱敏）：验证 secrets 经 structLog 统一出口被脱敏，不再裸泄露。
// 覆盖：
//  - scrubFields 键名级 + 模式级脱敏（含嵌套）
//  - redactValue 单值模式级脱敏
//  - structLog 在统一出口自动脱敏 message 与 fields（无需调用点手动包裹）

const test = require('node:test');
const assert = require('node:assert');

const { scrubFields, redactValue, installScrubber } = require('../dist/log-scrub.js');
const { structLog } = require('../dist/telemetry.js');

test('scrubFields：敏感键名被脱敏', () => {
  const out = scrubFields({ password: 'hunter2', token: 'abc', note: '公开信息' });
  assert.equal(out.password, '[REDACTED]');
  assert.equal(out.token, '[REDACTED]');
  assert.equal(out.note, '公开信息');
});

test('scrubFields：敏感值模式被脱敏（sk-/JWT/手机号/身份证）', () => {
  const out = scrubFields({
    note: 'key=sk-Abcdefghij1234567890xyz 与 jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc',
  });
  assert.equal(out.note, '[REDACTED]');
});

test('scrubFields：嵌套对象与数组递归脱敏', () => {
  const out = scrubFields({
    user: { apiKey: 'sk-SecretValue1234567890', name: 'alice' },
    list: [{ secret: 'x' }, { safe: 'y' }],
  });
  assert.equal(out.user.apiKey, '[REDACTED]');
  assert.equal(out.user.name, 'alice');
  assert.equal(out.list[0].secret, '[REDACTED]');
  assert.equal(out.list[1].safe, 'y');
});

test('redactValue：模式命中即脱敏，否则原样返回', () => {
  assert.equal(redactValue('sk-Abcdefghij1234567890xyz'), '[REDACTED]');
  assert.equal(redactValue('我的手机 13812345678'), '[REDACTED]');
  assert.equal(redactValue('普通文本'), '普通文本');
  assert.equal(redactValue(12345), 12345);
});

test('structLog：统一出口自动脱敏 fields 与 message（P0 修复核心）', () => {
  const lines = [];
  const orig = console.log;
  console.log = (s) => lines.push(s);
  try {
    structLog('info', 'login 用 password=hunter2 尝试', {
      password: 'hunter2',
      token: 'tok-123',
      note: 'sk-Abcdefghij1234567890xyz',
      safe: '可见',
    });
  } finally {
    console.log = orig;
  }
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  const serialized = lines[0];
  // 关键断言：原始密钥既不应出现在 message 也不应出现在 fields
  assert.ok(!serialized.includes('hunter2'), '明文 password 不应出现在日志');
  assert.ok(!serialized.includes('tok-123'), '明文 token 不应出现在日志');
  assert.ok(!serialized.includes('sk-Abcdefghij1234567890xyz'), '明文 sk- 不应出现在日志');
  // 脱敏标记应出现
  assert.ok(serialized.includes('[REDACTED]'), '应至少出现一次 [REDACTED]');
  assert.equal(entry.safe, '可见');
});

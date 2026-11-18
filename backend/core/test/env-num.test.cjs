// envNum / envStr / envBool 回归测试（P1-6 core 侧配置辅助）。
// 关键覆盖：0 值不被 falsy 覆盖（修复 `Number(env) || default` 的核心 bug）。

'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { envNum, envStr, envBool } = require('../dist/loadEnv.js');

function withEnv(vars, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = String(v);
  }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('envNum: 未设 → fallback', () => {
  withEnv({ TEST_NUM_X: undefined }, () => {
    assert.strictEqual(envNum('TEST_NUM_X', 42), 42);
  });
});

test('envNum: 空字符串 → fallback', () => {
  withEnv({ TEST_NUM_X: '' }, () => {
    assert.strictEqual(envNum('TEST_NUM_X', 42), 42);
  });
});

test('envNum: 0 不被 falsy 覆盖（核心修复）', () => {
  withEnv({ TEST_NUM_X: '0' }, () => {
    // 旧实现 Number("0") || 42 = 0 || 42 = 42（bug）
    // envNum 正确返回 0
    assert.strictEqual(envNum('TEST_NUM_X', 42), 0);
  });
});

test('envNum: 正常数值', () => {
  withEnv({ TEST_NUM_X: '123' }, () => {
    assert.strictEqual(envNum('TEST_NUM_X', 42), 123);
  });
  withEnv({ TEST_NUM_X: '-5.5' }, () => {
    assert.strictEqual(envNum('TEST_NUM_X', 42), -5.5);
  });
});

test('envNum: 非法值（NaN/Infinity）→ fallback', () => {
  withEnv({ TEST_NUM_X: 'abc' }, () => {
    assert.strictEqual(envNum('TEST_NUM_X', 42), 42);
  });
  withEnv({ TEST_NUM_X: 'Infinity' }, () => {
    assert.strictEqual(envNum('TEST_NUM_X', 42), 42);
  });
});

test('envStr: 未设/空 → fallback；有值 → 原值', () => {
  withEnv({ TEST_STR_X: undefined }, () => {
    assert.strictEqual(envStr('TEST_STR_X', 'def'), 'def');
  });
  withEnv({ TEST_STR_X: '' }, () => {
    assert.strictEqual(envStr('TEST_STR_X', 'def'), 'def');
  });
  withEnv({ TEST_STR_X: 'hello' }, () => {
    assert.strictEqual(envStr('TEST_STR_X', 'def'), 'hello');
  });
});

test('envBool: true/1/on → true；其余 → false；未设 → fallback', () => {
  for (const v of ['true', '1', 'on', 'TRUE', 'On']) {
    withEnv({ TEST_BOOL_X: v }, () => {
      assert.strictEqual(envBool('TEST_BOOL_X', false), true, `${v} should be true`);
    });
  }
  for (const v of ['false', '0', 'off', 'no']) {
    withEnv({ TEST_BOOL_X: v }, () => {
      assert.strictEqual(envBool('TEST_BOOL_X', true), false, `${v} should be false`);
    });
  }
  // 空字符串视为「未设」→ 返回 fallback（与 envStr/envNum 一致）
  withEnv({ TEST_BOOL_X: '' }, () => {
    assert.strictEqual(envBool('TEST_BOOL_X', true), true, '空字符串应返回 fallback');
  });
  withEnv({ TEST_BOOL_X: undefined }, () => {
    assert.strictEqual(envBool('TEST_BOOL_X', true), true);
    assert.strictEqual(envBool('TEST_BOOL_X', false), false);
  });
});

'use strict';
/**
 * core 主门面导出面快照棘轮（P2-11 阶段一，RFC 见 docs/proposals/core-api-surface-rfc.md）。
 *
 * 推广 guardrails-surface.test.cjs（P1#21 G1）的模式到主门面：
 * - 371 个运行时导出符号经基线文件锁定（index-surface.snapshot.json）；
 * - 存量锁死、增量显式——新导出未登记基线 CI 红，漏导出 CI 红；
 * - 基线更新走 scripts/update-core-surface.cjs（显式 diff，PR 人工确认）。
 *
 * 三层断言（RFC §5）：
 * ① 基线 ⊆ 实测（漏导出 = 红，报缺失清单）；
 * ② 实测 ⊆ 基线（未登记新增 = 红，报越权清单）；
 * ③ 排序一致（防 diff 噪声）。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const facade = require('../dist/index.js');
const baselinePath = path.join(__dirname, 'index-surface.snapshot.json');

const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
const expected = baseline.runtime;
const actual = Object.keys(facade).sort();

test('基线文件存在且含 371 个运行时导出', () => {
  assert.ok(Array.isArray(expected), '基线 runtime 字段应为数组');
  assert.ok(expected.length > 300, `基线导出数应 >300，实际 ${expected.length}`);
});

test('① 基线 ⊆ 实测：无导出缺失（子模块 export * 断链即红）', () => {
  const actualSet = new Set(actual);
  const missing = expected.filter((k) => !actualSet.has(k));
  assert.deepEqual(missing, [], `门面缺失导出（子模块断链？）：${missing.join(', ')}`);
});

test('② 实测 ⊆ 基线：新增导出必须显式登记基线（防隐式扩面）', () => {
  const expectedSet = new Set(expected);
  const untracked = actual.filter((k) => !expectedSet.has(k));
  assert.deepEqual(
    untracked,
    [],
    `未登记的新增导出：${untracked.join(', ')}\n` +
      '请运行 `node scripts/update-core-surface.cjs` 更新基线，或确认是否应公开。'
  );
});

test('③ 排序一致（防 diff 噪声）', () => {
  assert.deepEqual(actual, expected, '导出顺序与基线不一致（应按字母序）');
});

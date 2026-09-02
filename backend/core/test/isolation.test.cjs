// 零依赖测试（node:test + node:assert）：覆盖 P2.d per-job 隔离级别解析 sandbox/isolation.ts。
// 关注：决策链 card → 租户策略 → env 取更强者；跨行业不可信升级最低到 os；normalizeLevel 归一。

const test = require('node:test');
const assert = require('node:assert');

const iso = require('../dist/sandbox/isolation.js');

test('resolveIsolationBackend：env 默认生效', () => {
  assert.strictEqual(iso.resolveIsolationBackend({ envBackend: 'container' }), 'container');
  // 无 envBackend 时默认降级到 os（安全基线提升）
  assert.strictEqual(iso.resolveIsolationBackend({}), 'os');
});

test('resolveIsolationBackend：card 声明强于 env', () => {
  const card = { id: 'c', name: 'c', domain: 'generic', version: '1', health: {}, isolation: 'os' };
  assert.strictEqual(iso.resolveIsolationBackend({ card, envBackend: 'local' }), 'os');
});

test('resolveIsolationBackend：租户策略强制级别强于 env', () => {
  const tenantPolicy = { isolation: 'container' };
  assert.strictEqual(
    iso.resolveIsolationBackend({ tenantPolicy, envBackend: 'local' }),
    'container'
  );
});

test('resolveIsolationBackend：card 与租户策略取更强者', () => {
  const card = { id: 'c', name: 'c', domain: 'generic', version: '1', health: {}, isolation: 'os' };
  const tenantPolicy = { isolation: 'container' };
  assert.strictEqual(
    iso.resolveIsolationBackend({ card, tenantPolicy, envBackend: 'local' }),
    'container'
  );
});

test('resolveIsolationBackend：跨行业不可信升级最低到 os（金融租户 + 教育 agent）', () => {
  const card = { id: 'edu', name: 'edu', domain: 'education', version: '1', health: {} };
  const out = iso.resolveIsolationBackend({
    card,
    tenantDomain: 'finance',
    envBackend: 'local',
  });
  // 跨行业升级后至少 os，但 shell 兜底会抬升到 container
  assert.ok(['os', 'container'].includes(out), `expected os or container, got ${out}`);
});

test('resolveIsolationBackend：跨行业升级不误伤同域（金融租户 + 金融 agent）', () => {
  const card = { id: 'fin', name: 'fin', domain: 'finance', version: '1', health: {} };
  const out = iso.resolveIsolationBackend({
    card,
    tenantDomain: 'finance',
    envBackend: 'local',
  });
  // 同域不触发跨行业升级；shell 兜底仍会抬到 os
  assert.strictEqual(out, 'os');
});

test('normalizeLevel：后端字符串归一', () => {
  assert.strictEqual(iso.normalizeLevel('docker'), 'container');
  assert.strictEqual(iso.normalizeLevel('podman'), 'container');
  assert.strictEqual(iso.normalizeLevel('os'), 'os');
  assert.strictEqual(iso.normalizeLevel('native'), 'os');
  assert.strictEqual(iso.normalizeLevel('local'), 'local');
  assert.strictEqual(iso.normalizeLevel('none'), 'none');
  assert.strictEqual(iso.normalizeLevel(undefined), undefined);
});

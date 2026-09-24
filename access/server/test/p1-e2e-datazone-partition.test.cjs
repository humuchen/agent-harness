'use strict';
// P1 端到端：设 TENANT_DATA_ZONE 后，accounts / memory / history 三个 SQLite 库
// 都应通过 resolveTenantDbPath 落到 <dir>/<zone>/<basename>，实现合规域物理隔离。
//
// 直接 require 编译后的 dist 模块 + node:test，避免引入运行时依赖。
// 用 /tmp 下的临时目录做隔离测试，避免污染仓库 data/。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resolveTenantDbPath } = require('../../../backend/core/dist/db-adapter.js');

// 每个用例独立的临时目录
function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'p1-e2e-'));
}
function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ok */ }
}

test('resolveTenantDbPath: medical zone 把三个 DB 文件都落到 medical/ 子目录', () => {
  const dir = tempDir();
  try {
    const accountsBase = path.join(dir, 'accounts.db');
    const memoryBase = path.join(dir, 'memory.db');
    const historyBase = path.join(dir, 'chat-history.db');

    const accountsFile = resolveTenantDbPath(accountsBase, 'medical');
    const memoryFile = resolveTenantDbPath(memoryBase, 'medical');
    const historyFile = resolveTenantDbPath(historyBase, 'medical');

    assert.ok(accountsFile.includes(path.normalize('/medical/')), 'accounts 应落 medical/ 子目录，实际：' + accountsFile);
    assert.ok(memoryFile.includes(path.normalize('/medical/')), 'memory 应落 medical/ 子目录，实际：' + memoryFile);
    assert.ok(historyFile.includes(path.normalize('/medical/')), 'history 应落 medical/ 子目录，实际：' + historyFile);
    // basename 保留
    assert.strictEqual(path.basename(accountsFile), 'accounts.db');
    assert.strictEqual(path.basename(memoryFile), 'memory.db');
    assert.strictEqual(path.basename(historyFile), 'chat-history.db');
  } finally {
    cleanup(dir);
  }
});

test('resolveTenantDbPath: general / 未设 = 原路径不变（三个 DB 全兼容）', () => {
  const dir = tempDir();
  try {
    const accountsBase = path.join(dir, 'accounts.db');
    const memoryBase = path.join(dir, 'memory.db');
    const historyBase = path.join(dir, 'chat-history.db');

    assert.strictEqual(resolveTenantDbPath(accountsBase), accountsBase);
    assert.strictEqual(resolveTenantDbPath(memoryBase, 'general'), memoryBase);
    assert.strictEqual(resolveTenantDbPath(historyBase), historyBase);
  } finally {
    cleanup(dir);
  }
});

test('resolveTenantDbPath: 不同 zone 落到不同子目录（跨合规域物理隔离）', () => {
  const dir = tempDir();
  try {
    const accountsBase = path.join(dir, 'accounts.db');
    const medical = resolveTenantDbPath(accountsBase, 'medical');
    const financial = resolveTenantDbPath(accountsBase, 'financial');
    assert.notStrictEqual(medical, financial, '不同 zone 应落不同目录');
    assert.ok(medical.includes(path.normalize('/medical/')), 'medical 实际：' + medical);
    assert.ok(financial.includes(path.normalize('/financial/')), 'financial 实际：' + financial);
  } finally {
    cleanup(dir);
  }
});

test('resolveTenantDbPath: 非法 zone（路径穿越）回退原路径', () => {
  const dir = tempDir();
  try {
    const base = path.join(dir, 'accounts.db');
    assert.strictEqual(resolveTenantDbPath(base, '../etc'), base, '拒绝 ../ 穿越');
    assert.strictEqual(resolveTenantDbPath(base, 'a/b'), base, '拒绝 /');
    assert.strictEqual(resolveTenantDbPath(base, 'x y'), base, '拒绝空格');
  } finally {
    cleanup(dir);
  }
});

test('TENANT_DATA_ZONE env 与 resolveTenantContext 联动（端到端语义）', () => {
  const { resolveTenantContext } = require('../../../backend/core/dist/tenant.js');
  const old = process.env.TENANT_DATA_ZONE;
  process.env.TENANT_DATA_ZONE = 'medical';
  try {
    const ctx = resolveTenantContext({ tenantId: 'acme' });
    assert.strictEqual(ctx?.dataZone, 'medical', 'env 应自动派生 dataZone');
    // 与 resolveTenantDbPath 联动：ctx.dataZone 直接作为分区键
    const file = resolveTenantDbPath('./data/accounts.db', ctx.dataZone);
    assert.ok(file.includes(path.normalize('/medical/')), 'ctx.dataZone 应驱动 DB 分区，实际：' + file);
  } finally {
    if (old === undefined) delete process.env.TENANT_DATA_ZONE;
    else process.env.TENANT_DATA_ZONE = old;
  }
});

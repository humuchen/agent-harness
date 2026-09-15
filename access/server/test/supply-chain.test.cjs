'use strict';
// CI 供应链扫描器（supply-chain）单测。
// 覆盖：scan() 汇总计数与依赖收集、sign() 确定性（同输入同签名 / 不同依赖不同签名）。
//
// 运行：pnpm --filter @agent-harness/server run build && node --test test/supply-chain.test.cjs

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { getSupplyChainScanner, setSupplyChainScanner } = require('../dist/supply-chain.js');

// 隔离单例：每个用例前复位 scanner，避免用例间串扰（含 env / repoRoot 串扰）。
test.beforeEach(() => setSupplyChainScanner(null));

function writePkg(dir, pkg) {
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg), 'utf-8');
}

test('scan: 汇总计数与依赖收集正确', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-'));
  writePkg(tmpDir, {
    name: 't',
    dependencies: { a: '^1.0.0' },
    devDependencies: { b: '2.0.0' }
  });

  const report = await getSupplyChainScanner(tmpDir).scan();

  assert.strictEqual(report.summary.total, 2, 'total 应为 2');
  assert.strictEqual(report.summary.prod, 1, 'prod 应为 1');
  assert.strictEqual(report.summary.dev, 1, 'dev 应为 1');

  const a = report.dependencies.find((d) => d.name === 'a');
  const b = report.dependencies.find((d) => d.name === 'b');
  assert.ok(a && a.dev === false, 'a 应为生产依赖 (dev:false)');
  assert.ok(b && b.dev === true, 'b 应为开发依赖 (dev:true)');
  assert.ok(a.integrity && a.integrity.startsWith('sha512-'), 'a.integrity 以 sha512- 开头');
  assert.ok(b.integrity && b.integrity.startsWith('sha512-'), 'b.integrity 以 sha512- 开头');
});

test('sign: 相同报告两次签名一致；不同依赖签名不同', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-'));
  writePkg(tmpDir, {
    name: 't',
    dependencies: { a: '^1.0.0' },
    devDependencies: { b: '2.0.0' }
  });

  const scanner = getSupplyChainScanner(tmpDir);
  const report = await scanner.scan();

  const s1 = scanner.sign(report);
  const s2 = scanner.sign(report);
  assert.strictEqual(s1, s2, '相同输入签名应完全一致（确定性）');
  assert.match(s1, /^[0-9a-f]{64}$/, 'HMAC-SHA256 hex 应为 64 位十六进制');

  // 不同依赖 → 不同签名（克隆报告并追加一个依赖再签名）。
  const report2 = JSON.parse(JSON.stringify(report));
  report2.dependencies.push({ name: 'c', version: '3.0.0', dev: false });
  const s3 = scanner.sign(report2);
  assert.notStrictEqual(s1, s3, '依赖不同应产生不同签名');
});

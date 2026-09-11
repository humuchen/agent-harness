'use strict';
/**
 * Brand 配置单测（P3-1）。
 * 覆盖：
 * - BRAND_DEFAULT 兜底值
 * - 环境变量覆盖
 * - 文件覆盖优先级
 * - URL 安全校验（同源 vs 白名单 vs 拒绝）
 * - saveBrandConfig 写回
 * - getBrandConfig 单例缓存
 *
 * 运行：pnpm --filter @agent-harness/server run build && node --test access/server/test/brand.test.cjs
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { test } = require('node:test');

const mod = require('../dist/brand.js');

let tmpDir;

test.beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brand-test-'));
  mod.setBrandConfig(null); // 重置单例
});

test.afterEach(() => {
  mod.setBrandConfig(null);
});

// ── BRAND_DEFAULT ──
test('BRAND_DEFAULT 提供兜底值', () => {
  assert.strictEqual(mod.BRAND_DEFAULT.productName, 'Agent Harness');
  assert.strictEqual(mod.BRAND_DEFAULT.primaryColor, '#2997FF');
  assert.ok(mod.BRAND_DEFAULT.loginTagline);
  assert.ok(mod.BRAND_DEFAULT.footer);
});

// ── getBrandConfig: 无自定义 → 返回默认 ──
test('getBrandConfig: 无自定义配置时返回默认值', () => {
  const cfg = mod.getBrandConfig({ BRAND_STORE_DIR: tmpDir });
  assert.strictEqual(cfg.productName, 'Agent Harness');
});

// ── 环境变量覆盖 ──
test('getBrandConfig: 环境变量覆盖 productName', () => {
  const cfg = mod.getBrandConfig({
    BRAND_STORE_DIR: tmpDir,
    BRAND_PRODUCT_NAME: 'My Enterprise Agent'
  });
  assert.strictEqual(cfg.productName, 'My Enterprise Agent');
});

// ── 文件覆盖优先级 --- 文件 > 环境变量 > 默认
test('getBrandConfig: 文件覆盖优先于环境变量', () => {
  const brandFile = path.join(tmpDir, 'brand.json');
  fs.writeFileSync(brandFile, JSON.stringify({
    productName: 'File Brand',
    primaryColor: '#FF0000'
  }));
  const cfg = mod.getBrandConfig({
    BRAND_STORE_DIR: tmpDir,
    BRAND_PRODUCT_NAME: 'Env Brand'
  });
  assert.strictEqual(cfg.productName, 'File Brand');
  assert.strictEqual(cfg.primaryColor, '#FF0000');
});

// ── URL 安全校验 ──
test('isBrandUrlSafe: 相对路径安全', () => {
  assert.strictEqual(mod.isBrandUrlSafe('/logo.png'), true);
  assert.strictEqual(mod.isBrandUrlSafe('/assets/logo.svg'), true);
});

test('isBrandUrlSafe: localhost 安全', () => {
  assert.strictEqual(mod.isBrandUrlSafe('http://localhost:3000/logo.png'), true);
  assert.strictEqual(mod.isBrandUrlSafe('http://127.0.0.1:3000/logo.png'), true);
});

test('isBrandUrlSafe: 白名单域名安全', () => {
  const env = { BRAND_ALLOWED_DOMAINS: 'cdn.example.com' };
  assert.strictEqual(mod.isBrandUrlSafe('https://cdn.example.com/logo.png', env), true);
});

// ── URL 拒绝非白名单域名 ──
test('isBrandUrlSafe: 非白名单域名被拒绝', () => {
  assert.strictEqual(mod.isBrandUrlSafe('https://evil.com/logo.png'), false);
});

// ── saveBrandConfig ──
test('saveBrandConfig: 写入 brand.json 并更新单例', () => {
  const cfg = {
    ...mod.BRAND_DEFAULT,
    productName: 'Saved Brand',
    logoUrl: '/logo.png'
  };
  mod.saveBrandConfig(cfg, tmpDir);

  const file = path.join(tmpDir, 'brand.json');
  assert.ok(fs.existsSync(file));
  const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
  assert.strictEqual(raw.productName, 'Saved Brand');

  // 单例已更新
  mod.setBrandConfig(null);
  const read = mod.getBrandConfig({ BRAND_STORE_DIR: tmpDir });
  assert.strictEqual(read.productName, 'Saved Brand');
});

// ── saveBrandConfig 拒绝不安全 URL ──
test('saveBrandConfig: 拒绝非白名单 logoUrl', () => {
  const cfg = {
    ...mod.BRAND_DEFAULT,
    logoUrl: 'https://evil.com/logo.png'
  };
  assert.throws(() => mod.saveBrandConfig(cfg, tmpDir), /not in the allowed origins/);
});

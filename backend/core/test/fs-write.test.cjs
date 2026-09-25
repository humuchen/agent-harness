'use strict';
// builtin__fs_write 单测（P-交付闭环：内置写文件能力）。
// 覆盖：文本写入并读回、嵌套目录自动创建、base64 二进制往返、
// 路径逃逸（../ 与绝对路径）拒绝、超限拒绝、encoding 缺省为 utf-8。
//
// 运行：pnpm --filter @agent-harness/core run build && node --test test/fs-write.test.cjs

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const { mkdtempSync, rmSync, readFileSync } = require('node:fs');

const { ToolRegistry } = require('../dist/tools.js');
const { registerBuiltinTools } = require('../dist/builtins/index.js');

function makeRegistry(root) {
  const reg = new ToolRegistry();
  registerBuiltinTools(reg, { root: root, webEnabled: false, weatherEnabled: false, docExportEnabled: false });
  return reg;
}

test('fs_write: 文本写入后 fs_read 可读回，缺省 encoding 为 utf-8', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ah-fsw-'));
  try {
    const reg = makeRegistry(root);
    const out = await reg.call('builtin__fs_write', { path: 'hello.txt', content: '你好，交付文件' });
    const parsed = JSON.parse(out);
    assert.strictEqual(parsed.path, path.join('hello.txt'));
    assert.strictEqual(parsed.bytes, Buffer.byteLength('你好，交付文件', 'utf-8'));
    const back = await reg.call('builtin__fs_read', { path: 'hello.txt' });
    assert.strictEqual(back, '你好，交付文件');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fs_write: 嵌套路径父目录自动创建', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ah-fsw-'));
  try {
    const reg = makeRegistry(root);
    const out = await reg.call('builtin__fs_write', {
      path: 'a/b/c/report.md',
      content: '# 报告'
    });
    assert.ok(JSON.parse(out).ok !== false);
    assert.strictEqual(readFileSync(path.join(root, 'a/b/c/report.md'), 'utf-8'), '# 报告');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fs_write: base64 二进制往返字节一致', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ah-fsw-'));
  try {
    const reg = makeRegistry(root);
    // 1x1 透明 PNG 的字节
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    await reg.call('builtin__fs_write', { path: 'pixel.png', content: png.toString('base64'), encoding: 'base64' });
    const written = readFileSync(path.join(root, 'pixel.png'));
    assert.ok(written.equals(png), '写入字节应与解码结果一致');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fs_write: ../ 路径逃逸与绝对路径被拒绝', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ah-fsw-'));
  try {
    const reg = makeRegistry(root);
    const esc = await reg.call('builtin__fs_write', { path: '../escape.txt', content: 'x' });
    assert.ok(esc.startsWith('error:'), '相对逃逸应报错：' + esc);
    const abs = await reg.call('builtin__fs_write', { path: '/tmp/escape2.txt', content: 'x' });
    assert.ok(abs.startsWith('error:'), '绝对路径应报错：' + abs);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fs_write: 超过 2MB 上限被拒绝', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ah-fsw-'));
  try {
    const reg = makeRegistry(root);
    const big = 'x'.repeat(2 * 1024 * 1024 + 1);
    const out = await reg.call('builtin__fs_write', { path: 'big.txt', content: big });
    assert.ok(out.startsWith('error: content too large'), '超限应报错：' + out.slice(0, 60));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

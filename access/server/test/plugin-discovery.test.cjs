'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 覆盖 P2 插件目录自动发现：discoverPluginEntries 扫描给定目录，收集含 dist/index.js 的入口。
const { discoverPluginEntries } = require('../dist/plugin-bootstrap.js');

test('discoverPluginEntries: 收集含 dist/index.js 的插件入口', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-plugins-'));
  try {
    // 合法插件 a / b
    fs.mkdirSync(path.join(root, 'plugin-a', 'dist'), { recursive: true });
    fs.writeFileSync(path.join(root, 'plugin-a', 'dist', 'index.js'), 'module.exports = {}');
    fs.mkdirSync(path.join(root, 'plugin-b', 'dist'), { recursive: true });
    fs.writeFileSync(path.join(root, 'plugin-b', 'dist', 'index.js'), 'module.exports = {}');
    // 仅 src 无 dist：不应被发现
    fs.mkdirSync(path.join(root, 'plugin-no-dist', 'src'), { recursive: true });
    // 空目录：不应被发现
    fs.mkdirSync(path.join(root, 'empty'), { recursive: true });

    const found = discoverPluginEntries(root);
    assert.strictEqual(found.length, 2);
    // 按目录名排序，顺序确定
    assert.deepStrictEqual(
      found.map((p) => path.basename(path.dirname(p))),
      ['plugin-a', 'plugin-b']
    );
    for (const f of found) assert.ok(f.endsWith(path.join('dist', 'index.js')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('discoverPluginEntries: 目录不存在返回空数组', () => {
  assert.deepStrictEqual(discoverPluginEntries('/nonexistent/ah/plugins'), []);
});

test('discoverPluginEntries: 扫描一层不递归', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-plugins-'));
  try {
    // 嵌套两层：dist 在更深的层，不应被一层扫描发现
    fs.mkdirSync(path.join(root, 'nested', 'pkg', 'dist'), { recursive: true });
    fs.writeFileSync(path.join(root, 'nested', 'pkg', 'dist', 'index.js'), 'module.exports={}');
    assert.deepStrictEqual(discoverPluginEntries(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// filesystem symlink 逃逸防护守护测试：
// safeReal 对「最近存在的祖先」做 realpath 解析后校验前缀 —— root 内指向外部的
// 符号链接读取必须被拒绝；普通文件/不存在路径的既有语义不变。
// Windows 上目录链接用 junction（无需特权）；POSIX 用 dir symlink。创建失败则跳过。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ToolRegistry } = require('../dist/tools.js');
const { registerFilesystem } = require('../dist/builtins/filesystem.js');

// realpath 化 tmpdir：Windows 短文件名（8.3）与 realpath 展开名不一致会污染路径断言。
const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'fs-symlink-'));
const root = path.join(tmp, 'root');
const outside = path.join(tmp, 'outside');
fs.mkdirSync(root);
fs.mkdirSync(outside);
fs.writeFileSync(path.join(root, 'inside.txt'), 'hello-inside', 'utf-8');
fs.writeFileSync(path.join(root, 'sub-deep.txt'), 'deep', 'utf-8');
fs.writeFileSync(path.join(outside, 'secret.txt'), 'TOPSECRET', 'utf-8');
fs.mkdirSync(path.join(root, 'sub'));
fs.writeFileSync(path.join(root, 'sub', 'nested.txt'), 'nested', 'utf-8');

let linkCreated = false;
const linkPath = path.join(root, 'leak');
try {
  fs.symlinkSync(outside, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
  linkCreated = true;
} catch {
  // 无权限/不支持 symlink 的环境：跳过链接相关用例
}

const registry = new ToolRegistry();
registerFilesystem(registry, { root });

test('基线：root 内普通文件可读（语义不回归）', async () => {
  const out = await registry.call('builtin__fs_read', { path: 'inside.txt' });
  assert.strictEqual(out, 'hello-inside');
  const nested = await registry.call('builtin__fs_read', { path: 'sub/nested.txt' });
  assert.strictEqual(nested, 'nested');
});

if (linkCreated) {
  test('symlink 逃逸被拒：经 root 内链接读外部文件报错且不泄露内容', async () => {
    const out = await registry.call('builtin__fs_read', { path: 'leak/secret.txt' });
    assert.ok(String(out).startsWith('error:'), `应报错，实际：${out}`);
    assert.ok(!String(out).includes('TOPSECRET'), '不得泄露外部文件内容');
  });

  test('fs_list 经 symlink 列举外部目录被拒', async () => {
    const out = await registry.call('builtin__fs_list', { path: 'leak' });
    assert.ok(String(out).startsWith('error:'), `应报错，实际：${out}`);
    assert.ok(!String(out).includes('secret.txt'), '不得泄露外部目录条目');
  });

  test('fs_search 内容搜索不读出 root 外文件', async () => {
    const out = await registry.call('builtin__fs_search', {
      content_contains: 'TOPSECRET',
      path: '.'
    });
    const parsed = JSON.parse(String(out));
    assert.strictEqual(parsed.count, 0, `不得命中外部文件，实际：${out}`);
  });

  test('root 内正常内容搜索不受影响', async () => {
    const out = await registry.call('builtin__fs_search', {
      content_contains: 'hello-inside',
      path: '.'
    });
    const parsed = JSON.parse(String(out));
    assert.ok(parsed.matches.includes('inside.txt'), `应命中 inside.txt，实际：${out}`);
  });
}

test('词法校验仍在：越界/绝对路径返回 error（工具内捕获为 error: 字符串）', async () => {
  const esc = await registry.call('builtin__fs_read', { path: '../escape.txt' });
  assert.match(String(esc), /^error: .*(escapes root|absolute paths)/);
  const abs = await registry.call('builtin__fs_read', { path: outside });
  assert.match(String(abs), /^error: .*absolute paths/);
});

// 零依赖测试（node:test + node:assert）：覆盖沙箱 shell 执行的三道闸门
// —— 命令白名单、作用域（cwd 越界）、执行前确认，以及 shell 运算符禁用。
// 直接 require 编译后的叶子模块，避免引入额外运行时依赖。
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const { ToolRegistry } = require('../dist/tools.js');
const { registerShell } = require('../dist/builtins/shell.js');

const TOOL = 'builtin__shell_exec';
function call(reg, args) {
  return reg.call(TOOL, args);
}

test('白名单：未列出的命令被拒绝', async () => {
  const reg = new ToolRegistry();
  registerShell(reg, { root: os.tmpdir(), allowedCommands: ['echo'], requireConfirmation: false });
  const r = await call(reg, { command: 'rm', args: ['-rf', '/'] });
  assert.match(r, /command not in allowlist/);
});

test('白名单：列出的命令成功执行并返回退出码', async () => {
  const reg = new ToolRegistry();
  registerShell(reg, { root: os.tmpdir(), allowedCommands: ['echo'], requireConfirmation: false });
  const r = await call(reg, { command: 'echo', args: ['hello-sandbox'] });
  assert.match(r, /hello-sandbox/);
  assert.match(r, /exit code 0/);
});

test('作用域：cwd 越界被拒绝', async () => {
  const reg = new ToolRegistry();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shelltest-'));
  registerShell(reg, { root, allowedCommands: ['ls'], requireConfirmation: false });
  const r = await call(reg, { command: 'ls', cwd: '../../etc' });
  assert.match(r, /cwd escapes sandbox root/);
});

test('作用域：cwd 在 root 内允许执行', async () => {
  const reg = new ToolRegistry();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shelltest2-'));
  const sub = fs.mkdtempSync(path.join(root, 'sub-'));
  registerShell(reg, { root, allowedCommands: ['pwd'], requireConfirmation: false });
  const r = await call(reg, { command: 'pwd', cwd: path.basename(sub) });
  assert.match(r, /exit code 0/);
});

test('确认：requireConfirmation=true 且策略缺省（deny）时拒绝', async () => {
  const reg = new ToolRegistry();
  registerShell(reg, { root: os.tmpdir(), allowedCommands: ['echo'], requireConfirmation: true });
  const r = await call(reg, { command: 'echo', args: ['x'] });
  assert.match(r, /execution denied by confirmation policy/);
});

test('确认：自定义函数返回 true 时放行，并传入请求上下文', async () => {
  const reg = new ToolRegistry();
  let seen = null;
  registerShell(reg, {
    root: os.tmpdir(),
    allowedCommands: ['echo'],
    requireConfirmation: true,
    confirm: async (req) => {
      seen = req;
      return true;
    },
  });
  const r = await call(reg, { command: 'echo', args: ['approved'] });
  assert.match(r, /approved/);
  assert.ok(seen && seen.command === 'echo');
  assert.deepStrictEqual(seen.args, ['approved']);
});

test('shell 运算符默认拒绝（防命令注入）', async () => {
  const reg = new ToolRegistry();
  registerShell(reg, { root: os.tmpdir(), allowedCommands: ['echo'], requireConfirmation: false });
  const r = await call(reg, { command: 'echo', args: ['a', ';', 'rm', '-rf', '/'] });
  assert.match(r, /shell operators are disabled/);
});

test('allowShellOperators=true 时允许管道', async () => {
  const reg = new ToolRegistry();
  registerShell(reg, {
    root: os.tmpdir(),
    allowedCommands: ['echo', 'wc'],
    requireConfirmation: false,
    allowShellOperators: true,
  });
  // 注意：默认实现只 spawn 单条命令 + 参数，参数里的 | 不会触发真实管道，
  // 这里仅验证「允许运算符」分支不再拦截，命令被正常派发（echo 打印整行）。
  const r = await call(reg, { command: 'echo', args: ['a b c | wc'] });
  assert.match(r, /exit code 0/);
});

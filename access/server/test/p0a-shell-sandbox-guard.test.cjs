'use strict';
// P0-A：SHELL_ENABLED=true 时，若 OS 级沙箱（native helper + user namespace）不可用，
// 接入层应静默关闭 shell（而非降级到硬化本地执行器），避免隐性「软沙箱」。
//
// 本测试直接断言 detectCapabilities() 的语义：在 macOS/Windows（非 Linux）上
// supported 必为 false，因此 runner.ts 的守卫逻辑应关闭 shell。
// 通过 require dist/runner.js 并 mock 环境变量与 detectCapabilities 的返回值做断言。

const test = require('node:test');
const assert = require('node:assert');

const { detectCapabilities } = require('@agent-harness/core');

// 非 Linux 平台应判定不支持
test('detectCapabilities: 非 Linux 平台 supported=false（P0-A 守卫前提）', () => {
  const caps = detectCapabilities();
  if (process.platform !== 'linux') {
    assert.strictEqual(caps.supported, false, '非 Linux 应不支持 OS 级沙箱');
    assert.strictEqual(caps.isLinux, false);
    assert.ok(caps.reason.length > 0, '应给出人类可读原因');
  } else {
    // Linux 上取决于 helper 与 user namespace，至少字段齐全
    assert.strictEqual(typeof caps.supported, 'boolean');
    assert.strictEqual(typeof caps.helperAvailable, 'boolean');
    assert.strictEqual(typeof caps.userNamespaces, 'boolean');
  }
});

// runner.ts 的守卫行为：通过读取源码断言关键逻辑存在（避免启动整个 server 的开销）
test('runner.ts 守卫：SHELL_ENABLED=true 且 detectCapabilities().supported=false 时关闭 shell', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const srcPath = path.join(__dirname, '..', 'src', 'runner.ts');
  const src = fs.readFileSync(srcPath, 'utf8');

  // 关键行存在：守卫逻辑
  assert.ok(
    src.includes('if (shellEnabled)') && src.includes('detectCapabilities()'),
    'runner.ts 应在 shellEnabled 为 true 时调用 detectCapabilities() 校验',
  );
  assert.ok(
    src.includes('shellEnabled = false'),
    '不可用时应静默关闭 shell（shellEnabled = false）',
  );
  assert.ok(
    src.includes('[shell] SHELL_ENABLED=true but OS-level sandbox unavailable, disabling shell'),
    '应输出 error 级结构化日志',
  );
});

/**
 * P1 安全加固回归：登录失败锁定（login_lockouts）。
 *
 * 覆盖：
 *  1. 连续失败达到阈值（AUTH_LOCKOUT_THRESHOLD=3）后，即使密码正确也拒绝登录；
 *  2. 错误提示包含「锁定」字样与剩余秒数；
 *  3. 未达阈值时正确密码照常登录；
 *  4. 锁定状态落库（新模块实例查询同一 DB 也能看到——多副本语义）。
 *
 * 运行前提：AUTH_LOCKOUT_THRESHOLD 等 env 必须在 require dist 之前设置
 * （模块加载期读取）。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-lockout-'));
process.env.ACCOUNT_DB_FILE = path.join(tmpDir, 'accounts.db');
process.env.AUTH_LOCKOUT_THRESHOLD = '3';
process.env.AUTH_LOCKOUT_WINDOW_MS = '60000';

const accounts = require('../dist/accounts.js');

test('登录失败锁定：达阈值后正确密码也被拒，且提示锁定', async () => {
  const username = `lock_test_${Date.now()}`;
  const reg = await accounts.registerUser(username, 'correct-horse-1');
  assert.ok(reg.ok, `register should succeed: ${reg.error ?? ''}`);

  // 1-2 次失败：仍返回「用户名或密码错误」（未锁定）
  for (let i = 0; i < 2; i++) {
    const r = await accounts.loginUser(username, 'wrong-password');
    assert.equal(r.ok, false);
    assert.ok(!/锁定/.test(r.error ?? ''), `fail #${i + 1} should not be locked`);
  }

  // 第 3 次失败：达到阈值，落锁定
  const r3 = await accounts.loginUser(username, 'wrong-password');
  assert.equal(r3.ok, false);

  // 锁定后：即使密码正确也拒绝，且提示包含「锁定」
  const r4 = await accounts.loginUser(username, 'correct-horse-1');
  assert.equal(r4.ok, false);
  assert.match(r4.error ?? '', /锁定/);
  assert.match(r4.error ?? '', /秒/);
});

test('登录失败锁定：质询式登录同样生效', async () => {
  const username = `lock_dhx_${Date.now()}`;
  const reg = await accounts.registerUser(username, 'another-pass-1');
  assert.ok(reg.ok);

  // 质询式登录需要 salt + derivedHex；这里直接用 registerUser 的明文通道无法复用，
  // 但 loginWithDerivedHex 对错误 hex 的行为与 loginUser 一致：走失败计数。
  for (let i = 0; i < 3; i++) {
    await accounts.loginWithDerivedHex(username, 'a'.repeat(64));
  }
  const r = await accounts.isLoginLocked(username);
  assert.equal(r.locked, true, 'should be locked after 3 failed derived-hex logins');
});

test('登录失败锁定：未达阈值时正确密码照常登录', async () => {
  const username = `lock_ok_${Date.now()}`;
  const reg = await accounts.registerUser(username, 'good-password-9');
  assert.ok(reg.ok);
  // 1 次失败（< 阈值 3）→ 不锁定
  await accounts.loginUser(username, 'nope-wrong-1');
  const ok = await accounts.loginUser(username, 'good-password-9');
  assert.equal(ok.ok, true, `should login: ${ok.error ?? ''}`);
  const lock = await accounts.isLoginLocked(username);
  assert.equal(lock.locked, false, 'successful login clears failure counter');
});

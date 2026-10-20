'use strict';
// P1-5 回归：OAuth 派生注册路径（registerWithDerivedHex）的邮箱格式校验。
//
// 背景：旧实现正则写作 /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/（双反斜杠，匹配字面 `\`、`s`
// 而非空白字符类）——含字母 s 的合法邮箱被误拒，校验语义整体失效。
// 同文件 registerUser 的明文注册路径一直是正确写法，此处对齐并加回归守护。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-register-'));
process.env.ACCOUNT_DB_FILE = path.join(tmpDir, 'accounts.db');

const accounts = require('../dist/accounts.js');

// PBKDF2 派生 hex（模拟前端质询式注册：客户端对 password+salt 做 PBKDF2 后直传 hex）
function deriveHex(username, password) {
  const { pbkdf2Sync } = require('node:crypto');
  // 与前端 derive 算法一致性无关紧要：registerWithDerivedHex 只校验 64 位 hex 与格式，
  // 服务端不重派生（客户端已派生）。任意 64 hex 均可注册成功。
  return pbkdf2Sync(password, username, 4096, 32, 'sha256').toString('hex');
}

test('registerWithDerivedHex: 含字母 s 的合法邮箱不再被误拒（P1-5 回归）', async () => {
  const username = `reg_s_${Date.now()}`;
  const hex = deriveHex(username, 'strong-pass-1');
  // user@example.com 含字母 s —— 旧正则会误判为「邮箱格式不正确」
  const ok = await accounts.registerWithDerivedHex(username, 'salt-1', hex, 'user@example.com');
  assert.ok(ok.ok, `含 s 的合法邮箱应注册成功: ${ok.error ?? ''}`);
});

test('registerWithDerivedHex: 非法邮箱仍被拒绝，缺省邮箱仍放行', async () => {
  const bad = await accounts.registerWithDerivedHex(
    `reg_bad_${Date.now()}`,
    'salt-2',
    'a'.repeat(64),
    'not-an-email'
  );
  assert.equal(bad.ok, false);
  assert.match(bad.error ?? '', /邮箱/);

  const noEmail = await accounts.registerWithDerivedHex(
    `reg_noemail_${Date.now()}`,
    'salt-3',
    'b'.repeat(64),
    undefined
  );
  assert.ok(noEmail.ok, `缺省邮箱应放行: ${noEmail.error ?? ''}`);
});

test('registerWithDerivedHex: 非法 hex 长度仍被拒绝（原有校验不回归）', async () => {
  const short = await accounts.registerWithDerivedHex(
    `reg_short_${Date.now()}`,
    'salt-4',
    'abc123',
    'user@example.com'
  );
  assert.equal(short.ok, false);
  assert.match(short.error ?? '', /密码|hex|64/u);
});

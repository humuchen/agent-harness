/**
 * 插件清单签名校验单测（零依赖，node --test，require 编译产物 dist）。
 * 覆盖：HMAC 签名/验签 roundtrip、篡改即验签失败、ed25519 非对称验签。
 */

const test = require('node:test');
const assert = require('node:assert');
const core = require('../dist/plugin/signature.js');

function makeManifest() {
  return {
    id: 'market-weather',
    version: '1.2.0',
    name: '天气插件',
    description: '插件市场分发的天气 agent',
    domain: 'generic',
    transport: 'local',
    entry: 'dist/index.js',
    capabilities: [{ id: 'weather' }],
    dependencies: [],
    permissions: [],
  };
}

test('HMAC 签名 + 验签 roundtrip', () => {
  const m = makeManifest();
  const secret = 'demo-secret';
  const sig = core.signManifest(m, secret);
  assert.ok(typeof sig === 'string' && sig.length > 0, '应返回 hex 签名');
  assert.equal(core.verifyManifest(m, sig, secret, 'hmac'), true, '正确密钥应验签通过');
  assert.equal(
    core.verifyManifest(m, sig, 'wrong-secret', 'hmac'),
    false,
    '错误密钥应验签失败'
  );
});

test('篡改签名即验签失败', () => {
  const m = makeManifest();
  const sig = core.signManifest(m, 'demo-secret');
  assert.equal(core.verifyManifest(m, sig + 'ff', 'demo-secret', 'hmac'), false);
});

test('清单内容变化导致验签失败（防投毒）', () => {
  const m = makeManifest();
  const secret = 'demo-secret';
  const sig = core.signManifest(m, secret);
  const tampered = { ...m, capabilities: [{ id: 'weather' }, { id: 'evil' }] };
  assert.equal(core.verifyManifest(tampered, sig, secret, 'hmac'), false);
});

test('ed25519 非对称验签：发布者私钥签名、平台公钥验签', () => {
  // 用 node 内置 crypto 现场生成密钥对，演示「发布者私钥签名 / 平台公钥验签」链路。
  const { generateKeyPairSync, createPrivateKey, sign: nodeSign, verify: nodeVerify } = require('node:crypto');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const m = makeManifest();
  // 复刻 signature.ts 的 canonicalizeManifest 作为确定性输入。
  const canonical = core.canonicalizeManifest(m);
  const derSign = nodeSign(null, Buffer.from(canonical, 'utf8'), privateKey);
  const hexSig = derSign.toString('hex');
  const pemPub = publicKey.export({ type: 'spki', format: 'pem' });
  assert.equal(core.verifyManifest(m, hexSig, pemPub, 'ed25519'), true, '合法公钥应验签通过');
  // 用另一把私钥签名应失败。
  const other = generateKeyPairSync('ed25519').privateKey;
  const badSig = nodeSign(null, Buffer.from(canonical, 'utf8'), other).toString('hex');
  assert.equal(core.verifyManifest(m, badSig, pemPub, 'ed25519'), false, '错误公钥应验签失败');
});

// ── P2-10：本地 sidecar 签名校验（verifyLocalPluginSignature）──
// 覆盖：无 sig 文件放行、sig 存在+密钥匹配通过、sig 存在+密钥不匹配拒绝、
//       sig 存在但未配密钥放行+告警、篡改 manifest 后 sig 失效。

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const { verifyLocalPluginSignature } = require('../dist/plugin/loader.js');
const { signManifest } = require('../dist/plugin/signature.js');

const SECRET = 'test-sidecar-secret';

function tmpPluginDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-sig-'));
  const pluginDir = path.join(dir, 'my-plugin');
  fs.mkdirSync(pluginDir, { recursive: true });
  return pluginDir;
}

function writeManifest(dir, m) {
  const p = path.join(dir, 'manifest.json');
  fs.writeFileSync(p, JSON.stringify(m), 'utf8');
  return p;
}

function writeSig(dir, content) {
  fs.writeFileSync(path.join(dir, 'manifest.json.sig'), content, 'utf8');
}

test('LocalSig: 无 sidecar sig 文件 → no-sig（本地可信目录向后兼容）', () => {
  const dir = tmpPluginDir();
  try {
    const m = makeManifest();
    const mp = writeManifest(dir, m);
    const r = verifyLocalPluginSignature(m, mp, { signKey: SECRET });
    assert.strictEqual(r.outcome, 'no-sig');
  } finally { fs.rmSync(path.dirname(dir), { recursive: true, force: true }); }
});

test('LocalSig: sig 存在 + 密钥匹配 → verified', () => {
  const dir = tmpPluginDir();
  try {
    const m = makeManifest();
    const mp = writeManifest(dir, m);
    writeSig(dir, signManifest(m, SECRET));
    const r = verifyLocalPluginSignature(m, mp, { signKey: SECRET });
    assert.strictEqual(r.outcome, 'verified');
  } finally { fs.rmSync(path.dirname(dir), { recursive: true, force: true }); }
});

test('LocalSig: sig 存在 + 密钥不匹配 → failed', () => {
  const dir = tmpPluginDir();
  try {
    const m = makeManifest();
    const mp = writeManifest(dir, m);
    writeSig(dir, signManifest(m, SECRET));
    const r = verifyLocalPluginSignature(m, mp, { signKey: 'wrong-secret' });
    assert.strictEqual(r.outcome, 'failed');
    assert.ok(r.reason && r.reason.includes('失败'));
  } finally { fs.rmSync(path.dirname(dir), { recursive: true, force: true }); }
});

test('LocalSig: 篡改 manifest 后 sig 失效 → failed', () => {
  const dir = tmpPluginDir();
  try {
    const m = makeManifest();
    const mp = writeManifest(dir, m);
    writeSig(dir, signManifest(m, SECRET));
    // 篡改：改 capabilities（签名覆盖的字段）
    const tampered = { ...m, capabilities: [{ id: 'evil' }] };
    const r = verifyLocalPluginSignature(tampered, mp, { signKey: SECRET });
    assert.strictEqual(r.outcome, 'failed');
  } finally { fs.rmSync(path.dirname(dir), { recursive: true, force: true }); }
});

test('LocalSig: sig 存在但未配密钥 → no-key（放行但告警）', () => {
  const dir = tmpPluginDir();
  try {
    const m = makeManifest();
    const mp = writeManifest(dir, m);
    writeSig(dir, signManifest(m, SECRET));
    const r = verifyLocalPluginSignature(m, mp, { signKey: undefined });
    assert.strictEqual(r.outcome, 'no-key');
    assert.ok(r.reason && r.reason.includes('未配置'));
  } finally { fs.rmSync(path.dirname(dir), { recursive: true, force: true }); }
});

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

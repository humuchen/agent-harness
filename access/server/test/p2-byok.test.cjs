/**
 * BYOK P2 增强单元测试：密钥轮换提醒(P2.3) / 配额与用量(P2.2) / 多 Key 负载故障转移(P2.4) / OAuth PKCE(P2.1)。
 *
 * 依赖：先 `pnpm --filter @agent-harness/server build` 生成 dist。
 * 运行：`node --test test/p2-byok.test.cjs`（在 access/server 目录下）。
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.AH_CRYPTO_KEY = 'a'.repeat(64);

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-p2-'));
const pkDb = path.join(tmpDir, 'provider-keys.db');
process.env.PROVIDER_KEYS_DB_FILE = pkDb;

const { getDbAdapter } = require('@agent-harness/core');
const pk = require('../dist/provider-keys');
const oauth = require('../dist/oauth');

const OWNER = 'p2user';

describe('P2.3 密钥轮换提醒', () => {
  test('computeNeedsRotation 按阈值判定', () => {
    // 默认 KEY_ROTATION_DAYS=90，90 天前 → 需轮换
    assert.strictEqual(
      pk.computeNeedsRotation(Date.now() - 1000 * 60 * 60 * 24 * 100),
      true
    );
    // 刚刚更新 → 不需轮换
    assert.strictEqual(pk.computeNeedsRotation(Date.now()), false);
  });

  test('列表回显 needsRotation（按 updated_at 回推）', async () => {
    await pk.saveUserProviderKey(OWNER, 'openrouter', { apiKey: 'sk-or-fresh-1234' });
    // 刚保存：不应提示轮换
    let list = await pk.listUserProviderKeys(OWNER);
    assert.strictEqual(list[0].needsRotation, false);

    // 直接把 updated_at 回推到 200 天前（模拟长期未轮换）
    const db = getDbAdapter({ file: pkDb });
    await db
      .prepare(
        'UPDATE user_provider_keys SET updated_at = ? WHERE owner = ? AND provider = ?'
      )
      .run(Date.now() - 1000 * 60 * 60 * 24 * 200, OWNER, 'openrouter');

    list = await pk.listUserProviderKeys(OWNER);
    assert.strictEqual(list[0].needsRotation, true);
  });
});

describe('P2.4 多 Key 负载/故障转移', () => {
  test('保存多 Key 后解析出全部明文 Key（主+附加）', async () => {
    await pk.saveUserProviderKey(OWNER, 'openrouter', {
      keys: ['sk-or-main-1111', 'sk-or-extra-2222', 'sk-or-extra-3333']
    });
    const row = await pk.getUserProviderKey(OWNER, 'openrouter');
    assert.ok(row);
    assert.strictEqual(row.keyCipher ? true : false, true);
    assert.strictEqual(row.extraKeys.length, 2);

    const list = await pk.listUserProviderKeys(OWNER);
    assert.strictEqual(list[0].keyCount, 3);

    // 解析链返回 apiKeys 全部 + apiKey 为主 Key
    const cred = await pk.resolveRunCredential(OWNER, { model: 'openrouter/gpt' });
    assert.strictEqual(cred.source, 'user');
    assert.strictEqual(cred.apiKey, 'sk-or-main-1111');
    assert.deepStrictEqual(cred.apiKeys, [
      'sk-or-main-1111',
      'sk-or-extra-2222',
      'sk-or-extra-3333'
    ]);
  });

  test('单 Key 兼容（无 keys，仅 apiKey）解析出 apiKeys=[apiKey]', async () => {
    await pk.saveUserProviderKey(OWNER, 'openai', { apiKey: 'sk-ai-single-9999' });
    const cred = await pk.resolveRunCredential(OWNER, { model: 'openai/gpt' });
    assert.deepStrictEqual(cred.apiKeys, ['sk-ai-single-9999']);
    assert.strictEqual(cred.apiKey, 'sk-ai-single-9999');
  });
});

describe('P2.2 配额与用量（quotaEngine）', () => {
  test('recordUsage 累计 token/cost，getUsage 回读', () => {
    const { quotaEngine } = require('@agent-harness/core');
    quotaEngine.recordUsage('p2quota', { tokens: 100, cost: 0.01 });
    quotaEngine.recordUsage('p2quota', { tokens: 50, cost: 0.02 });
    const u = quotaEngine.getUsage('p2quota');
    assert.strictEqual(u.tokensUsed, 150);
    assert.strictEqual(u.costUsed, 0.03);
  });
});

describe('P2.1 OpenRouter OAuth（PKCE）框架', () => {
  test('未配置 client_id → config.enabled=false（零副作用）', () => {
    const cfg = oauth.getOAuthConfig({ headers: {} }, 'openrouter');
    assert.strictEqual(cfg.enabled, false);
  });

  test('配置 client_id → config.enabled=true 且含端点', () => {
    process.env.OPENROUTER_OAUTH_CLIENT_ID = 'test-client-id';
    const cfg = oauth.getOAuthConfig(
      { headers: { host: 'localhost:4173' } },
      'openrouter'
    );
    assert.strictEqual(cfg.enabled, true);
    assert.ok(cfg.clientId, 'clientId 应回显');
    assert.ok(cfg.authorizeUrl, 'authorizeUrl 应存在');
    assert.ok(cfg.redirectUri, 'redirectUri 应存在');
    delete process.env.OPENROUTER_OAUTH_CLIENT_ID;
  });

  test('exchangeOAuthCode 换票并落库为 provider key', async () => {
    process.env.OPENROUTER_OAUTH_CLIENT_ID = 'test-client-id';
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ access_token: 'sk-or-oauth-access-1234' })
    });
    try {
      const saved = await oauth.exchangeOAuthCode({
        provider: 'openrouter',
        code: 'c',
        codeVerifier: 'v',
        redirectUri: 'http://localhost:4173/api/account/oauth/callback',
        owner: 'oauthuser'
      });
      assert.ok(saved.keyHint, '应返回掩码 keyHint');
      assert.notStrictEqual(saved.keyHint, 'sk-or-oauth-access-1234');
      const list = await pk.listUserProviderKeys('oauthuser');
      assert.strictEqual(list.length, 1);
      assert.strictEqual(list[0].provider, 'openrouter');
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.OPENROUTER_OAUTH_CLIENT_ID;
    }
  });
});

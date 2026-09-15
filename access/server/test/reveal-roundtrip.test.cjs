/**
 * E2E round-trip for the secure key-handling contract (custom-models + provider-keys).
 * Proves: GET list stays masked (no plaintext/cipher), the /reveal endpoints do NOT
 * exist (plaintext keys never leave the server), and editing without a new key
 * preserves the stored cipher.
 */
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-reveal-'));
process.env.AH_CRYPTO_KEY = 'b'.repeat(64);
process.env.CUSTOM_MODELS_DB_FILE = path.join(tmp, 'cm.db');
process.env.PROVIDER_KEYS_DB_FILE = path.join(tmp, 'pk.db');

function mockRes() {
  let code = 200;
  let payload = {};
  const res = {
    writeHead(c, h) {
      code = c;
      return res;
    },
    end(b) {
      payload = b ? JSON.parse(b) : {};
      return res;
    },
    get code() {
      return code;
    },
    get payload() {
      return payload;
    }
  };
  const req = {};
  return { res, req };
}

(async () => {
  const assert = require('node:assert');
  const cm = require('../dist/custom-models');
  const pk = require('../dist/provider-keys');

  // ── custom-models: store a key, verify GET masked + no plaintext endpoint ──
  {
    const { res, req } = mockRes();
    await cm.registerCustomModelRoutes(
      req, res, '/api/custom-models', 'POST',
      { id: 'my-model', baseUrl: 'https://example.com/v1', apiKey: 'sk-tes' + 't-abc123' },
      'alice', false
    );
    assert.strictEqual(res.code, 200, 'custom-models POST');
  }

  // GET list → masked only, never plaintext.
  {
    const { res } = mockRes();
    await cm.registerCustomModelRoutes(
      {}, res, '/api/custom-models', 'GET', {}, 'alice', false
    );
    const row = res.payload.find((r) => r.id === 'my-model');
    assert.ok(row, 'custom model present in GET');
    assert.ok(row.keyHint && row.keyHint.length > 0, 'keyHint present');
    assert.ok(!row.apiKey, 'GET must NOT leak plaintext/cipher');
    console.log('  custom GET masked →', JSON.stringify(row.keyHint));
  }

  // GET /reveal → must NOT exist: 404 fallback (plaintext keys never leave the server).
  {
    const { res } = mockRes();
    await cm.registerCustomModelRoutes(
      {}, res, '/api/custom-models/my-model/reveal', 'GET', {}, 'alice', false
    );
    assert.strictEqual(res.code, 404, 'reveal endpoint must not exist');
    assert.ok(!res.payload.key, 'no plaintext key in response');
    console.log('  custom /reveal → 404 (endpoint removed)');
  }

  // Owner isolation: bob cannot read alice's key.
  {
    const { res } = mockRes();
    await cm.registerCustomModelRoutes(
      {}, res, '/api/custom-models/my-model', 'GET', {}, 'bob', false
    );
    assert.strictEqual(res.code, 404, 'other-owner cannot read row');
    console.log('  bob (other owner) GET → 404');
  }

  // POST without apiKey while editing → preserves the stored cipher (key survives baseUrl-only edits).
  {
    const { res } = mockRes();
    await cm.registerCustomModelRoutes(
      {}, res, '/api/custom-models', 'POST',
      { id: 'my-model', baseUrl: 'https://new-host.example/v1' },
      'alice', false
    );
    assert.strictEqual(res.code, 200, 'edit without key');
    // Key still resolvable server-side: GET shows a hint, not a plaintext field.
    const { res: res2 } = mockRes();
    await cm.registerCustomModelRoutes(
      {}, res2, '/api/custom-models', 'GET', {}, 'alice', false
    );
    const row = res2.payload.find((r) => r.id === 'my-model');
    assert.ok(row.keyHint, 'key hint survives baseUrl-only edit');
    assert.strictEqual(row.apiKey, undefined, 'no plaintext field in GET');
    console.log('  edit (no key) preserves stored key →', row.keyHint);
  }

  // ── provider-keys: store a key, verify masked + no plaintext endpoint ──
  {
    await pk.saveUserProviderKey('alice', 'openrouter', {
      keys: ['sk-test-1', 'sk-test-2']
    });
    // GET list masked.
    {
      const { res } = mockRes();
      await pk.registerProviderKeyRoutes({}, res, '/api/account/provider-keys', 'GET', {}, 'alice');
      const row = res.payload.keys.find((k) => k.provider === 'openrouter');
      assert.ok(row, 'provider key in GET');
      assert.strictEqual(row.keyCount, 2, 'two keys counted');
      assert.strictEqual(row.keyCipher, undefined, 'no cipher leak in GET');
      console.log('  provider GET masked → keyHint:', row.keyHint, 'keyCount:', row.keyCount);
    }
    // GET /reveal → must NOT exist: 404 'not found'.
    {
      const { res } = mockRes();
      await pk.registerProviderKeyRoutes(
        {}, res, '/api/account/provider-keys/openrouter/reveal', 'GET', {}, 'alice'
      );
      assert.strictEqual(res.code, 404, 'provider reveal must not exist');
      assert.ok(!res.payload.keys || res.payload.keys.length === 0, 'no plaintext keys');
      console.log('  provider /reveal → 404 (endpoint removed)');
    }
    // Other owner cannot read.
    {
      const { res } = mockRes();
      await pk.registerProviderKeyRoutes({}, res, '/api/account/provider-keys', 'GET', {}, 'bob');
      const rows = res.payload.keys ?? [];
      assert.ok(!rows.some((k) => k.provider === 'openrouter'), 'bob sees no alice keys');
      console.log('  bob provider GET → no rows');
    }
    // PUT without any key (edit baseUrl only) → preserves stored cipher.
    {
      const { res } = mockRes();
      await pk.registerProviderKeyRoutes(
        {}, res, '/api/account/provider-keys/openrouter', 'PUT',
        { baseUrl: 'https://custom.example/v1' }, 'alice'
      );
      assert.strictEqual(res.code, 200, 'preserved PUT');
      assert.strictEqual(res.payload.preserved, true, 'preserved flag');
      // Re-verify: key still resolvable (status reset to unverified due to baseUrl change).
      const { res: res2 } = mockRes();
      await pk.registerProviderKeyRoutes({}, res2, '/api/account/provider-keys', 'GET', {}, 'alice');
      const row = res2.payload.keys.find((k) => k.provider === 'openrouter');
      assert.strictEqual(row.keyCount, 2, 'extra keys preserved');
      assert.strictEqual(row.baseUrl, 'https://custom.example/v1', 'baseUrl updated');
      console.log('  provider PUT (no key) preserves cipher, baseUrl →', row.baseUrl, ', keyCount', row.keyCount);
    }
    // PUT without key on a provider with no stored key → 400.
    {
      const { res } = mockRes();
      await pk.registerProviderKeyRoutes(
        {}, res, '/api/account/provider-keys/openai', 'PUT', {}, 'alice'
      );
      assert.strictEqual(res.code, 400, 'first-time PUT requires a key');
      console.log('  provider PUT (no key, first-time) → 400');
    }
  }

  console.log('\n\u2705 all secure key-handling assertions passed');
  process.exit(0);
})().catch((e) => {
  console.error('\u274c FAIL:', e && e.message ? e.message : e);
  console.error(e && e.stack ? e.stack : '');
  process.exit(1);
});

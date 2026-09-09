/**
 * E2E round-trip for the new /reveal endpoints (custom-models + provider-keys).
 * Proves: GET list stays masked (no plaintext), POST :id/reveal returns the
 * decrypted key, and an unconfigured key returns configured:false.
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

  // ── custom-models: store a key, verify GET masked + reveal plaintext ──
  {
    const { res, req } = mockRes();
    await cm.registerCustomModelRoutes(
      req, res, '/api/custom-models', 'POST',
      { id: 'my-model', baseUrl: 'https://example.com/v1', apiKey: 'sk-live-abc123SECRET' },
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
    assert.ok(row, 'custom-model present in GET');
    assert.ok(row.keyHint && /abc123/.test(row.keyHint) || /••••/.test(row.keyHint) || row.keyHint, 'keyHint present');
    assert.strictEqual(row.apiKey, undefined, 'GET must NOT leak plaintext/cipher');
    console.log('  custom GET masked →', JSON.stringify(row.keyHint));
  }

  // GET reveal → plaintext.
  {
    const { res } = mockRes();
    await cm.registerCustomModelRoutes(
      {}, res, '/api/custom-models/my-model/reveal', 'GET', {}, 'alice', false
    );
    assert.strictEqual(res.payload.ok, true, 'reveal ok');
    assert.strictEqual(res.payload.key, 'sk-live-abc123SECRET', 'reveal returns plaintext');
    assert.strictEqual(res.payload.configured, true, 'configured=true');
    console.log('  custom reveal →', res.payload.key);
  }

  // Owner isolation: bob cannot reveal alice's key.
  {
    const { res } = mockRes();
    await cm.registerCustomModelRoutes(
      {}, res, '/api/custom-models/my-model/reveal', 'GET', {}, 'bob', false
    );
    // getCustomModel returns null for bob → !row?.apiKey → configured:false, empty.
    assert.strictEqual(res.payload.configured, false, 'other-owner cannot reveal');
    assert.strictEqual(res.payload.key, '', 'other-owner empty key');
    console.log('  bob (other owner) reveal → configured=false, key=""');
  }

  // Unconfigured model (no key stored) → configured:false.
  {
    const { res } = mockRes();
    await cm.registerCustomModelRoutes(
      {}, res, '/api/custom-models/ghost-model/reveal', 'GET', {}, 'alice', false
    );
    assert.strictEqual(res.payload.configured, false, 'ghost model configured=false');
    console.log('  ghost model reveal → configured=false');
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
    const { res: res2 } = mockRes();
    await cm.registerCustomModelRoutes(
      {}, res2, '/api/custom-models/my-model/reveal', 'GET', {}, 'alice', false
    );
    assert.strictEqual(res2.payload.key, 'sk-live-abc123SECRET', 'key survives baseUrl-only edit');
    console.log('  edit (no key) preserves stored key →', res2.payload.key);
  }

  // ── provider-keys: store a key, verify reveal + extras ──
  {
    await pk.saveUserProviderKey('alice', 'openrouter', {
      keys: ['sk-or-v1-PRIMARYkey', 'sk-or-v1-SECONDkey']
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
    // Reveal → both keys in plaintext.
    {
      const { res } = mockRes();
      await pk.registerProviderKeyRoutes(
        {}, res, '/api/account/provider-keys/openrouter/reveal', 'GET', {}, 'alice'
      );
      assert.strictEqual(res.payload.ok, true, 'provider reveal ok');
      assert.deepStrictEqual(res.payload.keys, ['sk-or-v1-PRIMARYkey', 'sk-or-v1-SECONDkey'], 'both keys revealed');
      console.log('  provider reveal →', res.payload.keys);
    }
    // Other owner cannot reveal.
    {
      const { res } = mockRes();
      await pk.registerProviderKeyRoutes(
        {}, res, '/api/account/provider-keys/openrouter/reveal', 'GET', {}, 'bob'
      );
      assert.strictEqual(res.payload.configured, false, 'bob cannot reveal alice key');
      console.log('  bob provider reveal → configured=false');
    }
  }

  console.log('\n✅ all reveal round-trip assertions passed');
  process.exit(0);
})().catch((e) => {
  console.error('❌ FAIL:', e && e.message ? e.message : e);
  console.error(e && e.stack ? e.stack : '');
  process.exit(1);
});

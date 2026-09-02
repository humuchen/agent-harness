/**
 * BYOK P1.1（自定义模型 owner 隔离）+ P1.3（JobDescriptor 去明文凭据）单元测试。
 *
 * 依赖：先 `pnpm --filter @agent-harness/server build` 生成 dist。
 * 运行：`node --test test/byok-isolation.test.cjs`（在 access/server 目录下）。
 */
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 固定测试用 AES key（64 hex，满足 /^[0-9a-fA-F]{64}$/）。
process.env.AH_CRYPTO_KEY = 'a'.repeat(64);

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-byok-'));
const cmDb = path.join(tmpDir, 'custom-models.db');
const pkDb = path.join(tmpDir, 'provider-keys.db');
process.env.CUSTOM_MODELS_DB_FILE = cmDb;
process.env.PROVIDER_KEYS_DB_FILE = pkDb;

const { getDbAdapter } = require('@agent-harness/core');
const cm = require('../dist/custom-models');
const pk = require('../dist/provider-keys');
const { RunQueue } = require('../dist/run-queue');

describe('P1.1 自定义模型 owner 隔离', () => {
  test('不同 owner 互不可见彼此的自定义模型', async () => {
    await cm.putCustomModel({
      id: 'm-alice',
      owner: 'alice',
      apiKey: cm.encryptApiKey('sk-alice-secret-1234'),
      keyHint: 'sk-ali…1234',
    });
    await cm.putCustomModel({
      id: 'm-bob',
      owner: 'bob',
      apiKey: cm.encryptApiKey('sk-bob-secret-5678'),
      keyHint: 'sk-bob…5678',
    });

    const aliceList = await cm.listCustomModels('alice');
    const bobList = await cm.listCustomModels('bob');

    assert.deepStrictEqual(aliceList.map((r) => r.id), ['m-alice']);
    assert.deepStrictEqual(bobList.map((r) => r.id), ['m-bob']);

    // GET 单条：他人私有模型不可见（返回 null）
    assert.ok(await cm.getCustomModel('m-alice', 'alice'));
    assert.strictEqual(await cm.getCustomModel('m-alice', 'bob'), null);
    // 即便 includeLegacy，也只包含「本人 + 平台遗留」，不含他人私有
    assert.strictEqual(await cm.getCustomModel('m-alice', 'bob', true), null);
  });

  test('内部行存密文（非明文），对外脱敏由 toPublicModel 负责', async () => {
    const row = await cm.getCustomModel('m-alice', 'alice');
    assert.ok(row);
    assert.ok(row.apiKey, '内部行应携带密文（供 resolveRunCredential 服务端解密）');
    assert.notStrictEqual(
      row.apiKey,
      'sk-alice-secret-1234',
      '内部行的 apiKey 必须是密文，不得是明文'
    );
    assert.strictEqual(row.keyHint, 'sk-ali…1234');
    // 路由层（registerCustomModelRoutes GET → toPublicModel）才剥离密文，仅回 keyHint；
    // 此处验证数据层确实持久化的是密文，满足「密文不出网」的前提。
  });

  test('删除仅能删自己的模型，越权删除无效', async () => {
    const before = (await cm.listCustomModels('alice')).length;
    // bob 尝试删 alice 的模型：不应生效
    await cm.deleteCustomModel('m-alice', 'bob');
    assert.strictEqual((await cm.listCustomModels('alice')).length, before);
    // alice 自己删：生效
    await cm.deleteCustomModel('m-alice', 'alice');
    assert.strictEqual(await cm.getCustomModel('m-alice', 'alice'), null);
  });

  test('平台遗留（__legacy__）模型仅 admin/operator 可见', async () => {
    await cm.putCustomModel({
      id: 'm-legacy',
      owner: cm.LEGACY_OWNER,
      apiKey: cm.encryptApiKey('sk-platform-secret-9999'),
      keyHint: 'sk-pla…9999',
    });
    const adminList = await cm.listCustomModels('admin', true);
    const userList = await cm.listCustomModels('alice', false);
    assert.ok(adminList.some((r) => r.id === 'm-legacy'));
    assert.ok(!userList.some((r) => r.id === 'm-legacy'));

    // 普通用户即便 includeLegacy=true 也不含（legacy 仅 admin/operator 在 CRUD 中可见可管；
    // 但运行时 resolveRunCredential 对全体用户 includeLegacy，平台遗留模型仍可被使用——向后兼容）；
    // admin 带 includeLegacy=true 可见（与路由一致）。
    assert.ok(await cm.getCustomModel('m-legacy', 'admin', true));
    assert.strictEqual(await cm.getCustomModel('m-legacy', 'alice', false), null);
  });

  test('存量 NULL owner 行在 ensureDb 回填为 __legacy__', async () => {
    const legacyFile = path.join(tmpDir, 'legacy-cm.db');
    // 预置「迁移前」数据：表无 owner 列、行 owner 为 NULL
    const db = getDbAdapter({ file: legacyFile });
    await db.exec(
      'CREATE TABLE custom_models (id TEXT PRIMARY KEY, base_url TEXT, api_key TEXT, updated_at INTEGER NOT NULL, key_hint TEXT)'
    );
    await db
      .prepare(
        'INSERT INTO custom_models (id, base_url, api_key, updated_at, key_hint) VALUES (?,?,?,?,?)'
      )
      .run('legacy1', null, cm.encryptApiKey('sk-mig-secret-0000'), Date.now(), 'sk-mig…0000');

    // 重新加载模块，使其 ensureDb 在已含 NULL owner 行的库上执行 ALTER + 回填
    const prevFile = process.env.CUSTOM_MODELS_DB_FILE;
    process.env.CUSTOM_MODELS_DB_FILE = legacyFile;
    delete require.cache[require.resolve('../dist/custom-models')];
    const cm2 = require('../dist/custom-models');

    const adminList = await cm2.listCustomModels('admin', true);
    const userList = await cm2.listCustomModels('alice', false);
    assert.ok(adminList.some((r) => r.id === 'legacy1'), 'admin 应可见回填后的平台遗留模型');
    assert.ok(!userList.some((r) => r.id === 'legacy1'), '普通用户不应见平台遗留模型');

    process.env.CUSTOM_MODELS_DB_FILE = prevFile;
  });
});

describe('P1.3 JobDescriptor 不持久化解析后的明文凭据', () => {
  // 捕获后端：kind=redis 避免 submit 立即执行；claim 返回 null 不触发 execute，
  // append 仅记录 descriptor，便于断言「落盘内容不含明文 Key」。
  function fakeCapturingBackend() {
    const captured = [];
    return {
      kind: 'redis',
      append(d) {
        captured.push(d);
        return Promise.resolve();
      },
      list() {
        return Promise.resolve([]);
      },
      claim() {
        return Promise.resolve(null);
      },
      ack() {
        return Promise.resolve();
      },
      clear() {
        return Promise.resolve();
      },
      captured,
    };
  }

  test('解析后的用户 provider Key 不会写入 descriptor', async () => {
    // 给 u1 配置一个已知明文 provider Key（服务端加密落库）
    const PLAIN = 'sk-PROVIDER_SECRET_abc123';
    await pk.saveUserProviderKey('u1', 'openrouter', { apiKey: PLAIN });

    const b = fakeCapturingBackend();
    const rq = new RunQueue(b);
    try {
      rq.submit({
        mode: 'real',
        prompt: 'hello',
        model: 'openrouter/auto',
        modelApiKey: undefined, // 正常流程：run body 不带明文 Key
        owner: 'u1',
      });
      // submit 异步 append，给一拍让其落地
      await new Promise((r) => setImmediate(r));

      assert.strictEqual(b.captured.length, 1, '应恰好追加一条 descriptor');
      const d = b.captured[0];
      assert.strictEqual(d.owner, 'u1');
      assert.strictEqual(d.model, 'openrouter/auto');
      // 关键断言：descriptor 的 modelApiKey 是「输入」（undefined），而非解析出的明文
      assert.strictEqual(d.modelApiKey, undefined);
      // 解析出的明文 Key 绝不出现在本体序列化结果中
      assert.ok(
        !JSON.stringify(d).includes(PLAIN),
        '持久化 descriptor 不应包含用户 provider 明文 Key'
      );
    } finally {
      rq.stop();
    }
  });

  test('调用方直传的 modelApiKey 原样透传（legacy 路径，不被解析结果覆盖）', async () => {
    const CALLER = 'sk-caller-direct-xyz';
    const b = fakeCapturingBackend();
    const rq = new RunQueue(b);
    try {
      rq.submit({
        mode: 'real',
        prompt: 'hi',
        model: 'openrouter/auto',
        modelApiKey: CALLER,
        owner: 'u1',
      });
      await new Promise((r) => setImmediate(r));

      const d = b.captured[0];
      assert.strictEqual(d.modelApiKey, CALLER, 'descriptor 透传调用方输入');
      // 仍不应混入 u1 的 provider 明文（本例未配置，但验证不被错误注入）
    } finally {
      rq.stop();
    }
  });
});

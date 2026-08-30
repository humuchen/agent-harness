'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const core = require('../dist/index.js');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-db-test-'));

test('getDbAdapter: 同一 file 返回单例，close 后自愈（重新建连，不被已关闭实例污染）', () => {
  const file = path.join(tmpDir, 'singleton.db');
  const opts = { file, backend: 'sqlite' };
  const a = core.getDbAdapter(opts);
  const b = core.getDbAdapter(opts);
  assert.strictEqual(a, b, '同一配置应返回同一单例实例');

  a.exec('CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY)');
  b.prepare('INSERT INTO t (id) VALUES (1)').run();
  assert.strictEqual(b.prepare('SELECT COUNT(*) AS c FROM t').get().c, 1);

  // 关闭单例后，缓存条目应被同步删除，下次获取重新建连（自愈）。
  a.close();
  const c = core.getDbAdapter(opts);
  assert.notStrictEqual(a, c, '关闭后缓存应失效，重新建连');
  // 新实例可正常读写（原库文件仍在，表保留）。
  assert.strictEqual(c.prepare('SELECT COUNT(*) AS c FROM t').get().c, 1);
});

test('getDbAdapter: Turso 后端按 TURSO_URL 区分缓存键（避免共用默认 file 键串扰）', () => {
  const origUrl = process.env.TURSO_URL;
  const origBackend = process.env.DB_BACKEND;
  try {
    process.env.DB_BACKEND = 'turso';
    process.env.TURSO_URL = 'libsql://example-a.turso.io';
    // 不需要真实连接：这里只验证缓存键计算，用 reset 清空避免误用单例。
    core.resetDbAdaptersForTest();
    const a = core.getDbAdapter({ file: './data/app.db' });
    const keyA = a.cacheKey;
    assert.strictEqual(keyA, 'turso:libsql://example-a.turso.io', 'Turso 键应含 TURSO_URL');
  } finally {
    if (origUrl === undefined) delete process.env.TURSO_URL; else process.env.TURSO_URL = origUrl;
    if (origBackend === undefined) delete process.env.DB_BACKEND; else process.env.DB_BACKEND = origBackend;
    core.resetDbAdaptersForTest();
  }
});

test('PluginLoader.disable: 对称撤回插件注册的视图与路由（停用后不再暴露）', async () => {
  const views = [];
  const routes = new Map();
  const webHost = {
    registerView(v) { views.push(v); return () => { const i = views.indexOf(v); if (i >= 0) views.splice(i, 1); }; },
  };
  const serverHost = {
    registerExtension(ext) {
      const base = `/api/plugins/${ext.id}`;
      const added = [];
      for (const [rel, h] of Object.entries(ext.mountRoutes || {})) {
        const full = (base + (rel.startsWith('/') ? rel : '/' + rel)).replace(/\/+$/, '');
        routes.set(full || base, h); added.push(full || base);
      }
      return () => { for (const f of added) routes.delete(f); };
    },
  };

  const loader = new core.PluginLoader({ webHost, serverHost });

  const mod = {
    manifest: {
      id: 'demo',
      name: 'demo',
      version: '1.0.0',
      capabilities: [],
    },
    async setup(ctx) {
      ctx.web?.registerView({ tabId: 'demo', label: 'Demo', render: () => '<div>demo</div>' });
      ctx.server?.registerExtension({ id: 'demo', mountRoutes: { '/x': (req, res) => { res.end('x'); } } });
    },
  };

  await loader.installModule(mod);
  await loader.enable('demo');
  assert.strictEqual(views.length, 1, '启用后应有 1 个视图');
  assert.strictEqual(routes.size, 1, '启用后应有 1 条路由');

  await loader.disable('demo');
  assert.strictEqual(views.length, 0, 'disable 后应撤回视图');
  assert.strictEqual(routes.size, 0, 'disable 后应撤回路由');
  assert.strictEqual(loader.get('demo').state, 'disabled');
});

test('PluginLoader: 重复 enable 不会重复注册视图/路由', async () => {
  const views = [];
  const routes = new Map();
  const webHost = {
    registerView(v) { views.push(v); return () => { const i = views.indexOf(v); if (i >= 0) views.splice(i, 1); }; },
  };
  const serverHost = {
    registerExtension(ext) {
      const base = `/api/plugins/${ext.id}`;
      const added = [];
      for (const [rel, h] of Object.entries(ext.mountRoutes || {})) {
        const full = (base + (rel.startsWith('/') ? rel : '/' + rel)).replace(/\/+$/, '');
        routes.set(full || base, h); added.push(full || base);
      }
      return () => { for (const f of added) routes.delete(f); };
    },
  };
  const loader = new core.PluginLoader({ webHost, serverHost });
  const mod = {
    manifest: { id: 'dup', name: 'dup', version: '1.0.0', capabilities: [] },
    async setup(ctx) {
      ctx.web?.registerView({ tabId: 'dup', label: 'Dup', render: () => 'x' });
    },
  };
  await loader.installModule(mod);
  await loader.enable('dup');
  await loader.disable('dup');
  await loader.enable('dup');
  assert.strictEqual(views.length, 1, '再启用后仍是 1 个视图（无重复注册）');
});

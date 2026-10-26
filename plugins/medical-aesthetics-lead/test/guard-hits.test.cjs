// 中期补全：医疗广告护栏命中审计 + 人审队列测试。
//   1) guard 命中 sink：core 运行时拦截命中 → setMedicalAdAuditSink → ma_guard_hits 落表
//   2) 人审队列：listGuardHits（status 过滤）+ reviewGuardHit（reviewed/dismissed）
//   3) 命中统计：guardHitStats 计数闭环
//   4) 路由契约：guard-hits 列表/复核（经 leadServerExtension.mountRoutes 直呼 handler）
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-guard-hits-'));
process.env.MA_DATA_DIR = DATA_DIR;
process.env.MA_TENANT_ID = 'test';
process.env.MA_ADMIN_TOKEN = 'test-admin-token';

const { checkInput, checkOutput } = require('@agent-harness/core');
const guard = require('@agent-harness/medical-ad-guard');
const { getDbAsync, closeDb } = require('../dist/infra/db');
const { resetConfig } = require('../dist/config');
const {
  insertGuardHit,
  listGuardHits,
  reviewGuardHit,
  guardHitStats,
} = require('../dist/repo/guard-hits-repo');
const { leadServerExtension } = require('../dist/server/routes');

before(async () => {
  await getDbAsync();
  guard.registerMedicalAdGuardrail();
  // 与插件 index.ts setup 同款接线：core 命中 → 落表
  guard.setMedicalAdAuditSink((hit) => {
    void insertGuardHit({
      hitAt: hit.hitAt,
      side: hit.side,
      ruleId: hit.ruleId ?? null,
      matched: hit.matched,
      reason: hit.reason,
      scope: hit.scope ?? null,
    }).catch(() => {});
  });
});

after(() => {
  closeDb();
  resetConfig();
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* 清理失败不阻断 */ }
});

describe('护栏命中落表（sink 闭环）', () => {
  test('checkOutput 命中合规规则 → ma_guard_hits 自动落表（含 ruleId）', async () => {
    // scopes 含 medical-ad → 规则生效并触发 sink
    const out = checkOutput('我们手术100%成功，绝对安全', { scopes: ['medical-ad'] });
    assert.equal(out.ok, false, '运行时护栏应拦截');
    // sink 是同步回调（insertGuardHit 内部异步）——轮询等待落表
    let hits = [];
    for (let i = 0; i < 50; i++) {
      hits = await listGuardHits({ status: 'pending', limit: 10 });
      if (hits.length >= 1) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(hits.length >= 1, '命中应落人审队列');
    const hit = hits.find((h) => h.matched.includes('100%'));
    assert.ok(hit, '应含 100% 命中记录');
    assert.equal(hit.side, 'output');
    assert.equal(hit.scope, 'medical-ad');
    assert.ok(hit.ruleId, '应解析出词库规则 id');
    assert.ok(hit.reason.includes('100%'));
  });
});

describe('人审队列（复核闭环）', () => {
  test('insert → pending 列表 → reviewed/dismissed 处置 → 统计闭环', async () => {
    const id1 = await insertGuardHit({
      hitAt: Date.now(), side: 'output', ruleId: 'absolute-assertion',
      matched: '保证不留疤', reason: '测试：绝对化保证', scope: 'medical-ad',
    });
    const id2 = await insertGuardHit({
      hitAt: Date.now(), side: 'input', matched: '千万别去那家', reason: '测试：贬低同业',
    });
    assert.ok(id1 > 0 && id2 > 0);

    let pending = await listGuardHits({ status: 'pending', limit: 50 });
    assert.ok(pending.some((h) => h.id === id1));
    assert.ok(pending.some((h) => h.id === id2));

    const r1 = await reviewGuardHit(id1, { status: 'reviewed', reviewedBy: 'op-1', note: '确认违规' });
    assert.equal(r1.status, 'reviewed');
    assert.equal(r1.reviewedBy, 'op-1');
    const r2 = await reviewGuardHit(id2, { status: 'dismissed', reviewedBy: 'op-1', note: '误报：竞对合规宣传' });
    assert.equal(r2.status, 'dismissed');

    pending = await listGuardHits({ status: 'pending', limit: 50 });
    assert.ok(!pending.some((h) => h.id === id1 && h.status === 'pending'));
    const stats = await guardHitStats();
    assert.ok(stats.reviewed >= 1 && stats.dismissed >= 1 && stats.total >= 2);
    // 'all' 不过滤
    const all = await listGuardHits({ status: 'all', limit: 200 });
    assert.ok(all.some((h) => h.id === id1) && all.some((h) => h.id === id2));
  });
});

describe('人审路由契约（真实 http 分发）', () => {
  let srv, base;
  before(async () => {
    // 模拟宿主：按 mountRoutes key 精确分发（路径即 key），挂载前缀在此剥离。
    srv = require('node:http').createServer(async (req, res) => {
      const url = new URL(req.url || '/', 'http://localhost');
      const handler = leadServerExtension.mountRoutes[url.pathname];
      if (!handler) {
        res.statusCode = 404;
        return res.end('{"error":"not found"}');
      }
      await handler(req, res);
    });
    await new Promise((r) => srv.listen(0, r));
    base = `http://127.0.0.1:${srv.address().port}`;
  });
  after(() => srv.close());

  const j = async (method, path, body, headers = {}) => {
    const r = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const adminHeaders = { authorization: 'Bearer test-admin-token' };

  test('GET /guard-hits（admin）→ 列表 + 统计；无令牌 → 401', async () => {
    const ok = await j('GET', '/guard-hits?status=all&limit=10', undefined, adminHeaders);
    assert.equal(ok.status, 200);
    assert.ok(Array.isArray(ok.json.hits));
    assert.ok(ok.json.stats && typeof ok.json.stats.total === 'number');

    const deny = await j('GET', '/guard-hits');
    assert.equal(deny.status, 401, '无管理令牌应 401');
  });

  test('POST /guard-hits/review（admin）→ 处置生效；缺参 → 400；未知 id → 404', async () => {
    const target = (await listGuardHits({ status: 'all', limit: 5 }))[0];
    assert.ok(target, '前置用例应已落命中');
    const ok = await j('POST', '/guard-hits/review', { id: target.id, status: 'reviewed', note: '路由复核' }, adminHeaders);
    assert.equal(ok.status, 200);
    assert.equal(ok.json.hit.status, 'reviewed');

    const bad = await j('POST', '/guard-hits/review', { id: target.id }, adminHeaders);
    assert.equal(bad.status, 400, '缺 status 应 400');
    const missing = await j('POST', '/guard-hits/review', { id: 999999, status: 'dismissed' }, adminHeaders);
    assert.equal(missing.status, 404, '未知 id 应 404');
  });
});

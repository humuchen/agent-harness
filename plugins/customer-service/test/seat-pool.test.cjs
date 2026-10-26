// 增强：转人工坐席池测试 —— 注册/上下线/最闲优先指派/负载联动/handoff 端到端/路由契约。
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const dir = mkdtempSync(join(tmpdir(), 'cs-seat-pool-'));
process.env.CS_DATA_DIR = dir;
process.env.CS_ADMIN_TOKEN = 'test-admin-token';

const seats = require('../dist/repo/seat-repo.js');
const sessionSvc = require('../dist/services/session-service.js');
const { getDb, closeDb } = require('../dist/infra/db.js');
const { resetConfig } = require('../dist/config.js');
const { csServerExtension } = require('../dist/server/routes.js');

before(() => {
  getDb();
  // 三个坐席：A/B 在线，C 离线
  seats.upsertSeat({ seatId: 'seat-a', name: '坐席A' });
  seats.upsertSeat({ seatId: 'seat-b', name: '坐席B' });
  seats.upsertSeat({ seatId: 'seat-c', name: '坐席C' });
  seats.setSeatStatus('seat-a', 'online');
  seats.setSeatStatus('seat-b', 'online');
});

after(() => {
  closeDb();
  resetConfig();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不阻断 */ }
});

describe('坐席池（最闲优先指派）', () => {
  test('无负载时按注册顺序（updated_at 平局规则）取最闲', () => {
    const s1 = pick();
    assert.equal(s1.seatId, 'seat-a', '首单应给 A');
    seats.incrementSeatLoad('seat-a');
    const s2 = pick();
    assert.equal(s2.seatId, 'seat-b', 'A 负载 1 后应给 B');
  });

  test('busy 状态联动：负载归 0 回 online；offline 不参与指派', () => {
    seats.incrementSeatLoad('seat-b');
    const b = seats.getSeat('seat-b');
    assert.equal(b.status, 'busy');
    assert.equal(b.activeSessions, 1);
    seats.setSeatStatus('seat-c', 'online');
    seats.incrementSeatLoad('seat-c');
    seats.decrementSeatLoad('seat-c');
    const c = seats.getSeat('seat-c');
    assert.equal(c.status, 'online', '归 0 应回 online');
    assert.equal(c.activeSessions, 0);
    seats.setSeatStatus('seat-c', 'offline');
    seats.decrementSeatLoad('seat-b');
    // A=1, B=0(online), C=offline → 最闲是 B
    assert.equal(pick().seatId, 'seat-b');
  });

  test('handoff 自动指派：会话绑定坐席且坐席负载 +1；关闭会话释放', () => {
    // 当前负载：A=1(online)，B=0(online) → 最闲 B
    sessionSvc.touchSession({ sessionId: 'sess-1', channel: 'web' });
    const s1 = sessionSvc.handoff({ sessionId: 'sess-1' });
    assert.equal(s1.status, 'handoff');
    assert.equal(s1.assignedSeat, 'seat-b');
    assert.equal(seats.getSeat('seat-b').activeSessions, 1);
    // 关闭会话释放
    sessionSvc.close({ sessionId: 'sess-1' });
    assert.equal(seats.getSeat('seat-b').activeSessions, 0);
    assert.equal(sessionSvc.session({ sessionId: 'sess-1' }).assignedSeat, null);
  });

  test('无在线坐席：handoff 仍成功（assignedSeat=null 等待认领）', () => {
    seats.setSeatStatus('seat-a', 'offline');
    seats.setSeatStatus('seat-b', 'offline');
    sessionSvc.touchSession({ sessionId: 'sess-2', channel: 'wechat' });
    const s = sessionSvc.handoff({ sessionId: 'sess-2' });
    assert.equal(s.status, 'handoff');
    assert.equal(s.assignedSeat, null, '无在线坐席应留空等待认领');
    seats.setSeatStatus('seat-a', 'online');
    seats.setSeatStatus('seat-b', 'online');
  });
});

describe('坐席路由契约（真实 http 分发）', () => {
  let srv, base;
  before(async () => {
    const { createServer } = require('node:http');
    srv = createServer(async (req, res) => {
      const url = new URL(req.url || '/', 'http://localhost');
      const handler = csServerExtension.mountRoutes[url.pathname];
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
  const admin = { authorization: 'Bearer test-admin-token' };

  test('GET /seats 列表（负载升序）', async () => {
    const ok = await j('GET', '/seats');
    assert.equal(ok.status, 200);
    assert.ok(Array.isArray(ok.json.seats) && ok.json.seats.length >= 3);
    // 升序校验
    const loads = ok.json.seats.map((s) => s.activeSessions);
    assert.deepEqual(loads, [...loads].sort((a, b) => a - b), '列表应按负载升序');
  });

  test('POST /seats 注册新坐席（admin）+ 401 校验', async () => {
    const deny = await j('POST', '/seats', { seatId: 'seat-d', name: '坐席D' });
    assert.equal(deny.status, 401, '无令牌应 401');
    const ok = await j('POST', '/seats', { seatId: 'seat-d', name: '坐席D' }, admin);
    assert.equal(ok.status, 200);
    assert.equal(ok.json.status, 'offline', '新坐席默认离线');
    const up = await j('POST', '/seat/status', { seatId: 'seat-d', status: 'online' }, admin);
    assert.equal(up.json.status, 'online');
  });

  test('POST /seat/status 参数校验', async () => {
    const bad = await j('POST', '/seat/status', { seatId: 'seat-a' }, admin);
    assert.equal(bad.status, 400, '缺 status 应 400');
    const missing = await j('POST', '/seat/status', { seatId: 'no-such', status: 'online' }, admin);
    assert.equal(missing.status, 404, '未知坐席应 404');
  });
});

function pick() {
  // 借 listSeats 的排序语义（最闲在前）验证 pickLeastBusySeat 的选择
  const chosen = require('../dist/repo/seat-repo.js').pickLeastBusySeat();
  assert.ok(chosen);
  return chosen;
}

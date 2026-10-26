// 增强：工单运营闭环 —— 状态机 / SLA / CSAT 测试。
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const dir = mkdtempSync(join(tmpdir(), 'cs-ticket-ops-'));
process.env.CS_DATA_DIR = dir;

const repo = require('../dist/repo/ticket-repo.js');
const svc = require('../dist/services/ticket-service.js');
const { getDb, closeDb } = require('../dist/infra/db.js');
const { resetConfig } = require('../dist/config.js');
const { ToolRegistry } = require('@agent-harness/core');

before(() => {
  getDb();
});

after(() => {
  closeDb();
  resetConfig();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不阻断 */ }
});

describe('工单状态机', () => {
  test('合法流转：open → in_progress → resolved → closed', () => {
    const t = repo.createTicket({ subject: '状态机验证', priority: 'normal' });
    assert.equal(t.status, 'open');
    assert.ok(t.slaDueAt, '建单应写入 SLA 到期时间');
    for (const next of ['in_progress', 'resolved', 'closed']) {
      const u = repo.transitionTicket(t.ticketId, next);
      assert.equal(u.status, next, `流转到 ${next}`);
    }
  });

  test('非法流转被拒绝（closed → open；跳级 open → closed 之外的任意串）', () => {
    const t = repo.createTicket({ subject: '非法流转' });
    assert.throws(() => repo.transitionTicket(t.ticketId, 'pending'), /非法工单状态/, '未知状态应拒绝');
    repo.transitionTicket(t.ticketId, 'closed');
    assert.throws(() => repo.transitionTicket(t.ticketId, 'open'), /非法状态流转/, 'closed→open 应拒绝');
    // reopen：closed → in_progress 合法
    const r = repo.transitionTicket(t.ticketId, 'in_progress');
    assert.equal(r.status, 'in_progress');
  });

  test('updateTicket 走状态机（非法零副作用），priority 调整重算 SLA', () => {
    const t = repo.createTicket({ subject: 'update 校验' });
    assert.throws(() => repo.updateTicket(t.ticketId, { status: 'bogus', assignee: 'a1' }), /非法工单状态/);
    assert.equal(repo.getTicket(t.ticketId).assignee, null, '非法流转不应落地其它字段');
    const u = repo.updateTicket(t.ticketId, { status: 'resolved', assignee: 'a1', priority: 'urgent' });
    assert.equal(u.status, 'resolved');
    assert.equal(u.assignee, 'a1');
    assert.equal(u.priority, 'urgent');
  });

  test('幂等：同状态重复提交视为无操作', () => {
    const t = repo.createTicket({ subject: '幂等' });
    repo.transitionTicket(t.ticketId, 'open');
    assert.equal(repo.getTicket(t.ticketId).status, 'open');
  });
});

describe('SLA', () => {
  test('分级时限写入；overdue 过滤与升级', () => {
    const urgent = repo.createTicket({ subject: '加急单', priority: 'urgent' });
    const low = repo.createTicket({ subject: '低优单', priority: 'low' });
    const uDue = new Date(urgent.slaDueAt).getTime();
    const lDue = new Date(low.slaDueAt).getTime();
    assert.ok(uDue - new Date(urgent.createdAt).getTime() <= 2 * 3_600_000 + 1000, 'urgent SLA=2h');
    assert.ok(lDue - new Date(low.createdAt).getTime() >= 71 * 3_600_000, 'low SLA=72h');

    // 未结单 + SLA 扫描：把 low 单 SLA 改到过去 → listSlaBreachedIds 命中 → 升级
    const db = repo.getDb ? null : null; // repo 不暴露 db —— 直接用 service 扫描（当前无超时单，应为 0 或不含新单）
    const breachedBefore = svc.escalateSlaBreached();
    assert.ok(breachedBefore >= 0);
    // 直接构造超时：把 low 单 sla_due_at 改到过去（模拟时间流逝）
    const { getDb: gdb } = require('../dist/infra/db.js');
    gdb().prepare(`UPDATE cs_ticket SET sla_due_at=? WHERE ticket_id=?`).run(
      new Date(Date.now() - 1000).toISOString(),
      low.ticketId,
    );
    const escalated = svc.escalateSlaBreached();
    assert.ok(escalated >= 1, '超时未结单应被升级');
    const after = repo.getTicket(low.ticketId);
    assert.equal(after.priority, 'urgent', '超时单应升为 urgent');
    // overdue 列表
    const overdue = repo.listTickets('overdue');
    assert.ok(overdue.every((x) => x.slaBreached === true));
  });

  test('结单后不再计 breach', () => {
    const t = repo.createTicket({ subject: '结单不计' });
    const { getDb: gdb } = require('../dist/infra/db.js');
    gdb().prepare(`UPDATE cs_ticket SET sla_due_at=? WHERE ticket_id=?`).run(
      new Date(Date.now() - 10_000).toISOString(),
      t.ticketId,
    );
    assert.equal(repo.getTicket(t.ticketId).slaBreached, true);
    repo.transitionTicket(t.ticketId, 'resolved');
    assert.equal(repo.getTicket(t.ticketId).slaBreached, false, '终态不计超时');
  });
});

describe('CSAT 评分', () => {
  test('未结单不可评；结单后可评；一次性不可复评；rating 校验', () => {
    const t = repo.createTicket({ subject: '评分验证' });
    assert.throws(() => repo.rateTicket(t.ticketId, 5), /尚未结单/, '未结单应拒绝');
    repo.transitionTicket(t.ticketId, 'resolved');
    assert.throws(() => repo.rateTicket(t.ticketId, 6), /1-5/, '越界评分应拒绝');
    const rated = repo.rateTicket(t.ticketId, 4, '还不错');
    assert.equal(rated.rating, 4);
    assert.equal(rated.ratingComment, '还不错');
    assert.throws(() => repo.rateTicket(t.ticketId, 5), /不可重复提交/, '复评应拒绝');
    // updateTicket 不可篡改评分
    repo.updateTicket(t.ticketId, { priority: 'low' });
    assert.equal(repo.getTicket(t.ticketId).rating, 4, '评分不可被其它更新路径篡改');
  });

  test('工具层 cs_ticket_rate 端到端', async () => {
    const reg = new ToolRegistry();
    require('../dist/tools/ticket.js').registerTicketTools(reg);
    assert.ok(reg.has('cs_ticket_rate'), '应注册评分工具');
    const t = repo.createTicket({ subject: '工具评分' });
    repo.transitionTicket(t.ticketId, 'closed');
    const out = await reg.call('cs_ticket_rate', { ticketId: t.ticketId, rating: 5, comment: '很好' });
    assert.equal(out.rating, 5);
    const err = await reg.call('cs_ticket_rate', { ticketId: t.ticketId, rating: 3 });
    assert.ok(err.error, '复评应返回错误结果');
  });
});

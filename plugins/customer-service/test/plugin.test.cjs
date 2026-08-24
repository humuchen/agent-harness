// customer-service 插件测试（node:test + node:assert，零依赖）。
// 覆盖：repo 层（真实 sqlite 落库）、services 层、tools 层（ToolRegistry 注册 + 端到端调用）、
//       fail-closed（外部订单上游未配置时 NOT_CONFIGURED）。
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { ToolRegistry } = require('@agent-harness/core');

// 隔离数据目录：必须在 require 任何业务模块前设置（config 懒解析 + 缓存）。
const dir = mkdtempSync(join(tmpdir(), 'cs-test-'));
process.env.CS_DATA_DIR = dir;

const kb = require('../dist/repo/kb-repo.js');
const ticket = require('../dist/repo/ticket-repo.js');
const session = require('../dist/repo/session-repo.js');
const sessionSvc = require('../dist/services/session-service.js');
const orderSvc = require('../dist/services/order-service.js');
const tools = require('../dist/tools/ticket.js');
const kbTools = require('../dist/tools/kb.js');
const orderTools = require('../dist/tools/order.js');
const handoffTools = require('../dist/tools/handoff.js');
const { getDb, closeDb } = require('../dist/infra/db.js');
const { getConfig, resetConfig } = require('../dist/config.js');

before(() => {
  getDb(); // 触发建表
});

after(() => {
  closeDb();
  resetConfig();
  rmSync(dir, { recursive: true, force: true });
});

test('config：CS_DATA_DIR 生效，db 落在隔离目录', () => {
  const c = getConfig();
  assert.strictEqual(c.db.file, join(dir, 'cs.db'));
  assert.strictEqual(c.tenantId, 'default');
});

test('repo：知识库插入 + 检索（真实落库）', () => {
  const r = kb.insertKb({ question: '退款几天到账', answer: '原路退回，1-3 个工作日到账', category: '售后' });
  assert.ok(r.kbId > 0);
  const hits = kb.searchKb('退款', 5);
  assert.ok(hits.length >= 1);
  assert.ok(hits.some((h) => h.answer.includes('原路退回')));
});

test('repo：工单创建 / 列表 / 改状态 / 认领', () => {
  const t = ticket.createTicket({ subject: '物流延迟投诉', channel: 'web', priority: 'high' });
  assert.ok(t.ticketId.startsWith('cs-'));
  assert.strictEqual(t.status, 'open');

  const list = ticket.listTickets(undefined, 10);
  assert.ok(list.some((x) => x.ticketId === t.ticketId));

  const resolved = ticket.updateTicket(t.ticketId, { status: 'resolved', assignee: 'agent-01' });
  assert.strictEqual(resolved.status, 'resolved');
  assert.strictEqual(resolved.assignee, 'agent-01');
  assert.strictEqual(ticket.getTicket(t.ticketId).status, 'resolved');
});

test('repo/services：会话接待 → 转人工', () => {
  const s = sessionSvc.touchSession({ sessionId: 'sess-1', channel: 'wechat', customerId: 'u-1' });
  assert.strictEqual(s.status, 'open');
  const h = sessionSvc.handoff({ sessionId: 'sess-1' });
  assert.strictEqual(h.status, 'handoff');
});

test('tools：注册 5 个工具（短名），ToolRegistry 可检索', () => {
  const reg = new ToolRegistry();
  tools.registerTicketTools(reg);
  kbTools.registerKbTools(reg);
  orderTools.registerOrderTools(reg);
  handoffTools.registerHandoffTool(reg);
  for (const name of [
    'cs_ticket_create',
    'cs_ticket_query',
    'cs_kb_search',
    'cs_kb_add',
    'cs_order_query',
    'cs_handoff',
  ]) {
    assert.ok(reg.has(name), `missing tool ${name}`);
  }
  return { reg };
});

test('tools：cs_ticket_create 端到端（经 ToolRegistry.call → services → 真实 DB）', async () => {
  const reg = new ToolRegistry();
  tools.registerTicketTools(reg);
  const out = await reg.call('cs_ticket_create', { subject: '咨询保修政策', channel: 'app', priority: 'normal' });
  assert.ok(out.ticketId.startsWith('cs-'));
  const found = ticket.getTicket(out.ticketId);
  assert.strictEqual(found.subject, '咨询保修政策');
});

test('tools：cs_kb_search 命中插入的知识', async () => {
  const reg = new ToolRegistry();
  kbTools.registerKbTools(reg);
  const out = await reg.call('cs_kb_search', { query: '退款', limit: 3 });
  assert.ok(out.count >= 1);
  assert.ok(Array.isArray(out.items));
});

test('fail-closed：外部订单上游未配置 → cs_order_query 返回 NOT_CONFIGURED（不伪造数据）', async () => {
  const reg = new ToolRegistry();
  orderTools.registerOrderTools(reg);
  const out = await reg.call('cs_order_query', { orderNo: 'NO-123' });
  assert.strictEqual(out.code, 'NOT_CONFIGURED');
  assert.strictEqual(out.error, true);
  // services 层同样 fail-closed（queryOrder 为 async，需 await）
  const svc = await orderSvc.queryOrder({ orderNo: 'NO-123' });
  assert.strictEqual(svc.code, 'NOT_CONFIGURED');
});

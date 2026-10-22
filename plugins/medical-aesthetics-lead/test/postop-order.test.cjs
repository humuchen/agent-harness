// 新增能力回归测试（P1-⑦ 术后关怀 SOP / P1-⑧ 订单与复购率）：
//   1) 已到院客户 → 规划 post_op 节点（D+1/D+7/D+30）→ 到期产出关怀文案（含风险提示、无疗效承诺）
//   2) 多笔成交订单 → 复购率 / 总成交金额正确计算（fail-closed，空数据返回 0）
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let DATA_DIR;

test.beforeEach(() => {
  DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-postop-'));
  process.env.MA_DATA_DIR = DATA_DIR;
  process.env.MA_TENANT_ID = 'test';
  process.env.MA_OUTBOX_ENABLED = 'false';
  delete process.env.MA_OUTREACH_BASE_URL;
  delete process.env.MA_CRM_BASE_URL;
  delete process.env.MA_HIS_BASE_URL;
  delete process.env.MA_SCHEDULER_ENABLED;
  try { require('../dist/infra/db').closeDb(); } catch {}
  try { require('../dist/config').resetConfig(); } catch {}
});

test.afterEach(() => {
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}
  try { require('../dist/infra/db').closeDb(); } catch {}
});

const { upsertLead } = require('../dist/repo/lead-repo');
const { getDb } = require('../dist/infra/db');
const { upsertOrder, orderStats } = require('../dist/repo/order-repo');
const { planSopJobs, runDueJobs } = require('../dist/services/scheduler-service');

const DAY = 86_400_000;

async function addAppointmentArrived(leadId, arrivedAtMs) {
  const db = await getDb();
  await db
    .prepare(
      `INSERT INTO ma_appointment (appointment_id, tenant_id, lead_id, clinic_id, slot_id, slot_date, slot_time, status, arrived_at, created_at, updated_at)
       VALUES (?, ?, ?, 'c1', 's1', '2026-01-01', '10:00', 'arrived', ?, ?, ?)`
    )
    .run(`ap_${leadId}`, 'test', leadId, Math.floor(arrivedAtMs / 1000), Math.floor(arrivedAtMs / 1000), Math.floor(arrivedAtMs / 1000));
}

describe('术后关怀 SOP（P1-⑦）', () => {
  test('已到院客户 → 规划 post_op 节点 → 到期产出关怀文案', async () => {
    await upsertLead('po1', {
      channel: 'wechat',
      name: '李女士',
      project: '玻尿酸',
      stage: 'arrived',
      consentAt: Date.now(),
      phone: '13800000000',
    });
    await addAppointmentArrived('po1', Date.now() - 2 * DAY); // 到院 2 天前 → D+1 节点到期

    const p = await planSopJobs();
    assert.ok(p.postOp >= 1, '应至少排 D+1 关怀节点');

    await runDueJobs();
    const db = await getDb();
    // ma_outbox.topic 恒为 'outreach.send'；SOP 类型在 payload.topic。
    const rows = await db.prepare("SELECT payload FROM ma_outbox WHERE topic = 'outreach.send' ORDER BY id").all();
    const postOps = rows.map((r) => JSON.parse(String(r.payload))).filter((p) => p.topic === 'post_op');
    assert.ok(postOps.length >= 1, '应产出 post_op 触达消息');
    const payload = postOps[0];
    assert.ok(payload.text && payload.text.length > 0, '关怀文案应生成');
    assert.ok(!/保证|100%|绝对/.test(payload.text), '关怀文案不得含疗效承诺');
  });

  test('未授权 / 无联系方式客户不排 post_op', async () => {
    await upsertLead('po2', { channel: 'wechat', name: '张三', stage: 'arrived' }); // 无 consent / 无 phone
    await addAppointmentArrived('po2', Date.now() - 2 * DAY);
    const p = await planSopJobs();
    assert.equal(p.postOp, 0, '未授权客户不排术后关怀');
  });
});

describe('订单 / 复购率（P1-⑧）', () => {
  test('多笔订单 → 复购率与总成交金额正确', async () => {
    await upsertLead('o1', { channel: 'wechat', stage: 'deal' });
    await upsertLead('o2', { channel: 'wechat', stage: 'deal' });
    const now = Date.now();
    await upsertOrder({ orderId: 'ord1', tenantId: 'test', leadId: 'o1', project: '玻尿酸', amount: 3000, currency: 'CNY', status: 'paid', paidAt: now, createdAt: now, updatedAt: now });
    await upsertOrder({ orderId: 'ord2', tenantId: 'test', leadId: 'o1', project: '光子嫩肤', amount: 2000, currency: 'CNY', status: 'paid', paidAt: now, createdAt: now, updatedAt: now }); // 复购
    await upsertOrder({ orderId: 'ord3', tenantId: 'test', leadId: 'o2', project: '瘦脸', amount: 5000, currency: 'CNY', status: 'paid', paidAt: now, createdAt: now, updatedAt: now });

    const stats = await orderStats();
    assert.equal(stats.customerCount, 2);
    assert.equal(stats.orderCount, 3);
    assert.equal(stats.repurchaseCustomers, 1);
    assert.equal(stats.repurchaseRate, 50);
    assert.ok(Math.abs(stats.totalRevenue - 10000) < 1);
    const rev = stats.byProject.find((x) => x.project === '玻尿酸');
    assert.ok(rev && rev.revenue === 3000);
  });

  test('空数据 → 返回 0 值（fail-closed，绝不虚构）', async () => {
    const stats = await orderStats();
    assert.equal(stats.customerCount, 0);
    assert.equal(stats.orderCount, 0);
    assert.equal(stats.repurchaseRate, 0);
    assert.equal(stats.totalRevenue, 0);
  });
});

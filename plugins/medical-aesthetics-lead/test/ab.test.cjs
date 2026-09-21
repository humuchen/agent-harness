// A/B 分流实验（E 组）测试：
//   1) 创建实验：变体文案命中医疗广告红线 → INVALID_ARGUMENT；合法 → 建档
//   2) sticky 分流：同一线索多次分流结果一致；权重 100/0 → 全部落到对应变体
//   3) 报表（reply 口径）：分配后用户消息 → 计转化；无消息 → 0；样本量提示诚实
//   4) 报表（booking 口径）：分配后建预约单 → 计转化
//   5) 调度器集成：welcome 活跃实验 → 发件箱文案 = 变体文案 + 风险提示 + 载荷带实验标注
//   6) 停止实验 → 回落默认模板（零回归）
//   7) 不存在的实验 → NOT_FOUND
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let DATA_DIR;

test.beforeEach(() => {
  DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-ab-'));
  process.env.MA_DATA_DIR = DATA_DIR;
  process.env.MA_TENANT_ID = 'test';
  process.env.MA_OUTBOX_ENABLED = 'false';
  delete process.env.MA_OUTREACH_BASE_URL;
  try {
    require('../dist/infra/db').closeDb();
  } catch {}
  try {
    require('../dist/config').resetConfig();
  } catch {}
});

test.afterEach(() => {
  try {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  } catch {}
  try {
    require('../dist/infra/db').closeDb();
  } catch {}
});

const { upsertLead, appendLeadMessage } = require('../dist/repo/lead-repo');
const { getDb } = require('../dist/infra/db');
const {
  createExperiment,
  assignVariant,
  experimentReport,
  stopExperiment,
  resolveAbText,
  withRiskHint,
} = require('../dist/services/ab-service');
const { planSopJobs, runDueJobs } = require('../dist/services/scheduler-service');

/** 读取全部触达消息载荷。 */
async function outreachRows() {
  const db = await getDb();
  const rows = await db.prepare("SELECT * FROM ma_outbox WHERE topic = 'outreach.send' ORDER BY id").all();
  return rows.map((r) => ({ state: r.state, payload: JSON.parse(r.payload) }));
}

describe('实验创建与分流', () => {
  test('变体文案命中红线 → INVALID_ARGUMENT；合法 → 建档', async () => {
    await assert.rejects(
      () =>
        createExperiment({
          name: '回捞文案 A/B',
          topic: 'recall_first',
          variants: [
            { text: '您好，之前咨询的项目现在有面诊名额。' },
            { text: '做完保证不留疤，100%有效。' },
          ],
        }),
      /医疗广告合规红线/,
      '违规变体必须拒绝建实验'
    );
    const r = await createExperiment({
      name: '回捞文案 A/B',
      topic: 'recall_first',
      metric: 'reply',
      variants: [
        { key: 'A', text: '您好，上次了解的项目还有印象吗？方便的话可以约个面诊详细聊聊。' },
        { key: 'B', text: '好久不见～院区最近排了新的面诊时段，需要帮您留一个吗？' },
      ],
    });
    assert.match(r.experimentId, /^ab_/);
  });

  test('sticky 分流：同一线索结果稳定；权重 100/0 决定归属', async () => {
    const exp = (
      await createExperiment({
        name: '权重实验',
        topic: 'welcome',
        variants: [
          { key: 'A', text: '欢迎文案A。', weight: 100 },
          { key: 'B', text: '欢迎文案B。', weight: 0 },
        ],
      })
    ).experimentId;
    const a1 = await assignVariant(exp, 'lead-x');
    const a2 = await assignVariant(exp, 'lead-x');
    assert.equal(a1.variantKey, 'A', '权重 100 → 应落 A');
    assert.equal(a2.variantKey, a1.variantKey, '重复分流必须 sticky（同一变体）');

    const exp2 = (
      await createExperiment({
        name: '权重实验2',
        topic: 'recall_second',
        variants: [
          { key: 'A', text: '回捞A。', weight: 0 },
          { key: 'B', text: '回捞B。', weight: 100 },
        ],
      })
    ).experimentId;
    const b = await assignVariant(exp2, 'lead-y');
    assert.equal(b.variantKey, 'B', '权重 0/100 → 应落 B');
  });

  test('不存在的实验 → NOT_FOUND', async () => {
    await assert.rejects(() => assignVariant('ab_none', 'lead-z'), /不存在/);
    await assert.rejects(() => experimentReport('ab_none'), /不存在/);
  });
});

describe('报表（真实 SQL 归因）', () => {
  test('reply 口径：分配后的用户消息计转化', async () => {
    await upsertLead('m1', { channel: 'wechat', grade: 'B', stage: 'contacted', phone: '13800000000', consentAt: Date.now() });
    await upsertLead('m2', { channel: 'wechat', grade: 'B', stage: 'contacted', phone: '13900000000', consentAt: Date.now() });
    const exp = (
      await createExperiment({
        name: '回捞文案实验',
        topic: 'recall_first',
        metric: 'reply',
        variants: [
          { key: 'A', text: '回捞文案A。', weight: 100 },
          { key: 'B', text: '回捞文案B。', weight: 0 },
        ],
      })
    ).experimentId;
    await assignVariant(exp, 'm1');
    await assignVariant(exp, 'm2');
    await appendLeadMessage('m1', 'user', '在的，我想了解下'); // m1 回复了
    const rep = await experimentReport(exp);
    const a = rep.variants.find((v) => v.key === 'A');
    assert.equal(a.assigned, 2);
    assert.equal(a.conversions, 1, '只有 m1 分配后回复');
    assert.equal(a.conversionRate, 0.5);
    assert.match(rep.note, /样本量小/, '样本不足必须诚实提示');
  });

  test('booking 口径：分配后的预约单计转化', async () => {
    await upsertLead('m3', { channel: 'wechat', grade: 'A', stage: 'qualified', phone: '13700000000', consentAt: Date.now() });
    const exp = (
      await createExperiment({
        name: '预约转化实验',
        topic: 'recall_second',
        metric: 'booking',
        variants: [
          { key: 'A', text: '回捞B组。', weight: 100 },
          { key: 'B', text: '回捞B对照组。', weight: 0 },
        ],
      })
    ).experimentId;
    await assignVariant(exp, 'm3');
    const db = await getDb();
    await db
      .prepare(
        `INSERT INTO ma_appointment (appointment_id, tenant_id, lead_id, clinic_id, slot_id, slot_date, slot_time, status, created_at, updated_at)
         VALUES ('appt-m3', 'test', 'm3', 'c1', 's1', '2026-09-30', '10:00', 'booked', ?, ?)`
      )
      .run(Date.now(), Date.now());
    const rep = await experimentReport(exp);
    const a = rep.variants.find((v) => v.key === 'A');
    assert.equal(a.assigned, 1);
    assert.equal(a.conversions, 1, '分配后建单应计 booking 转化');
  });
});

describe('调度器集成', () => {
  test('welcome 活跃实验 → 发件箱用变体文案并带实验标注；无实验 → 默认模板', async () => {
    await upsertLead('w1', { channel: 'wechat', name: '王小明', stage: 'new' });
    // 无实验：默认模板
    await planSopJobs();
    await runDueJobs();
    let rows = await outreachRows();
    assert.equal(rows.length, 1);
    assert.ok(rows[0].payload.abVariant === undefined, '无实验时不应带实验标注');
    assert.match(rows[0].payload.text, /医疗美容有风险/);

    // 建 welcome 实验（weight 100 → 必落 A）→ 新线索走变体文案
    const exp = (
      await createExperiment({
        name: '欢迎语 A/B',
        topic: 'welcome',
        metric: 'reply',
        variants: [
          { key: 'A', text: '王小明您好，欢迎咨询～想先了解哪方面的项目？', weight: 100 },
          { key: 'B', text: '欢迎文案对照组。', weight: 0 },
        ],
      })
    ).experimentId;
    await upsertLead('w2', { channel: 'wechat', name: '李小红', stage: 'new' });
    await planSopJobs();
    await runDueJobs();
    rows = await outreachRows();
    const w2 = rows.find((r) => r.payload.leadId === 'w2');
    assert.ok(w2, 'w2 应产出欢迎语');
    assert.match(w2.payload.text, /欢迎咨询/, '应使用变体文案');
    assert.equal(w2.payload.abExperimentId, exp);
    assert.equal(w2.payload.abVariant, 'A');
    assert.match(w2.payload.text, /医疗美容有风险/, '变体文案发送时必须补风险提示');

    // 停止实验 → 回落默认模板
    await stopExperiment(exp);
    await upsertLead('w3', { channel: 'wechat', name: '张小虎', stage: 'new' });
    await planSopJobs();
    await runDueJobs();
    rows = await outreachRows();
    const w3 = rows.find((r) => r.payload.leadId === 'w3');
    assert.ok(w3);
    assert.ok(w3.payload.abVariant === undefined, '停止实验后应回落默认模板');
    assert.doesNotMatch(w3.payload.text, /欢迎咨询/, '不得再使用变体文案');
  });
});

test('withRiskHint：缺提示补齐，已有不重复', () => {
  assert.match(withRiskHint('你好'), /医疗美容有风险/);
  const t = '文案。医疗美容有风险，最终以面诊方案为准。';
  assert.equal(withRiskHint(t), t, '已含提示不得重复追加');
});

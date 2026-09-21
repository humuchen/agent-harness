// 调度器（B3）+ 回捞/SOP（B4/B5 v1）测试：
//   1) welcome 规划幂等 + 到期执行产出合规文案（含风险提示、无疗效承诺）
//   2) recall 2h/24h 双节点独立排期；幂等（重复规划不重复建）
//   3) 回捞资格门槛：未留资授权 / 无联系方式 / D 级 / 已转人工 → 不排期
//   4) 执行期复查：线索已转化（booked）→ skipped，不产出消息
//   5) 手动排期：自拟文案命中医疗广告红线 → 拒绝；合规文案 → 入队且未到期不执行
//   6) 投递链路：网关未配置 → 消息 pending 积压（诚实暴露）；配置 + mock fetch → 真实投递 sent
//   7) 投递失败（5xx）→ 保持 pending 退避重试（至少一次投递）
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let DATA_DIR;

test.beforeEach(() => {
  DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-sched-'));
  process.env.MA_DATA_DIR = DATA_DIR;
  process.env.MA_TENANT_ID = 'test';
  process.env.MA_OUTBOX_ENABLED = 'false';
  delete process.env.MA_OUTREACH_BASE_URL;
  delete process.env.MA_OUTREACH_TOKEN;
  delete process.env.MA_OUTREACH_RETRIES;
  delete process.env.MA_CRM_BASE_URL;
  delete process.env.MA_HIS_BASE_URL;
  delete process.env.MA_SCHEDULER_ENABLED;
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

const { upsertLead } = require('../dist/repo/lead-repo');
const { getDb } = require('../dist/infra/db');
const { jobStats } = require('../dist/repo/schedule-job-repo');
const { planSopJobs, runDueJobs, scheduleManualJob } = require('../dist/services/scheduler-service');
const { runOutboxOnce } = require('../dist/services/outbox-worker');
const { resetConfig } = require('../dist/config');

const HOUR = 3_600_000;

/** 回填线索最后活跃时间（模拟沉默时长）。 */
async function backdate(leadId, updatedAt) {
  const db = await getDb();
  await db.prepare('UPDATE ma_lead SET updated_at = ? WHERE lead_id = ?').run(updatedAt, leadId);
}

/** 读取全部触达消息（含状态）。 */
async function outreachRows() {
  const db = await getDb();
  return await db.prepare("SELECT * FROM ma_outbox WHERE topic = 'outreach.send' ORDER BY id").all();
}

describe('调度器：welcome 欢迎语', () => {
  test('新建线索 → 规划 welcome → 执行产出合规文案；重复规划幂等', async () => {
    await upsertLead('w1', { channel: 'wechat', name: '王小明', stage: 'new' });
    const p1 = await planSopJobs();
    assert.equal(p1.welcome, 1, '首次应排 1 条欢迎语');
    const p2 = await planSopJobs();
    assert.equal(p2.welcome, 0, '重复规划应被 scheduled_key 幂等去重');

    const run = await runDueJobs();
    assert.equal(run.done, 1);
    const rows = await outreachRows();
    assert.equal(rows.length, 1);
    const payload = JSON.parse(rows[0].payload);
    assert.equal(payload.leadId, 'w1');
    assert.match(payload.text, /面诊/);
    assert.match(payload.text, /医疗美容有风险/, '每条对客消息必须附风险提示');
    assert.doesNotMatch(payload.text, /保证|绝对|100%|百分百/, '模板文案不得含疗效承诺');
    const js = await jobStats();
    assert.equal(js.byState.done, 1);
  });
});

describe('调度器：recall 沉默回捞', () => {
  test('沉默 3h → 2h 节点；沉默 25h → 24h 节点；两节点独立且幂等', async () => {
    await upsertLead('r1', {
      channel: 'xiaohongshu', grade: 'C', stage: 'qualified', project: '热玛吉',
      phone: '13800000000', consentAt: Date.now(),
    });
    await backdate('r1', Date.now() - 3 * HOUR);
    const p1 = await planSopJobs();
    assert.equal(p1.recallFirst, 1, '沉默超 2h 应排 first 节点');
    assert.equal(p1.recallSecond, 0);

    await backdate('r1', Date.now() - 25 * HOUR);
    const p2 = await planSopJobs();
    assert.equal(p2.recallFirst, 0, 'first 已排过，应幂等');
    assert.equal(p2.recallSecond, 1, '沉默超 24h 应排 second 节点');

    const run = await runDueJobs();
    assert.equal(run.done, 2);
    const rows = await outreachRows();
    const topics = rows.map((r) => JSON.parse(r.payload).topic).sort();
    assert.deepEqual(topics, ['recall_first', 'recall_second']);
    const first = rows.map((r) => JSON.parse(r.payload)).find((p) => p.topic === 'recall_first');
    assert.equal(first.to.phone, '13800000000', '触达载荷应携带联系方式供网关路由');
    assert.match(first.text, /医疗美容有风险/);
  });

  test('资格门槛：无授权 / 无联系方式 / D 级 / 已转人工 → 均不排期', async () => {
    await upsertLead('r2', { channel: 'wechat', grade: 'C', stage: 'qualified' }); // 无联系方式无授权
    await upsertLead('r3', { channel: 'wechat', grade: 'C', stage: 'qualified', phone: '13900000000' }); // 无授权
    await upsertLead('r4', { channel: 'wechat', grade: 'D', stage: 'qualified', phone: '13700000000', consentAt: Date.now() });
    await upsertLead('r5', { channel: 'wechat', grade: 'C', stage: 'qualified', phone: '13600000000', consentAt: Date.now(), handedOff: true });
    for (const id of ['r2', 'r3', 'r4', 'r5']) await backdate(id, Date.now() - 5 * HOUR);
    const p = await planSopJobs();
    assert.equal(p.recallFirst, 0, '四类线索均不得回捞');
  });

  test('执行期复查：排期后线索转化为 booked → skipped 且不产出消息', async () => {
    await upsertLead('r6', {
      channel: 'wechat', grade: 'C', stage: 'qualified', phone: '13500000000', consentAt: Date.now(),
    });
    await backdate('r6', Date.now() - 3 * HOUR);
    await planSopJobs();
    await upsertLead('r6', { stage: 'booked' }); // 排期后转化
    const run = await runDueJobs();
    assert.equal(run.done, 1, 'skipped 计入 done 终态');
    const rows = await outreachRows();
    assert.equal(rows.length, 0, '已转化线索不得产出触达消息');
    const js = await jobStats();
    assert.equal(js.byState.skipped, 1);
  });
});

describe('调度器：手动排期（birthday/repurchase）', () => {
  test('自拟文案命中医疗广告红线 → 拒绝入队', async () => {
    await upsertLead('m1', { channel: 'wechat', name: '李雷' });
    await assert.rejects(
      () => scheduleManualJob({ jobType: 'birthday', leadId: 'm1', text: '生日快乐！保证不留疤，100%成功。' }),
      /医疗广告合规红线/,
      '命中疗效承诺词表必须拒绝'
    );
  });

  test('合规文案 → 入队；未到期不执行', async () => {
    await upsertLead('m2', { channel: 'wechat', name: '韩梅梅' });
    const dueAt = Date.now() + 24 * HOUR;
    const r = await scheduleManualJob({ jobType: 'birthday', leadId: 'm2', text: '韩梅梅生日快乐，祝您天天开心。', dueAt, key: 'bd:m2:2026' });
    assert.equal(r.scheduledKey, 'bd:m2:2026');
    const run = await runDueJobs();
    assert.equal(run.processed, 0, '未到期任务不得被消费');
    const js = await jobStats();
    assert.equal(js.byType.birthday, 1);
    assert.equal(js.byState.pending, 1);
  });
});

describe('投递链路（outreach.send → 渠道触达网关）', () => {
  test('网关未配置 → 消息保持 pending 积压（绝不假装已发送）', async () => {
    await upsertLead('d1', { channel: 'wechat', grade: 'C', stage: 'qualified', phone: '13400000000', consentAt: Date.now() });
    await backdate('d1', Date.now() - 3 * HOUR);
    await planSopJobs();
    await runDueJobs();
    assert.equal((await outreachRows()).length, 1);

    // 全部上游未配置：tick 按设计跳过（不做无谓尝试），积压保留
    process.env.MA_OUTBOX_ENABLED = 'true';
    resetConfig();
    await runOutboxOnce();
    let rows = await outreachRows();
    assert.equal(rows[0].state, 'pending', '无任何上游时保持 pending');

    // CRM 已配置但触达网关未配置：tick 执行到 outreach 投递 → NOT_CONFIGURED 诚实失败
    process.env.MA_CRM_BASE_URL = 'http://crm.test';
    resetConfig();
    await runOutboxOnce();
    rows = await outreachRows();
    assert.equal(rows[0].state, 'pending', '网关未配置必须保持 pending');
    assert.ok(Number(rows[0].attempts) >= 1, '应记录投递尝试');
    assert.ok(String(rows[0].last_error ?? '').length > 0, '应记录失败原因');
  });

  test('网关已配置 + mock fetch → 真实投递 sent；5xx → pending 退避后重投成功', async () => {
    await upsertLead('d2', { channel: 'wechat', grade: 'C', stage: 'qualified', phone: '13300000000', consentAt: Date.now() });
    await backdate('d2', Date.now() - 3 * HOUR);
    await planSopJobs();
    await runDueJobs();

    process.env.MA_OUTBOX_ENABLED = 'true';
    process.env.MA_OUTREACH_BASE_URL = 'http://gateway.test';
    process.env.MA_OUTREACH_TOKEN = 'tok';
    process.env.MA_OUTREACH_RETRIES = '0';
    resetConfig();

    const realFetch = globalThis.fetch;
    const calls = [];
    try {
      // 第一轮：网关 500 → 投递失败，保持 pending（至少一次投递）
      globalThis.fetch = async (url, init) => {
        calls.push({ url: String(url), init });
        return new Response(JSON.stringify({ error: 'boom' }), { status: 500 });
      };
      await runOutboxOnce();
      let rows = await outreachRows();
      assert.equal(rows[0].state, 'pending', '5xx 后应保持 pending 等待重试');
      assert.equal(JSON.parse(rows[0].payload).leadId, 'd2');

      // 第二轮：网关恢复 → 投递成功
      globalThis.fetch = async (url, init) => {
        calls.push({ url: String(url), init });
        return new Response(JSON.stringify({ ok: true, messageId: 'm1' }), { status: 200, headers: { 'content-type': 'application/json' } });
      };
      // markFailed 已把 next_retry_at 推到未来 → 手动放行（模拟退避到期）
      const db = await getDb();
      await db.prepare(`UPDATE ma_outbox SET next_retry_at = 0 WHERE topic = 'outreach.send'`).run();
      await runOutboxOnce();
      rows = await outreachRows();
      assert.equal(rows[0].state, 'sent', '网关恢复后应投递成功');
      assert.ok(calls.length >= 2);
      assert.match(calls[0].url, /\/v1\/messages$/, '应 POST 到网关 /v1/messages 契约端点');
      assert.equal(calls[0].init.headers['idempotency-key'], 'outreach:recall:d2:first', '幂等键应随重投保持一致');
      const body = JSON.parse(calls[calls.length - 1].init.body);
      assert.equal(body.to.phone, '13300000000');
      assert.match(body.text, /医疗美容有风险/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

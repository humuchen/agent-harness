// 硬兜底测试：consultation_book 失败自动转人工（防止「口头承诺转人工但队列为空」）。
// 覆盖：
//   1) booking 失败（NOT_FOUND：无可用院区）→ 自动 lead_handoff 落库 + 返回 autoHandoff 字段
//   2) booking 参数缺失（INVALID_ARGUMENT）→ 不触发自动转人工（模型可自愈）
//   3) booking 成功 → 不触发自动转人工（不误伤正常预约）
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ToolRegistry } = require('@agent-harness/core');

let DATA_DIR;

test.beforeEach(() => {
  DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-hardoff-'));
  process.env.MA_DATA_DIR = DATA_DIR;
  process.env.MA_TENANT_ID = 'test';
  process.env.MA_OUTBOX_ENABLED = 'false';
  delete process.env.MA_RAG_BASE_URL;
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

/** 构建只含 booking/handoff/qualify 工具的注册表，返回工具执行函数。 */
function buildTools() {
  const tools = new ToolRegistry();
  require('../dist/tools/book').registerBookTool(tools);
  require('../dist/tools/handoff').registerHandoffTool(tools);
  require('../dist/tools/qualify').registerQualifyTool(tools);
  const bookFn = tools.entries().find((e) => e.name === 'consultation_book').fn;
  return { bookFn };
}

/** 读临时库中某 lead 的转人工状态；库文件不存在时返回 undefined（查询空，不抛错）。 */
function handoffState(leadId) {
  const p = path.join(DATA_DIR, 'ma-lead.db');
  if (!fs.existsSync(p)) return undefined; // 从未触发过 DB 写入（如 INVALID_ARGUMENT 场景）
  const Database = require('node:sqlite').DatabaseSync;
  const db = new Database(p, { readOnly: true });
  const r = db.prepare('SELECT handed_off, handoff_reason, stage FROM ma_lead WHERE lead_id = ?').get(leadId);
  db.close();
  return r;
}

describe('consultation_book 硬兜底', () => {
  test('booking 失败（NOT_FOUND：无可用院区）→ 自动转人工落库 + autoHandoff 字段', async () => {
    const { bookFn } = buildTools();
    // 不导入任何院区/号源 → bookConsultation 抛 NOT_FOUND
    const res = await bookFn({ leadId: 'bk_1', clinic: '青岛市南院', date: '2026-08-23', time: '10:00' });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'NOT_FOUND');
    assert.ok(res.autoHandoff, '应返回 autoHandoff 信息');
    assert.equal(res.autoHandoff.handedOff, true);
    assert.equal(res.autoHandoff.leadId, 'bk_1');

    const r = handoffState('bk_1');
    assert.ok(r, '线索应已落库');
    assert.equal(r.handed_off, 1, '应标记转人工');
    assert.match(r.handoff_reason, /booking-failed:NOT_FOUND/, 'reason 应透传 error code');
    assert.match(r.handoff_reason, /青岛市南院|2026-08-23/, 'reason 应含院区/日期便于咨询师对接');
  });

  test('booking 参数缺失（INVALID_ARGUMENT）→ 不触发自动转人工（模型可自愈）', async () => {
    const { bookFn } = buildTools();
    const res = await bookFn({ leadId: 'bk_2' }); // 缺 clinic/date/time
    assert.equal(res.ok, false);
    assert.equal(res.code, 'INVALID_ARGUMENT');
    assert.equal(res.autoHandoff, undefined, 'INVALID_ARGUMENT 不应自动转人工');
    assert.equal(handoffState('bk_2'), undefined, '不应产生转人工线索');
  });

  test('booking 成功（存在院区+号源）→ 不触发自动转人工', async () => {
    // 先建档（真实流程中由 lead_qualify 创建线索），再导入院区与号源
    const sched = require('../dist/repo/schedule-repo');
    const leadSvc = require('../dist/services/lead-service');
    await leadSvc.qualifyLead({ leadId: 'bk_3', channel: '抖音', project: '皮肤管理', city: '青岛', grade: 'A' });
    sched.upsertClinic({ clinicId: 'c1', name: '青岛市南院', city: '青岛', active: true });
    sched.upsertSlot({ slotId: 's1', clinicId: 'c1', date: '2026-08-23', time: '10:00', capacity: 2 });

    const { bookFn } = buildTools();
    const res = await bookFn({ leadId: 'bk_3', clinic: '青岛市南院', date: '2026-08-23', time: '10:00' });
    assert.equal(res.ok, true, '应预约成功');
    assert.equal(res.autoHandoff, undefined, '成功不应触发自动转人工');
    const r = handoffState('bk_3');
    assert.ok(r, '线索应落库');
    assert.equal(r.handed_off, 0, '正常预约不应标记转人工');
  });

  test('重复失败调用幂等：同一 leadId 多次 booking 失败仍只有一条转人工记录', async () => {
    const { bookFn } = buildTools();
    const res1 = await bookFn({ leadId: 'bk_4', clinic: '不存在院区', date: '2026-08-23', time: '10:00' });
    const res2 = await bookFn({ leadId: 'bk_4', clinic: '不存在院区', date: '2026-08-23', time: '10:00' });
    assert.equal(res1.autoHandoff.handedOff, true);
    assert.equal(res2.autoHandoff.handedOff, true);
    const Database = require('node:sqlite').DatabaseSync;
    const db = new Database(path.join(DATA_DIR, 'ma-lead.db'), { readOnly: true });
    const n = db.prepare('SELECT COUNT(*) AS c FROM ma_lead WHERE lead_id = ?').get('bk_4').c;
    db.close();
    assert.equal(n, 1, '同 leadId 应只有一条记录（upsert 幂等）');
  });
});
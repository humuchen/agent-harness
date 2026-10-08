// P6 观测（方案三一期）：DbRunTraceStore / buildRunTraceRecord 契约测试。
// 用真实 sqlite 适配器（临时文件）验证建表 / 幂等 upsert / 列表排序 / 单查 / 体积降级剥离。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { buildRunTraceRecord, DbRunTraceStore } = require('../dist/workflow/store.js');
const { getDbAdapter } = require('../dist/db-adapter.js');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-trace-'));
const dbFile = path.join(tmpDir, 'trace.db');
const adapter = getDbAdapter({ backend: 'sqlite', file: dbFile });

test.after(() => {
  try {
    adapter.close?.();
  } catch { /* 关闭失败忽略 */ }
  for (const f of [dbFile, `${dbFile}-shm`, `${dbFile}-wal`]) {
    try {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    } catch { /* Windows EBUSY 容忍：临时目录由系统回收 */ }
  }
  try {
    fs.rmdirSync(tmpDir);
  } catch { /* 非空容忍 */ }
});

const mkRun = (over = {}) => ({
  def: { id: 'wf-tt', steps: [{ id: 'a', agentRef: 'x' }] },
  state: 'done',
  runId: 'r1',
  steps: {
    a: {
      id: 'a',
      state: 'done',
      output: { ok: 1 },
      attempts: 2,
      trace: [
        { type: 'llm:call', ts: 1, label: 'LLM 调用', detail: 'x'.repeat(50) },
        { type: 'tool:start', ts: 2, label: '工具' },
      ],
    },
  },
  ...over,
});

test('run-trace: save / get 幂等 upsert（同 runId 覆盖）', async () => {
  const store = new DbRunTraceStore({ adapter });
  await store.save(buildRunTraceRecord(mkRun()));
  await store.save(buildRunTraceRecord(mkRun())); // 同 (def, runId) 再存 → 覆盖不报错
  const got = await store.get('wf-tt', 'r1');
  assert.ok(got);
  assert.strictEqual(got.runId, 'r1');
  assert.strictEqual(got.state, 'done');
  assert.strictEqual(got.steps.a.attempts, 2);
  assert.strictEqual(got.steps.a.trace.length, 2);
  assert.strictEqual(got.steps.a.trace[0].detail, 'x'.repeat(50));
  assert.strictEqual(await store.get('wf-tt', 'nope'), null);
});

test('run-trace: list 按 ts 降序（新→旧）', async () => {
  const store = new DbRunTraceStore({ adapter });
  await store.save(buildRunTraceRecord(mkRun({ runId: 'r2', state: 'failed' })));
  await store.save(buildRunTraceRecord(mkRun({ runId: 'r3' })));
  const all = await store.list('wf-tt', 20);
  const ids = all.map((r) => r.runId);
  const tsOrder = all.map((r) => r.ts);
  assert.deepStrictEqual([...tsOrder].sort((a, b) => b - a), tsOrder, 'ts 降序');
  assert.ok(ids.includes('r1') && ids.includes('r2') && ids.includes('r3'));
  // limit 生效。
  const two = await store.list('wf-tt', 2);
  assert.strictEqual(two.length, 2);
  // 其它工作流隔离。
  assert.strictEqual((await store.list('wf-other', 20)).length, 0);
});

test('run-trace: 体积超限降级剥离 trace.detail（保时间轴/类型/标签）', () => {
  const bigDetail = 'y'.repeat(2_000_000);
  const rec = buildRunTraceRecord(
    mkRun({
      steps: {
        a: {
          id: 'a',
          state: 'done',
          trace: [{ type: 'llm:call', ts: 1, label: 'L', detail: bigDetail }],
        },
      },
    })
  );
  assert.ok(rec.ts > 0);
  assert.strictEqual(JSON.stringify(rec).length < 1_000_000, true, '降级后体积回到护栏内');
  assert.strictEqual(rec.steps.a.trace[0].detail, undefined);
  assert.strictEqual(rec.steps.a.trace[0].type, 'llm:call', '类型/标签保留');
});

test('run-trace: 无 runId 的 run 归档键为空串（server 端会跳过，store 侧仍可存储）', async () => {
  const store = new DbRunTraceStore({ adapter });
  const rec = buildRunTraceRecord(mkRun({ runId: undefined }));
  assert.strictEqual(rec.runId, '');
  await store.save(rec);
  assert.ok(await store.get('wf-tt', ''));
});

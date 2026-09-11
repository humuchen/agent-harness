'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

// 覆盖合规审计查询（读侧）：过滤 / 分页 / 聚合 / 倒序 / 容错。
// 审计写入侧（core audit + AUDIT_LOG）此前已就绪，本模块补齐读取侧。

const { queryAuditFile, resolveAuditFile, summarize } = require('../dist/audit-query.js');

function writeFixture(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-test-'));
  const file = path.join(dir, 'audit.jsonl');
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf-8');
  return { dir, file };
}

const SAMPLE = [
  { ts: '2026-09-11T10:00:00.000Z', actor: 'alice', action: 'agent.run.start', outcome: 'success', target: 'job1' },
  { ts: '2026-09-11T10:01:00.000Z', actor: 'alice', action: 'agent.run.end', outcome: 'success', target: 'job1' },
  { ts: '2026-09-11T10:02:00.000Z', actor: 'bob', action: 'env.create', outcome: 'success', target: 'env1' },
  { ts: '2026-09-11T10:03:00.000Z', actor: 'bob', action: 'mcp.add', outcome: 'denied', target: 'mcp1' },
  { ts: '2026-09-11T10:04:00.000Z', actor: 'carol', action: 'agent.run.start', outcome: 'failure', target: 'job2' },
  { ts: '2026-09-11T10:05:00.000Z', actor: 'alice', action: 'approvals.review', outcome: 'info', detail: { ticketId: 't1' } }
];

test('queryAuditFile: file 为 null 时返回空结果（未启用落盘）', async () => {
  const r = await queryAuditFile(null, {});
  assert.strictEqual(r.count, 0);
  assert.strictEqual(r.total, 0);
  assert.strictEqual(r.file, null);
  assert.deepStrictEqual(r.events, []);
});

test('queryAuditFile: 文件不存在时返回空结果但保留 file 路径', async () => {
  const r = await queryAuditFile(path.join(os.tmpdir(), 'not-exist-' + Date.now() + '.jsonl'), {});
  assert.strictEqual(r.total, 0);
  assert.ok(r.file, '应回显路径以便前端提示「未落盘」');
});

test('queryAuditFile: 默认按时间倒序返回（最新在前）', async () => {
  const { dir, file } = writeFixture(SAMPLE.map((e) => JSON.stringify(e)));
  try {
    const r = await queryAuditFile(file, {});
    assert.strictEqual(r.total, 6);
    assert.strictEqual(r.events[0].action, 'approvals.review', '最新事件应在首位');
    assert.strictEqual(r.events[5].action, 'agent.run.start', '最旧事件应在末位');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('queryAuditFile: 按 actor / action / outcome 过滤', async () => {
  const { dir, file } = writeFixture(SAMPLE.map((e) => JSON.stringify(e)));
  try {
    const byActor = await queryAuditFile(file, { actor: 'alice' });
    assert.strictEqual(byActor.total, 3, 'alice 有 3 条');

    const byAction = await queryAuditFile(file, { action: 'agent.run' });
    assert.strictEqual(byAction.total, 3, 'agent.run 子串命中 start/end');

    const byOutcome = await queryAuditFile(file, { outcome: 'denied' });
    assert.strictEqual(byOutcome.total, 1);
    assert.strictEqual(byOutcome.events[0].action, 'mcp.add');

    const combined = await queryAuditFile(file, { actor: 'bob', outcome: 'success' });
    assert.strictEqual(combined.total, 1, '多条件应取交集');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('queryAuditFile: 按时间窗口过滤（since/until）', async () => {
  const { dir, file } = writeFixture(SAMPLE.map((e) => JSON.stringify(e)));
  try {
    const since = Date.parse('2026-09-11T10:03:00.000Z');
    const r = await queryAuditFile(file, { since });
    assert.strictEqual(r.total, 3, '10:03 及之后有 3 条');
    const until = Date.parse('2026-09-11T10:01:00.000Z');
    const r2 = await queryAuditFile(file, { until });
    assert.strictEqual(r2.total, 2, '10:01 及之前有 2 条');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('queryAuditFile: 自由文本匹配 detail / target', async () => {
  const { dir, file } = writeFixture(SAMPLE.map((e) => JSON.stringify(e)));
  try {
    const r = await queryAuditFile(file, { q: 'job2' });
    assert.strictEqual(r.total, 1);
    assert.strictEqual(r.events[0].actor, 'carol');
    const r2 = await queryAuditFile(file, { q: 'ticketid' });
    assert.strictEqual(r2.total, 1, '应能在 detail JSON 中命中（大小写不敏感）');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('queryAuditFile: 分页（limit/offset）与 total 语义', async () => {
  const { dir, file } = writeFixture(SAMPLE.map((e) => JSON.stringify(e)));
  try {
    const p1 = await queryAuditFile(file, { limit: 2, offset: 0 });
    assert.strictEqual(p1.count, 2);
    assert.strictEqual(p1.total, 6, 'total 为过滤后总数，非本页条数');
    const p2 = await queryAuditFile(file, { limit: 2, offset: 2 });
    assert.notStrictEqual(p1.events[0].action, p2.events[0].action, '两页内容不应相同');
    const p4 = await queryAuditFile(file, { limit: 2, offset: 5 });
    assert.strictEqual(p4.count, 1, '末页只剩 1 条');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('queryAuditFile: 摘要聚合（outcome / topActions / actors / window）', async () => {
  const { dir, file } = writeFixture(SAMPLE.map((e) => JSON.stringify(e)));
  try {
    const r = await queryAuditFile(file, {});
    assert.strictEqual(r.summary.byOutcome.success, 3);
    assert.strictEqual(r.summary.byOutcome.denied, 1);
    assert.strictEqual(r.summary.byOutcome.failure, 1);
    assert.strictEqual(r.summary.byOutcome.info, 1);
    assert.strictEqual(r.summary.actors, 3, 'alice/bob/carol');
    assert.strictEqual(r.summary.topActions[0].count, 2, 'agent.run.start 出现 2 次并列第一');
    assert.ok(r.summary.window, '应给出时间窗口');
    assert.ok(r.summary.window.from < r.summary.window.to);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('queryAuditFile: 损坏行 / 空行被跳过，不影响其余记录', async () => {
  const lines = [
    JSON.stringify(SAMPLE[0]),
    '{ not valid json',
    '',
    JSON.stringify(SAMPLE[1]),
    '{"missing":"action"}'
  ];
  const { dir, file } = writeFixture(lines);
  try {
    const r = await queryAuditFile(file, {});
    assert.strictEqual(r.total, 2, '仅两条合法记录');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('summarize: 空数组返回零值摘要', () => {
  const s = summarize([]);
  assert.deepStrictEqual(s.byOutcome, {});
  assert.deepStrictEqual(s.topActions, []);
  assert.strictEqual(s.actors, 0);
  assert.strictEqual(s.window, undefined);
});

test('resolveAuditFile: env 优先，空串视为未配置', () => {
  assert.strictEqual(resolveAuditFile({ AUDIT_LOG: '/tmp/a.jsonl' }), '/tmp/a.jsonl');
  assert.strictEqual(resolveAuditFile({ AUDIT_LOG: '  ' }), null);
  assert.strictEqual(resolveAuditFile({}), null);
});

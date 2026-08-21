// 零依赖测试（node:test + node:assert）：覆盖 P2.a 审计日志 audit.ts。
// 关注：tenantId 维度记录、sink 注入、结构化 JSON 输出、sink 异常不影响主流程。

const test = require('node:test');
const assert = require('node:assert');

const { audit, setAuditSink } = require('../dist/audit.js');

test('audit：写入 sink 且填充 ts / tenantId / outcome', () => {
  const captured = [];
  setAuditSink((e) => captured.push(e));
  audit({ tenantId: 'tenant-finance', actor: 'user-7', action: 'agent.run.start', outcome: 'info', target: 'agent-x' });
  assert.strictEqual(captured.length, 1);
  const e = captured[0];
  assert.ok(e.ts, 'ts should be filled');
  assert.strictEqual(e.tenantId, 'tenant-finance');
  assert.strictEqual(e.action, 'agent.run.start');
  assert.strictEqual(e.outcome, 'info');
  setAuditSink(null);
});

test('audit：denied/failure 结果仍正常记录（不抛错）', () => {
  const captured = [];
  setAuditSink((e) => captured.push(e));
  audit({ tenantId: 't', action: 'quota.denied', outcome: 'denied', detail: { reason: 'qps' } });
  audit({ tenantId: 't', action: 'agent.run.end', outcome: 'failure', detail: { steps: 2 } });
  assert.strictEqual(captured.length, 2);
  assert.strictEqual(captured[0].outcome, 'denied');
  assert.strictEqual(captured[1].outcome, 'failure');
  setAuditSink(null);
});

test('audit：sink 抛错被吞，不向上传播', () => {
  setAuditSink(() => {
    throw new Error('sink boom');
  });
  // 不应抛出
  assert.doesNotThrow(() =>
    audit({ tenantId: 't', action: 'x', outcome: 'info' })
  );
  setAuditSink(null);
});

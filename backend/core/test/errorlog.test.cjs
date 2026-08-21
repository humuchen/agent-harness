// errorlog 错误明细存储：捕获、过滤 / 分页、摘要、文本报告，以及与 telemetry 错误路径的集成。
const assert = require('node:assert');
const test = require('node:test');

const {
  captureError,
  getErrorLog,
  getErrorSummary,
  clearErrorLog,
  formatErrorReport,
} = require('../dist/errorlog.js');

const {
  recordError,
  logError,
  emitAlert,
} = require('../dist/telemetry.js');

test('captureError 写入环形缓冲，getErrorLog 可回取', () => {
  clearErrorLog();
  const rec = captureError({ name: 'tool.shell', severity: 'error', type: 'Error', message: 'exit 1', stack: 'at x' });
  assert.ok(rec.id, '生成唯一 id');
  assert.strictEqual(typeof rec.time, 'number');
  assert.ok(rec.ts.startsWith('20'), 'ISO 时间字符串');
  const list = getErrorLog();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].name, 'tool.shell');
  assert.strictEqual(list[0].message, 'exit 1');
  assert.strictEqual(list[0].stack, 'at x');
});

test('getErrorLog 支持 name / severity / 时间过滤与 limit 分页', () => {
  clearErrorLog();
  // 显式指定时间，保证 since/until 过滤确定性。
  captureError({ name: 'a', message: '1', time: 1000 });
  captureError({ name: 'b', severity: 'fatal', message: '2', time: 2000 });
  captureError({ name: 'a', message: '3', time: 3000 });
  const all = getErrorLog();
  assert.strictEqual(all.length, 3);
  assert.strictEqual(getErrorLog({ name: 'a' }).length, 2);
  assert.strictEqual(getErrorLog({ severity: 'fatal' }).length, 1);
  assert.strictEqual(getErrorLog({ limit: 2 }).length, 2, 'limit 取最近 N 条');
  assert.strictEqual(getErrorLog({ since: 1500 }).length, 2, 'since 过滤');
  assert.strictEqual(getErrorLog({ until: 2500 }).length, 2, 'until 过滤');
});

test('getErrorSummary 给出总数 + 按名称 / 级别分布 + 时间跨度', () => {
  clearErrorLog();
  captureError({ name: 'a', message: '1', time: 1000 });
  captureError({ name: 'a', message: '2', time: 2000 });
  captureError({ name: 'b', severity: 'fatal', message: '3', time: 3000 });
  const s = getErrorSummary();
  assert.strictEqual(s.total, 3);
  assert.strictEqual(s.byName.a, 2);
  assert.strictEqual(s.byName.b, 1);
  assert.strictEqual(s.bySeverity.error, 2);
  assert.strictEqual(s.bySeverity.fatal, 1);
  assert.strictEqual(s.firstSeen, 1000);
  assert.strictEqual(s.lastSeen, 3000);
});

test('clearErrorLog 清空缓冲', () => {
  captureError({ name: 'tmp', message: 'x' });
  assert.ok(getErrorLog().length >= 1);
  clearErrorLog();
  assert.strictEqual(getErrorLog().length, 0);
  assert.strictEqual(getErrorSummary().total, 0);
});

test('formatErrorReport 文本报告含数量 + 名称分布 + 逐条明细', () => {
  clearErrorLog();
  captureError({ name: 'tool.shell', severity: 'error', type: 'Error', message: 'boom', stack: 'at fn (file.ts:1:1)' });
  const txt = formatErrorReport();
  assert.ok(txt.includes('系统错误报告'));
  assert.ok(txt.includes('错误总数: 1'));
  assert.ok(txt.includes('tool.shell'));
  assert.ok(txt.includes('类型: Error'));
  assert.ok(txt.includes('消息: boom'));
  assert.ok(txt.includes('at fn (file.ts:1:1)'), '堆栈被纳入报告');
});

test('recordError 计数同时捕获明细（传入 Error 时含 type/stack）', () => {
  clearErrorLog();
  const err = new TypeError('bad arg');
  recordError('guardrail.input', err);
  const s = getErrorSummary();
  assert.strictEqual(s.total, 1);
  const rec = getErrorLog()[0];
  assert.strictEqual(rec.name, 'guardrail.input');
  assert.strictEqual(rec.type, 'TypeError', '错误类型被捕获');
  assert.strictEqual(rec.message, 'bad arg', '错误消息被捕获');
  assert.ok(rec.stack && rec.stack.includes('TypeError'), '堆栈被捕获');
});

test('logError 从 Error 抽取 message/stack 入库', () => {
  clearErrorLog();
  const e = new Error('disk full');
  e.stack = 'Error: disk full\n    at write (io.ts:9:3)';
  logError('fs.write', e, { runId: 'r1' });
  const rec = getErrorLog()[0];
  assert.strictEqual(rec.name, 'fs.write');
  assert.strictEqual(rec.message, 'disk full');
  assert.ok(rec.stack.includes('io.ts:9:3'));
  assert.ok(rec.fields && rec.fields.runId === 'r1', '附加上下文被保留');
});

test('emitAlert error/fatal 级别进入错误明细，warn 不进', () => {
  clearErrorLog();
  emitAlert('warn', 'low.mem', 'memory high');
  assert.strictEqual(getErrorLog().length, 0, 'warn 不计入错误明细');
  emitAlert('error', 'crash.guard', 'unhandled rejection', { where: 'scheduler' });
  emitAlert('fatal', 'oom', 'out of memory');
  const list = getErrorLog();
  assert.strictEqual(list.length, 2);
  assert.strictEqual(list[0].severity, 'error');
  assert.strictEqual(list[0].name, 'alert.crash.guard');
  assert.strictEqual(list[0].message, 'unhandled rejection');
  assert.ok(list[0].fields && list[0].fields.where === 'scheduler', '告警上下文入库');
  assert.strictEqual(list[1].severity, 'fatal');
});

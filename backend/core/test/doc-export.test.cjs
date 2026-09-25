'use strict';
// builtin__doc_export 单测（P-交付闭环：xlsx / pptx / csv 真文件生成）。
// 覆盖：csv 零依赖生成（含 RFC4180 转义 + 对象数组表头）、文件名安全化与扩展名归一、
// 参数缺失报错；xlsx / pptx 在可选依赖（exceljs / pptxgenjs）缺失时自动 skip，
// 存在时校验产物为合法 zip 容器（PK 魔数）。
//
// 运行：pnpm --filter @agent-harness/core run build && node --test test/doc-export.test.cjs

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const { mkdtempSync, rmSync, readFileSync, existsSync } = require('node:fs');

const { ToolRegistry } = require('../dist/tools.js');
const { registerBuiltinTools } = require('../dist/builtins/index.js');

function optionalDepsInstalled(name) {
  try {
    require(name);
    return true;
  } catch {
    return false;
  }
}

const hasExcelJs = optionalDepsInstalled('exceljs');
const hasPptxGenJs = optionalDepsInstalled('pptxgenjs');

function makeRegistry(root) {
  const reg = new ToolRegistry();
  registerBuiltinTools(reg, { root: root, webEnabled: false, weatherEnabled: false });
  return reg;
}

test('doc_export csv: 对象数组自动加表头，字段含逗号/引号按 RFC4180 转义', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ah-doe-'));
  try {
    const reg = makeRegistry(root);
    const out = await reg.call('builtin__doc_export', {
      format: 'csv',
      filename: '汇总.csv',
      rows: [
        { name: '张三', note: '含,逗号' },
        { name: '李"四"', note: '含"引号' }
      ]
    });
    const parsed = JSON.parse(out);
    assert.ok(parsed.ok === true);
    assert.ok(parsed.path.startsWith('exports'));
    const content = readFileSync(path.join(root, 'exports', '汇总.csv'), 'utf-8');
    const lines = content.trim().split('\r\n');
    assert.strictEqual(lines[0], 'name,note');
    assert.strictEqual(lines[1], '张三,"含,逗号"');
    assert.strictEqual(lines[2], '"李""四""","含""引号"');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('doc_export: 文件名安全化（去路径分隔符）并强制归一扩展名', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ah-doe-'));
  try {
    const reg = makeRegistry(root);
    const out = await reg.call('builtin__doc_export', {
      format: 'csv',
      filename: '../evil:name.csv.txt',
      rows: [['a', 'b']]
    });
    const parsed = JSON.parse(out);
    assert.ok(parsed.ok === true);
    // ../ 被剥掉、冒号被替换、扩展名补成 .csv（原 .txt 后缀仍在名字里但扩展名归一为 .csv）
    assert.strictEqual(parsed.path, path.join('exports', 'evilname.csv.txt.csv'));
    assert.ok(existsSync(path.join(root, 'exports', 'evilname.csv.txt.csv')));
    assert.ok(!existsSync(path.join(root, 'evil:name.csv.txt')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('doc_export: 缺 rows / sheets / slides 时返回可操作错误', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ah-doe-'));
  try {
    const reg = makeRegistry(root);
    const noRows = await reg.call('builtin__doc_export', { format: 'csv', filename: 'x.csv' });
    assert.ok(noRows.startsWith('error: csv 需要非空 rows'));
    const noSheets = await reg.call('builtin__doc_export', { format: 'xlsx', filename: 'x.xlsx' });
    assert.ok(noSheets.startsWith('error: xlsx 需要非空 sheets'));
    const noSlides = await reg.call('builtin__doc_export', { format: 'pptx', filename: 'x.pptx' });
    assert.ok(noSlides.startsWith('error: pptx 需要非空 slides'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('doc_export xlsx: 生成合法 zip 容器（exceljs 可选依赖）', { skip: hasExcelJs ? false : 'exceljs 未安装' }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ah-doe-'));
  try {
    const reg = makeRegistry(root);
    const out = await reg.call('builtin__doc_export', {
      format: 'xlsx',
      filename: '季度汇总.xlsx',
      sheets: [
        { name: '销售', rows: [['月份', '金额'], ['1月', 100], ['2月', 200.5]] },
        { name: '成本', rows: [{ item: '人力', cost: 80 }] }
      ]
    });
    const parsed = JSON.parse(out);
    assert.ok(parsed.ok === true, out);
    assert.ok(parsed.bytes > 0);
    const buf = readFileSync(path.join(root, 'exports', '季度汇总.xlsx'));
    // xlsx 是 zip 容器：以 PK 魔数开头
    assert.strictEqual(buf[0], 0x50);
    assert.strictEqual(buf[1], 0x4b);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('doc_export pptx: 生成合法 zip 容器（pptxgenjs 可选依赖）', { skip: hasPptxGenJs ? false : 'pptxgenjs 未安装' }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ah-doe-'));
  try {
    const reg = makeRegistry(root);
    const out = await reg.call('builtin__doc_export', {
      format: 'pptx',
      filename: '季度汇报.pptx',
      slides: [
        { title: 'Q3 业绩', bullets: ['营收增长 20%', '新客 1200 家'], notes: '开场页' },
        { title: '风险与对策', bullets: ['汇率波动'] }
      ]
    });
    const parsed = JSON.parse(out);
    assert.ok(parsed.ok === true, out);
    const buf = readFileSync(path.join(root, 'exports', '季度汇报.pptx'));
    assert.strictEqual(buf[0], 0x50);
    assert.strictEqual(buf[1], 0x4b);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('doc_export: 默认注册、可按 tools 收窄、可按开关禁用', () => {
  const { registerBuiltinTools: reg2 } = require('../dist/builtins/index.js');
  const reg = new ToolRegistry();
  reg2(reg, {});
  assert.strictEqual(reg.has('builtin__doc_export'), true);

  const narrowed = new ToolRegistry();
  reg2(narrowed, { tools: ['calculator'] });
  assert.strictEqual(narrowed.has('builtin__doc_export'), false);

  const disabled = new ToolRegistry();
  reg2(disabled, { docExportEnabled: false });
  assert.strictEqual(disabled.has('builtin__doc_export'), false);
});

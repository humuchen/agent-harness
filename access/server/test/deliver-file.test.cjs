'use strict';
// builtin__deliver_file 单测（P-交付闭环：文件 → artifact-store 交付注册）。
// 覆盖：sessionKey → runId 推导（plan 步骤 / 子 agent / 聊天会话 / 空）、
// 扩展名 MIME 猜测、展示名安全化，以及端到端注册（写沙箱文件 → 工具调用 →
// artifact-store list(runId) 命中 + readContent 字节往返）、逃逸与不存在路径拒绝。
//
// 运行：pnpm --filter @agent-harness/server run build && node --test test/deliver-file.test.cjs

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');

const { ToolRegistry } = require('@agent-harness/core');
const { getArtifactStore, setArtifactStore } = require('../dist/artifact-store.js');
const {
  registerDeliverFileTool,
  deriveRunIdFromSessionKey,
  guessMime,
  sanitizeDisplayName
} = require('../dist/deliver-file.js');

/* --------------------- 纯函数 --------------------- */

test('deriveRunIdFromSessionKey: plan 步骤 / 子 agent / 聊天 / 空值', () => {
  assert.strictEqual(deriveRunIdFromSessionKey('wf:plan-123:t2'), 'plan-123');
  assert.strictEqual(deriveRunIdFromSessionKey('wf:plan-123:t2:card-x'), 'plan-123');
  assert.strictEqual(deriveRunIdFromSessionKey('wf:wfid'), 'wfid');
  assert.strictEqual(deriveRunIdFromSessionKey('chat-session-9'), 'chat-session-9');
  assert.strictEqual(deriveRunIdFromSessionKey(''), null);
  assert.strictEqual(deriveRunIdFromSessionKey(undefined), null);
});

test('guessMime: office / 文本 / 未识别', () => {
  assert.strictEqual(guessMime('a.xlsx'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.strictEqual(guessMime('b.pptx'), 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
  assert.strictEqual(guessMime('c.CSV'), 'text/csv');
  assert.strictEqual(guessMime('d.md'), 'text/markdown');
  assert.strictEqual(guessMime('noext'), 'application/octet-stream');
});

test('sanitizeDisplayName: 去非法字符并限长，空回落 basename', () => {
  assert.strictEqual(sanitizeDisplayName('报 告:v1?.xlsx', 'fallback.xlsx'), '报 告v1.xlsx');
  assert.strictEqual(sanitizeDisplayName('', 'file.csv'), 'file.csv');
  assert.strictEqual(sanitizeDisplayName('   ', 'file.csv'), 'file.csv');
  assert.strictEqual(sanitizeDisplayName('x'.repeat(200), 'fb').length, 120);
});

/* --------------------- 端到端注册 --------------------- */

let tmpRoot = '';
let tmpArtifacts = '';

test.beforeEach(() => {
  setArtifactStore(null);
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'ah-dlv-root-'));
  tmpArtifacts = mkdtempSync(path.join(os.tmpdir(), 'ah-dlv-art-'));
  process.env.ARTIFACT_DIR = tmpArtifacts;
});

test.afterEach(() => {
  setArtifactStore(null);
  delete process.env.ARTIFACT_DIR;
  for (const d of [tmpRoot, tmpArtifacts]) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响结论 */
    }
  }
});

function makeRegistry(sessionKey) {
  const reg = new ToolRegistry();
  registerDeliverFileTool(reg, { fsRoot: tmpRoot, sessionKey });
  return reg;
}

test('deliver_file: plan 步骤 sessionKey 下注册，list(runId) 命中且字节往返一致', async () => {
  mkdirSync(path.join(tmpRoot, 'exports'), { recursive: true });
  const payload = '月份,金额\n1月,100\n2月,200.5\n';
  writeFileSync(path.join(tmpRoot, 'exports', '汇总.csv'), payload, 'utf-8');

  const reg = makeRegistry('wf:my-plan-42:t3');
  const out = await reg.call('builtin__deliver_file', {
    path: 'exports/汇总.csv',
    name: '季度汇总表.csv',
    note: 'Q3 数据'
  });
  const parsed = JSON.parse(out);
  assert.ok(parsed.ok === true, out);
  assert.strictEqual(parsed.runId, 'my-plan-42');

  const metas = await getArtifactStore().list('my-plan-42');
  assert.strictEqual(metas.length, 1);
  assert.strictEqual(metas[0].name, '季度汇总表.csv');
  assert.strictEqual(metas[0].kind, 'agent-file-delivery');
  assert.strictEqual(metas[0].mimeType, 'text/csv');
  assert.strictEqual(metas[0].owner, 'anonymous');
  const content = await getArtifactStore().readContent(metas[0].id);
  assert.ok(content.equals(Buffer.from(payload, 'utf-8')));
});

test('deliver_file: 逃逸路径 / 目录 / 不存在文件被拒绝', async () => {
  // beforeEach 会重建全新 tmpRoot：目录用例需自建 exports/ 才能真正覆盖。
  mkdirSync(path.join(tmpRoot, 'exports'), { recursive: true });
  const reg = makeRegistry('wf:plan-x:t1');
  const esc = await reg.call('builtin__deliver_file', { path: '../outside.txt' });
  assert.ok(esc.startsWith('error: path escapes root'), esc);
  const abs = await reg.call('builtin__deliver_file', { path: '/etc/hosts' });
  assert.ok(abs.startsWith('error: absolute paths not allowed'), abs);
  const dir = await reg.call('builtin__deliver_file', { path: 'exports' });
  assert.ok(dir.startsWith('error: is a directory'), dir);
  const missing = await reg.call('builtin__deliver_file', { path: 'exports/none.csv' });
  assert.ok(missing.startsWith('error: file not found'), missing);
});

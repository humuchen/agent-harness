'use strict';
/**
 * 审计出口脱敏 + 文件写失败告警 + 大小轮转测试。
 * structLogAudit 此前绕过全局 scrubber（console.log 直出）——修复后所有审计出口
 * （stdout 行 + 落盘文件行）统一过 scrubFields 兜底。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const distAudit = path.join(__dirname, '..', 'dist', 'audit.js');

/** 临时接管 console，收集审计 stdout 行。 */
function captureConsole(fn) {
  const lines = [];
  const origLog = console.log;
  const origWarn = console.warn;
  console.log = (...a) => lines.push(a.join(' '));
  console.warn = (...a) => lines.push(a.join(' '));
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      console.log = origLog;
      console.warn = origWarn;
    }).then(() => lines);
}

test('audit：出口结构化日志过全局脱敏（detail 含 apiKey 字段被 REDACT）', async () => {
  const { audit } = require(distAudit);
  const lines = await captureConsole(() =>
    audit({
      action: 'agent.run.start',
      outcome: 'info',
      actor: 'u1',
      detail: { apiKey: 'sk-abcdefghijklmnopqrstuvwx', note: 'hello' }
    })
  );
  const hit = lines.find((l) => l.includes('agent.run.start'));
  assert.ok(hit, '应有一条审计 stdout 行');
  assert.ok(!hit.includes('sk-abcdefghijklmnopqrstuvwx'), '密钥值不得明文出现');
  assert.ok(hit.includes('[REDACTED]'), '应含 REDACT 标记');
  assert.ok(hit.includes('hello'), '非敏感字段保留');
});

test('audit：出口值级脱敏（自由文本中的 token=xxx 被拦）', async () => {
  const { audit } = require(distAudit);
  const lines = await captureConsole(() =>
    audit({
      action: 'x.y',
      outcome: 'info',
      target: 'token: tok-abcdefghij1234567890'
    })
  );
  const hit = lines.find((l) => l.includes('x.y'));
  assert.ok(hit, '应有一条审计 stdout 行');
  assert.ok(!hit.includes('tok-abcdefghij1234567890'), '值级敏感串不得明文出现');
  assert.ok(hit.includes('[REDACTED]'));
});

test('audit：文件写失败计数告警（句柄写入抛错时 stdout 出现 warn）', async () => {
  const mod = require(distAudit);
  // 注入一个必然抛错的假句柄（绕过 enableAuditFile 的真实文件打开）
  const lines = await captureConsole(async () => {
    mod.__setAuditFileHandleForTest__({
      write: async () => {
        throw new Error('ENOSPC: no space left');
      }
    });
    await mod.audit({ action: 'a.b', outcome: 'info' });
    await mod.audit({ action: 'c.d', outcome: 'info' });
  });
  const warns = lines.filter((l) => l.includes('audit file write failed'));
  assert.strictEqual(warns.length, 1, '连续失败首条告警（限流，不刷屏）');
  assert.ok(warns[0].includes('ENOSPC'));
});

test('audit：超过 AUDIT_LOG_MAX_BYTES 触发轮转（<file>.1 生成）', async () => {
  // 用独立模块实例（env 在 require 前设置才生效）
  const file = path.join(os.tmpdir(), `ah-audit-rot-${process.pid}-${Date.now()}.jsonl`);
  process.env.AUDIT_LOG_MAX_BYTES = '400';
  delete require.cache[distAudit];
  try {
    const mod = require(distAudit);
    await mod.enableAuditFile(file);
    for (let i = 0; i < 20; i++) {
      await mod.audit({ action: 'rotate.test', outcome: 'info', target: `entry-${i}` });
    }
    assert.ok(fs.existsSync(file + '.1'), '应生成轮转文件');
    assert.ok(fs.existsSync(file), '新文件应继续写入');
    const rotated = fs.readFileSync(file + '.1', 'utf8').trim().split('\n');
    assert.ok(rotated.length >= 1, '轮转文件非空');
  } finally {
    delete process.env.AUDIT_LOG_MAX_BYTES;
    delete require.cache[distAudit];
    for (const f of [file, file + '.1']) {
      try { fs.unlinkSync(f); } catch { /* ignore */ }
    }
  }
});

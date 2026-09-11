'use strict';
// 技能注册表（P2-Skills）后端单测。
// 覆盖：首次访问 SEED 默认技能并持久化、setEnabled 落盘生效、未知 id 返回 null、
// getSkillRegistry / setSkillRegistry 单例注入与重置。
//
// 运行：pnpm --filter @agent-harness/server run build && node --test test/skill-registry.test.cjs

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const { mkdtempSync, rmSync, existsSync, readFileSync } = require('node:fs');

const { getSkillRegistry, setSkillRegistry } = require('../dist/skill-registry.js');

// 每个用例前重置单例 + 指向一个全新临时文件（保证「首次访问」会 SEED）。
test.beforeEach(() => {
  setSkillRegistry(null);
  const dir = mkdtempSync(path.join(os.tmpdir(), 'skills-'));
  process.env.SKILL_REGISTRY_FILE = path.join(dir, 'skills.json');
});

// 清理临时目录，避免残留。
test.afterEach(() => {
  const f = process.env.SKILL_REGISTRY_FILE;
  if (f) rmSync(path.dirname(f), { recursive: true, force: true });
  delete process.env.SKILL_REGISTRY_FILE;
});

test('fresh registry seeds defaults: list() length >= 3, contains doc-gen enabled:true', async () => {
  const reg = getSkillRegistry();
  const items = await reg.list();
  assert.ok(items.length >= 3, 'list length 应 >= 3');
  const doc = items.find((s) => s.id === 'doc-gen');
  assert.ok(doc, '应包含 doc-gen');
  assert.strictEqual(doc.enabled, true, 'doc-gen 默认启用');
  // 首次访问应已把种子持久化到文件。
  assert.ok(existsSync(process.env.SKILL_REGISTRY_FILE), '种子应已落盘');
});

test('setEnabled persists: 新实例重读文件仍显示 disabled', async () => {
  const reg = getSkillRegistry();
  const updated = await reg.setEnabled('doc-gen', false);
  assert.ok(updated, '已知 id 应返回 def');
  assert.strictEqual(updated.enabled, false, '返回值 enabled:false');

  // 文件层已更新。
  const raw = JSON.parse(readFileSync(process.env.SKILL_REGISTRY_FILE, 'utf-8'));
  const persisted = raw.find((s) => s.id === 'doc-gen');
  assert.ok(persisted, '文件中应有 doc-gen');
  assert.strictEqual(persisted.enabled, false, '文件层应已禁用');

  // 通过新 getSkillRegistry()（重读文件）验证持久化。
  const reg2 = getSkillRegistry();
  const items2 = await reg2.list();
  const reread = items2.find((s) => s.id === 'doc-gen');
  assert.ok(reread, '重读仍应有 doc-gen');
  assert.strictEqual(reread.enabled, false, '持久化验证：仍为 disabled');
});

test('setEnabled unknown id returns null', async () => {
  const reg = getSkillRegistry();
  const res = await reg.setEnabled('nope', true);
  assert.strictEqual(res, null, '未知 id 应返回 null');
});

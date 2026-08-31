/**
 * memo 插件单元测试（零依赖，node --test，require 编译产物 dist）。
 * 覆盖：manifest 形状 / 工具读写闭环 / 触发词命中 repo-verify / 路由扩展形状。
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const core = require('../../../backend/core/dist/index.js');
const plugin = require('../dist/index.js');

/** 每个用例独立的临时数据目录（MEMO_DATA_DIR 由 store 惰性读取）。 */
function freshDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memo-test-'));
  process.env.MEMO_DATA_DIR = dir;
  return dir;
}

test('manifest 形状：id/capabilities/assembly.skills 收窄', () => {
  const m = plugin.memoPlugin.manifest;
  assert.equal(m.id, 'memo');
  assert.ok(Array.isArray(m.capabilities) && m.capabilities.length > 0, 'capabilities 非空');
  assert.ok(m.assembly, 'assembly 存在');
  assert.ok(
    Array.isArray(m.assembly.skills) && m.assembly.skills.includes('repo-verify'),
    'assembly.skills 应收窄为包含 repo-verify'
  );
  // JSON-only 约定：清单必须可无损序列化
  const round = JSON.parse(JSON.stringify(m));
  assert.deepEqual(round, m);
});

test('工具注册与读写闭环：save → list → delete', async () => {
  freshDataDir();
  const reg = new core.ToolRegistry();
  plugin.registerNoteTools(reg);

  // save
  const saved = await reg.call('note_save', { text: '今天对接医美看板', tag: 'work' });
  assert.equal(saved.ok, true);
  assert.ok(saved.id, '应返回备忘 id');

  // list
  const listed = await reg.call('note_list', {});
  assert.equal(listed.ok, true);
  assert.equal(listed.total, 1);
  assert.equal(listed.notes[0].text, '今天对接医美看板');

  // tag 过滤
  const miss = await reg.call('note_list', { tag: 'idea' });
  assert.equal(miss.total, 0);

  // delete
  const del = await reg.call('note_delete', { id: saved.id });
  assert.equal(del.deleted, true);
  const after = await reg.call('note_list', {});
  assert.equal(after.total, 0);
});

test('工具参数校验：空 text / 空 id 返回 error 结构（不抛错中断）', async () => {
  freshDataDir();
  const reg = new core.ToolRegistry();
  plugin.registerNoteTools(reg);

  const badSave = await reg.call('note_save', { text: '   ' });
  assert.equal(badSave.error, true);

  const badDel = await reg.call('note_delete', { id: 'not-exist' });
  assert.equal(badDel.ok, true);
  assert.equal(badDel.deleted, false);
});

test('触发词命中：repo-verify 技能可被「构建/验证」类输入预激活', () => {
  const reg = new core.SkillRegistry();
  reg.registerMany(core.defaultSkills());

  const hits = reg.matchTriggers('帮我验证一下仓库构建是否全绿');
  assert.ok(hits.some((s) => s.id === 'repo-verify'), '应命中 repo-verify');

  // 技能描述注入系统提示词的目录应包含该技能
  const catalog = reg.describeForPrompt();
  assert.ok(catalog.includes('repo-verify'));
});

test('assembly.skills 收窄：memo agent 只启用 repo-verify', () => {
  const reg = new core.SkillRegistry();
  const skills = core.defaultSkills().filter(
    (s) => plugin.memoPlugin.manifest.assembly.skills.includes(s.id)
  );
  reg.registerMany(skills);
  assert.deepEqual(reg.list().map((s) => s.id), ['repo-verify']);
});

test('服务端扩展形状：纯路径路由 key + 方法内判断', () => {
  const ext = plugin.memoServerExtension;
  assert.equal(ext.id, 'memo');
  assert.equal(typeof ext.mountRoutes['/notes'], 'function');
  assert.equal(typeof ext.mountRoutes['/note'], 'function');
});

test('前端视图形状：tabId/label/render 返回含 --ah-* 令牌的 HTML', () => {
  const view = plugin.memoBoardView;
  assert.equal(view.tabId, 'memo');
  const html = view.render();
  assert.ok(typeof html === 'string');
  assert.ok(html.includes('--ah-'), '样式应使用 --ah-* 主题令牌');
});

// ---------------------------------------------------------------------------
// 边界测试：并发 / 超大文本 / 非法 tag / 存储损坏回退
// ---------------------------------------------------------------------------

test('边界：并发保存全部落盘（无丢失）', async () => {
  freshDataDir();
  const reg = new core.ToolRegistry();
  plugin.registerNoteTools(reg);
  const N = 12;
  const calls = Array.from({ length: N }, (_, i) =>
    reg.call('note_save', { text: `并发备忘 #${i}` })
  );
  const results = await Promise.all(calls);
  assert.ok(results.every((r) => r.ok), '全部保存应成功');
  const listed = await reg.call('note_list', {});
  assert.equal(listed.total, N, '并发保存不应丢条目');
});

test('边界：超大文本（~1MB）往返一致', async () => {
  freshDataDir();
  const reg = new core.ToolRegistry();
  plugin.registerNoteTools(reg);
  const big = 'x'.repeat(1024 * 1024) + '末尾标记';
  const saved = await reg.call('note_save', { text: big, tag: 'big' });
  assert.equal(saved.ok, true);
  const listed = await reg.call('note_list', { tag: 'big' });
  assert.equal(listed.total, 1);
  assert.equal(listed.notes[0].text.length, big.length);
  assert.ok(listed.notes[0].text.endsWith('末尾标记'));
});

test('边界：非法/空 tag 处理（空串按无 tag，特殊字符原样存）', async () => {
  freshDataDir();
  const reg = new core.ToolRegistry();
  plugin.registerNoteTools(reg);

  const emptyTag = await reg.call('note_save', { text: '空标签', tag: '' });
  assert.equal(emptyTag.ok, true);
  assert.equal(emptyTag.tag, null, '空串 tag 应归一为无标签');

  const weirdTag = await reg.call('note_save', { text: '怪异标签', tag: 'a/b:c#d' });
  assert.equal(weirdTag.ok, true);
  assert.equal(weirdTag.tag, 'a/b:c#d', '特殊字符 tag 应原样保留');

  const filtered = await reg.call('note_list', { tag: 'a/b:c#d' });
  assert.equal(filtered.total, 1, '按怪异 tag 应能过滤命中');
});

test('边界：存储文件损坏时回退为空而非抛错', async () => {
  const dir = freshDataDir();
  // 手动写入损坏的 JSON
  fs.writeFileSync(path.join(dir, 'notes.json'), '{ this is not valid json,,', 'utf8');

  const reg = new core.ToolRegistry();
  plugin.registerNoteTools(reg);

  const listed = await reg.call('note_list', {});
  assert.equal(listed.ok, true);
  assert.equal(listed.total, 0, '损坏文件应安全回退为空');

  const saved = await reg.call('note_save', { text: '损坏后新建' });
  assert.equal(saved.ok, true);
  const after = await reg.call('note_list', {});
  assert.equal(after.total, 1, '损坏恢复后应能正常写入并读出');
});

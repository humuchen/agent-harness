const test = require('node:test');
const assert = require('node:assert');
const { ToolRegistry } = require('../dist/tools.js');
const {
  SkillRegistry,
  defaultSkills,
  registerSkillTools,
  skillBoostPrompt,
} = require('../dist/skills/index.js');

test('SkillRegistry 注册与查询', () => {
  const r = new SkillRegistry();
  r.register({ id: 'a', title: 'A', description: 'd' });
  assert.strictEqual(r.get('a')?.title, 'A');
  assert.strictEqual(r.list().length, 1);
  assert.strictEqual(r.enabledList().length, 1);
  assert.throws(() => r.register({ id: '', title: 'x', description: 'd' }));
});

test('defaultSkills 提供 4 个默认技能', () => {
  const list = defaultSkills();
  assert.strictEqual(list.length, 4);
  const ids = list.map((s) => s.id).sort();
  assert.deepStrictEqual(ids, ['current-time', 'files', 'math', 'web-research']);
  for (const s of list) {
    assert.ok(s.tools && s.tools.length > 0, `${s.id} 应声明 tools`);
    assert.ok(s.triggers && s.triggers.length > 0, `${s.id} 应声明 triggers`);
  }
});

test('matchTriggers 中文/英文触发词（大小写不敏感）', () => {
  const r = new SkillRegistry();
  r.registerMany(defaultSkills());
  const cn = r.matchTriggers('帮我搜索一下最新的文档');
  assert.ok(cn.some((s) => s.id === 'web-research'));
  const en = r.matchTriggers('Please CALCULATE the total');
  assert.ok(en.some((s) => s.id === 'math'));
  const none = r.matchTriggers('你好');
  assert.strictEqual(none.length, 0);
});

test('describeForPrompt 注入技能清单，无技能时为空', () => {
  const empty = new SkillRegistry();
  assert.strictEqual(empty.describeForPrompt(), '');
  const r = new SkillRegistry();
  r.registerMany(defaultSkills());
  const text = r.describeForPrompt();
  assert.ok(text.includes('可用技能'));
  assert.ok(text.includes('builtin__use_skill'));
  for (const s of defaultSkills()) assert.ok(text.includes(s.id));
});

test('skillBoostPrompt 按触发词自动预激活', () => {
  const r = new SkillRegistry();
  r.registerMany(defaultSkills());
  assert.strictEqual(skillBoostPrompt('随便聊聊', r), '');
  const boost = skillBoostPrompt('现在几点了', r);
  assert.ok(boost.includes('自动启用的技能'));
  assert.ok(boost.includes('当前时间与时区'));
});

test('registerSkillTools 注册 builtin__use_skill 并取回指引', async () => {
  const r = new SkillRegistry();
  r.registerMany(defaultSkills());
  const tools = new ToolRegistry();
  registerSkillTools(tools, r);
  assert.ok(tools.has('builtin__use_skill'));
  const out = await tools.call('builtin__use_skill', { skill: 'math' });
  const s = String(out);
  assert.ok(s.includes('精确计算'));
  assert.ok(s.includes('builtin__calculator'));
});

test('use_skill 未知技能返回可用清单（模型自愈）', async () => {
  const r = new SkillRegistry();
  r.registerMany(defaultSkills());
  const tools = new ToolRegistry();
  registerSkillTools(tools, r);
  const out = await tools.call('builtin__use_skill', { skill: 'nope' });
  assert.ok(String(out).includes('web-research'));
});

test('disabled 技能被排除且 use_skill 找不到', async () => {
  const r = new SkillRegistry();
  r.register({ id: 'x', title: 'X', description: 'd', enabled: false, triggers: ['关闭'] });
  assert.strictEqual(r.enabledList().length, 0);
  assert.strictEqual(r.matchTriggers('关闭这个功能').length, 0);
  const tools = new ToolRegistry();
  registerSkillTools(tools, r);
  const out = await tools.call('builtin__use_skill', { skill: 'x' });
  assert.ok(String(out).includes('未找到'));
});

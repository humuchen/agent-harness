/* plan.ts 单测：parsePlanOutput 容错解析 + 结构/依赖校验。node --test 运行。 */
const { test } = require('node:test');
const assert = require('node:assert');
// 直接编译源码依赖 tsc；这里用 tsx 不可行（零依赖约定），改为对 dist 产物断言。
// 由运行方先执行 pnpm --filter @agent-harness/core build。
const path = require('node:path');
let plan;
try {
  plan = require(path.join(__dirname, '..', 'dist', 'plan.js'));
} catch {
  plan = null;
}

const validPlan = {
  goal: '调研并输出报告',
  tasks: [
    { id: 't1', title: '收集资料', steps: ['检索', '筛选'], dependsOn: [], expectedOutput: '资料清单' },
    { id: 't2', title: '分析', steps: ['阅读'], dependsOn: ['t1'], expectedOutput: '分析笔记' },
    { id: 't3', title: '成文', steps: ['写作'], dependsOn: ['t1', 't2'], expectedOutput: '报告' }
  ]
};

test('parsePlanOutput: 合法 JSON 直接通过且按拓扑序输出', () => {
  if (!plan) return console.log('skip: core 未构建（dist/plan.js 不存在）');
  const p = plan.parsePlanOutput(JSON.stringify(validPlan));
  assert.ok(p);
  assert.equal(p.goal, '调研并输出报告');
  assert.deepEqual(p.tasks.map((t) => t.id), ['t1', 't2', 't3']);
});

test('parsePlanOutput: markdown 围栏包裹可提取', () => {
  if (!plan) return;
  const text = '```json\n' + JSON.stringify(validPlan) + '\n```';
  const p = plan.parsePlanOutput(text);
  assert.ok(p);
  assert.equal(p.tasks.length, 3);
});

test('parsePlanOutput: 前后夹杂解释文字时截取 {} 片段', () => {
  if (!plan) return;
  const text = '好的，这是计划：\n' + JSON.stringify(validPlan) + '\n请确认。';
  const p = plan.parsePlanOutput(text);
  assert.ok(p);
  assert.equal(p.goal, '调研并输出报告');
});

test('parsePlanOutput: 环依赖拒绝', () => {
  if (!plan) return;
  const cyc = {
    goal: 'g',
    tasks: [
      { id: 'a', title: 'A', steps: [], dependsOn: ['b'], expectedOutput: '' },
      { id: 'b', title: 'B', steps: [], dependsOn: ['a'], expectedOutput: '' }
    ]
  };
  assert.equal(plan.parsePlanOutput(JSON.stringify(cyc)), null);
});

test('parsePlanOutput: dependsOn 引用不存在的 id 拒绝', () => {
  if (!plan) return;
  const bad = {
    goal: 'g',
    tasks: [{ id: 'a', title: 'A', steps: [], dependsOn: ['ghost'], expectedOutput: '' }]
  };
  assert.equal(plan.parsePlanOutput(JSON.stringify(bad)), null);
});

test('parsePlanOutput: 重复 id / 空 tasks / 缺 goal 拒绝', () => {
  if (!plan) return;
  const dup = JSON.parse(JSON.stringify(validPlan));
  dup.tasks[1].id = 't1';
  assert.equal(plan.parsePlanOutput(JSON.stringify(dup)), null);
  assert.equal(plan.parsePlanOutput(JSON.stringify({ goal: 'g', tasks: [] })), null);
  assert.equal(plan.parsePlanOutput(JSON.stringify({ tasks: [] })), null);
});

test('parsePlanOutput: 非 JSON 文本返回 null（回退问答）', () => {
  if (!plan) return;
  assert.equal(plan.parsePlanOutput('这是一个普通回答，没有 JSON。'), null);
  assert.equal(plan.parsePlanOutput(''), null);
});

test('buildPlannerPrompt: 包含用户需求与硬性要求标记', () => {
  if (!plan) return;
  const s = plan.buildPlannerPrompt('帮我做一个网站');
  assert.ok(s.includes('帮我做一个网站'));
  assert.ok(s.includes('dependsOn'));
});

/* ---- 计划模式 P0 改造：两态提示词（调研 + 澄清）与联合解析 ---- */

const validClarify = {
  clarify: true,
  goalDraft: '为医美机构生成一份竞品分析报告',
  questions: ['目标机构所在城市？', '报告需要覆盖哪些竞品？'],
  needs: '缺少竞品名单'
};

test('parseClarifyOutput: 合法澄清 JSON 直接通过', () => {
  if (!plan) return;
  const c = plan.parseClarifyOutput(JSON.stringify(validClarify));
  assert.ok(c);
  assert.equal(c.clarify, true);
  assert.equal(c.goalDraft, '为医美机构生成一份竞品分析报告');
  assert.deepEqual(c.questions, validClarify.questions);
  assert.equal(c.needs, '缺少竞品名单');
});

test('parseClarifyOutput: 围栏/夹杂文字可提取；needs 缺省不落键', () => {
  if (!plan) return;
  const noNeeds = { clarify: true, goalDraft: 'g', questions: ['q1'] };
  const fenced = '```json\n' + JSON.stringify(noNeeds) + '\n```';
  const c = plan.parseClarifyOutput(fenced);
  assert.ok(c);
  assert.equal('needs' in c, false);
  const mixed = '需要确认：\n' + JSON.stringify(noNeeds) + '\n请回复。';
  assert.ok(plan.parseClarifyOutput(mixed));
});

test('parseClarifyOutput: clarify 非 true / goalDraft 与 questions 全空 → null', () => {
  if (!plan) return;
  assert.equal(plan.parseClarifyOutput(JSON.stringify({ goal: 'g', tasks: [] })), null);
  assert.equal(
    plan.parseClarifyOutput(JSON.stringify({ clarify: true, goalDraft: '', questions: [] })),
    null
  );
  assert.equal(plan.parseClarifyOutput('普通文本'), null);
  assert.equal(plan.parseClarifyOutput(''), null);
});

test('parseClarifyOutput: questions 截断至 5 条', () => {
  if (!plan) return;
  const many = { clarify: true, goalDraft: 'g', questions: ['q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7'] };
  const c = plan.parseClarifyOutput(JSON.stringify(many));
  assert.ok(c);
  assert.equal(c.questions.length, 5);
});

test('parsePlanOrClarify: 计划优先；澄清次之；垃圾文本 null', () => {
  if (!plan) return;
  const asPlan = plan.parsePlanOrClarify(JSON.stringify(validPlan));
  assert.ok(asPlan && asPlan.kind === 'plan' && asPlan.plan.goal === '调研并输出报告');
  const asClarify = plan.parsePlanOrClarify(JSON.stringify(validClarify));
  assert.ok(asClarify && asClarify.kind === 'clarify' && asClarify.clarify.goalDraft);
  assert.equal(plan.parsePlanOrClarify('无法解析的文本'), null);
  assert.equal(plan.parsePlanOrClarify(''), null);
});

test('buildPlannerPrompt: 两态标记（调研 / 澄清分支）齐备', () => {
  if (!plan) return;
  const s = plan.buildPlannerPrompt('需求');
  assert.ok(s.includes('调研'));
  assert.ok(s.includes('澄清'));
  assert.ok(s.includes('clarify'));
  assert.ok(s.includes('goalDraft'));
});

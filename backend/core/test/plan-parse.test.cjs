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

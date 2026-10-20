// golden-set 回归测试（P6-C）：把计划解析器的「历史 bad case + 对抗性输入」固化为
// 不可回退的断言基线。范围 = parsePlanOutput / parseClarifyOutput / parsePlanOrClarify /
// pickOutputChecks（propose 链路最高频故障点：围栏、前后散文、多候选、澄清二义、
// outputChecks 收敛、结构非法拒绝）。这些用例一旦变红即说明容错行为发生回归，
// 必须显式评审而非悄悄改断言。
const test = require('node:test');
const assert = require('node:assert');

const plan = require('../dist/plan.js');
const { parsePlanOutput, parseClarifyOutput, parsePlanOrClarify, pickOutputChecks, PLAN_OUTPUT_CHECK_MAX } = plan;

// 合法计划样例（golden 正例的公共骨架）。
const GOOD_PLAN = {
  goal: '上线会员体系',
  tasks: [
    { id: 't1', title: '设计数据模型', steps: ['ER 图', '迁移脚本'], dependsOn: [], expectedOutput: 'SQL 迁移文件' },
    { id: 't2', title: '实现接口', steps: ['REST'], dependsOn: ['t1'], expectedOutput: '接口清单', requireApproval: true },
    { id: 't3', title: '整合交付', steps: [], dependsOn: ['t1', 't2'], expectedOutput: '上线报告', outputChecks: ['会员', '上线'] },
  ],
};

const clone = (x) => JSON.parse(JSON.stringify(x));

test('golden: 围栏 + 语言标注 + 前后散文（最高频真实形态）', () => {
  const text =
    '好的，以下是执行计划：\n```json\n' + JSON.stringify(GOOD_PLAN, null, 2) + '\n```\n' +
    '以上计划共 3 个任务，请确认后执行。';
  const p = parsePlanOutput(text);
  assert.ok(p, '围栏候选应命中');
  assert.strictEqual(p.goal, '上线会员体系');
  assert.strictEqual(p.tasks.length, 3);
  assert.strictEqual(p.tasks[1].requireApproval, true);
  assert.deepStrictEqual(p.tasks[2].outputChecks, ['会员', '上线']);
});

test('golden: 无围栏、前导散文 + 尾随说明（首尾大括号截取路径）', () => {
  const text = '我的方案如下 {\n  "goal": "G",\n  "tasks": [{ "id": "a", "title": "A" }]\n} 请确认。';
  const p = parsePlanOutput(text);
  assert.ok(p);
  assert.strictEqual(p.tasks[0].id, 'a');
});

test('golden: CRLF / 全角空白 / 尾随逗号文本前缀等健壮性', () => {
  const text = '```json\r\n' + JSON.stringify(GOOD_PLAN).replace(',', ',\r\n') + '\r\n```';
  const p = parsePlanOutput(text);
  assert.ok(p, 'CRLF 不影响围栏候选');
  assert.strictEqual(p.goal, '上线会员体系');
});

test('golden: outputChecks 收敛 —— String 化、空白剔除、超上限截断（P4.7 同源契约）', () => {
  const p = clone(GOOD_PLAN);
  p.tasks[2].outputChecks = ['会员', 42, null, '  ', '上线', '第五', '第六', '第七'];
  const parsed = parsePlanOutput(JSON.stringify(p));
  assert.ok(parsed);
  assert.ok(parsed.tasks[2].outputChecks.length <= PLAN_OUTPUT_CHECK_MAX);
  // 真实契约：逐项 String().trim()（42 → '42'、null → 'null'），空白剔除后截 4。
  assert.deepStrictEqual(parsed.tasks[2].outputChecks, ['会员', '42', 'null', '上线']);
  // 纯函数直查：String 化 + 空白剔除 + 截断。
  assert.deepStrictEqual(pickOutputChecks(['a', 1, '', null, 'b', 'c', 'd', 'e']), ['a', '1', 'null', 'b']);
});

test('golden: requireApproval 仅显式 true 保留（字符串/数字视为无门）', () => {
  const p = clone(GOOD_PLAN);
  p.tasks[0].requireApproval = 'true';
  p.tasks[1].requireApproval = 1;
  const parsed = parsePlanOutput(JSON.stringify(p));
  assert.ok(parsed);
  assert.strictEqual(parsed.tasks[0].requireApproval, undefined);
  assert.strictEqual(parsed.tasks[1].requireApproval, undefined);
  assert.strictEqual(parsed.tasks[2].requireApproval, undefined);
});

test('golden: 结构非法一律拒绝（重复 id / 未知依赖 / 环 / 空 tasks / 空 goal / tasks 非数组）', () => {
  const dup = clone(GOOD_PLAN);
  dup.tasks[1].id = 't1';
  assert.strictEqual(parsePlanOutput(JSON.stringify(dup)), null, '重复 id');

  const unknownDep = clone(GOOD_PLAN);
  unknownDep.tasks[1].dependsOn = ['ghost'];
  assert.strictEqual(parsePlanOutput(JSON.stringify(unknownDep)), null, '未知依赖');

  const cycle = { goal: 'g', tasks: [
    { id: 'a', title: 'A', dependsOn: ['b'] },
    { id: 'b', title: 'B', dependsOn: ['a'] },
  ] };
  assert.strictEqual(parsePlanOutput(JSON.stringify(cycle)), null, '依赖环');

  assert.strictEqual(parsePlanOutput(JSON.stringify({ goal: 'g', tasks: [] })), null, '空 tasks');
  assert.strictEqual(parsePlanOutput(JSON.stringify({ goal: '   ', tasks: GOOD_PLAN.tasks })), null, '空 goal');
  assert.strictEqual(parsePlanOutput(JSON.stringify({ goal: 'g', tasks: 'nope' })), null, 'tasks 非数组');
  assert.strictEqual(parsePlanOutput(''), null, '空输入');
  assert.strictEqual(parsePlanOutput('普通问答，没有任何 JSON'), null, '纯文本');
});

test('golden: 多候选 —— 直接 parse 失败但围栏内合法（真实模型常见：散文里嵌 JSON 片段）', () => {
  const text =
    '分析：先 { "broken": tru } 这样不行。\n```json\n' + JSON.stringify(GOOD_PLAN) + '\n```';
  const p = parsePlanOutput(text);
  assert.ok(p, '围栏候选兜底命中');
  assert.strictEqual(p.goal, '上线会员体系');
});

test('golden: 澄清 —— 新旧 questions 形态、options/题数上限、无效澄清拒绝', () => {
  // 新格式：对象数组（options 截 4、questions 截 5）。
  const clarifyNew = {
    clarify: true,
    goalDraft: '搭建官网',
    questions: [
      { q: '用哪个域名？', options: ['a.com', 'b.com', 'c.com', 'd.com', 'e.com'] },
      { q: '预算区间？', options: ['10w', '50w'] },
      { q: 'q3' }, { q: 'q4' }, { q: 'q5' }, { q: 'q6 应被截断' },
    ],
    needs: '需要确认品牌规范',
  };
  const c1 = parseClarifyOutput(JSON.stringify(clarifyNew));
  assert.ok(c1);
  assert.strictEqual(c1.questions.length, 5);
  assert.deepStrictEqual(c1.questions[0].options, ['a.com', 'b.com', 'c.com', 'd.com']);
  assert.strictEqual(c1.needs, '需要确认品牌规范');
  // 旧格式：string[]（历史落盘兼容）。
  const c2 = parseClarifyOutput('```json\n' + JSON.stringify({ clarify: true, goalDraft: 'g', questions: ['q1', 'q2'] }) + '\n```');
  assert.ok(c2);
  assert.deepStrictEqual(c2.questions, [{ q: 'q1' }, { q: 'q2' }]);
  // 无实质内容的澄清 → null。
  assert.strictEqual(parseClarifyOutput(JSON.stringify({ clarify: true, goalDraft: '', questions: [] })), null);
  assert.strictEqual(parseClarifyOutput('不是澄清输出'), null);
});

test('golden: 联合解析优先级 —— 合法计划优先于澄清；澄清输入走 clarify 分支', () => {
  const r1 = parsePlanOrClarify(JSON.stringify(GOOD_PLAN));
  assert.strictEqual(r1.kind, 'plan');
  const r2 = parsePlanOrClarify(JSON.stringify({ clarify: true, goalDraft: 'g', questions: [{ q: 'q' }] }));
  assert.strictEqual(r2.kind, 'clarify');
  assert.strictEqual(r2.clarify.questions[0].q, 'q');
  assert.strictEqual(parsePlanOrClarify('两者都不是'), null);
});

test('golden: 计划字段容错 —— steps 非字符串项 String 化、空白 steps 剔除、dependsOn trim', () => {
  const p = clone(GOOD_PLAN);
  p.tasks[0].steps = ['合法步骤', 42, '   ', { k: 1 }];
  p.tasks[2].dependsOn = [' t1 ', 't2'];
  const parsed = parsePlanOutput(JSON.stringify(p));
  assert.ok(parsed);
  // 真实契约：steps 逐项 String()（对象 → '[object Object]'），空白项剔除。
  assert.deepStrictEqual(parsed.tasks[0].steps, ['合法步骤', '42', '[object Object]']);
  assert.deepStrictEqual(parsed.tasks[2].dependsOn, ['t1', 't2']);
});

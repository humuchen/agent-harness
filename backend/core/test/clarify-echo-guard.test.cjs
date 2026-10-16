/* 澄清防重问守卫单测：修复「已回答的问题被换个措辞再问一遍」的循环追问。
 * 覆盖：回复标记解析 / 重复问题判定 / 阶段1 收敛 / 阶段3 守卫 / 兜底计划。 */
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
let pp;
let plan;
try {
  pp = require(path.join(__dirname, '..', 'dist', 'plan-propose.js'));
  plan = require(path.join(__dirname, '..', 'dist', 'plan.js'));
} catch {
  pp = null;
}

/** 构造脚本化 mock LLM：按调用序号依次返回 { content }。 */
function mockLLM(script) {
  let i = 0;
  const calls = [];
  const fn = async (messages) => {
    calls.push({ messages });
    const r = script[Math.min(i, script.length - 1)];
    i += 1;
    return { content: r.content ?? '', tool_calls: [] };
  };
  fn.calls = calls;
  return { fn, calls };
}

/** 与前端 confirmClarify 逐字一致的澄清回复输入（第 round 轮）。 */
function clarifyReplyInput(round, answers, extra) {
  const parts = [
    '分析一下Space X这只股票涨幅后，下一波的增速在哪个时间点。',
    `—— 目标澄清回复（第 ${round} 轮） ——`,
    '目标草稿：分析SpaceX最近的股票涨幅，并预测下一波增长速度出现的时间点。',
    '用户逐题确认：',
    ...answers.map((a, i) => `${i + 1}. ${a.q} → ${a.a}`)
  ];
  if (extra) parts.push(`用户补充：${extra}`);
  return parts.join('\n\n');
}

const ANSWERED = [
  { q: '请选择用于评估增长速度的主要指标', a: '波动率；股价绝对涨幅' },
  { q: '请选择预测下一波增长出现的时间范围', a: '未来1个月；未来3个月' }
];

/** 换措辞重问已回答问题（弱模型高发形态：选项集与旧答案重合）。 */
const CLARIFY_ECHO = JSON.stringify({
  clarify: true,
  goalDraft: '分析SpaceX最近的股票涨幅，并预测下一波增长速度出现的时间点。',
  questions: [
    { q: '在评估增长速度时，您更关注哪种指标？', options: ['年化收益率', '股价绝对涨幅', '波动率'] },
    { q: '您希望预测的下一波增长出现在哪个时间范围内？', options: ['未来1个月', '未来3个月', '未来6个月'] }
  ],
  needs: '确认分析指标和预测时间范围'
});

const PLAN_JSON = JSON.stringify({
  goal: '分析SpaceX最近的股票涨幅，并预测下一波增长速度出现的时间点',
  tasks: [
    { id: 't1', title: '收集数据', steps: ['获取股价数据'], dependsOn: [], expectedOutput: '数据清单' },
    { id: 't2', title: '分析预测', steps: ['分析增速'], dependsOn: ['t1'], expectedOutput: '分析结论' }
  ]
});

const NO_TOOLS = { schemas: () => [], call: async () => '' };

test('parseClarifyReply: 单轮解析 + 多轮累计 + 无标记返回 null', () => {
  if (!pp) return console.log('skip: core 未构建');
  const single = plan.parseClarifyReply(
    clarifyReplyInput(2, ANSWERED, '最新股票148')
  );
  assert.ok(single);
  assert.equal(single.round, 2);
  assert.equal(single.goalDraft, '分析SpaceX最近的股票涨幅，并预测下一波增长速度出现的时间点。');
  assert.equal(single.qa.length, 2);
  assert.deepEqual(single.qa[1], {
    q: '请选择预测下一波增长出现的时间范围',
    a: '未来1个月；未来3个月'
  });
  assert.equal(single.extra, '最新股票148');
  // 多轮：早轮回复段作为历史残留前文，Q&A 跨轮累计，round 取最后一轮。
  const multi = plan.parseClarifyReply(
    `${clarifyReplyInput(1, [{ q: '旧问题', a: '旧答案' }])}\n\n${clarifyReplyInput(2, ANSWERED)}`
  );
  assert.equal(multi.round, 2);
  assert.equal(multi.qa.length, 3);
  assert.equal(plan.parseClarifyReply('普通需求，没有标记'), null);
  // 空确认（用户直接按草稿继续）：有 goalDraft 即视为回复轮，qa 为空。
  const empty = plan.parseClarifyReply(clarifyReplyInput(1, []));
  assert.ok(empty);
  assert.equal(empty.qa.length, 0);
});

test('isClarifyQuestionDuplicate: 换措辞/选项重合判重，不同问题不误伤', () => {
  if (!pp) return console.log('skip: core 未构建');
  const dup = plan.isClarifyQuestionDuplicate;
  // 信号3：新问题选项 ≥60% 命中旧答案（换措辞重问）。
  assert.ok(
    dup('在评估增长速度时，您更关注哪种指标？', ['年化收益率', '股价绝对涨幅', '波动率'], ANSWERED)
  );
  // 信号1：归一化后相同。
  assert.ok(dup('请选择用于评估增长速度的主要指标', [], ANSWERED));
  // 信号2：近似措辞（无选项时靠 bigram 相似度）。
  assert.ok(dup('请选择用于评估增长速度的主要指标是什么', [], ANSWERED));
  // 不同问题（过去 vs 未来、指标 vs 时间范围）不判重。
  assert.ok(
    !dup('请指定"最近"时间范围是哪段时间？', ['过去1个月', '过去3个月', '过去6个月', '过去1年'], ANSWERED)
  );
  assert.ok(!dup('需要多少预算？', ['1万', '5万'], [{ q: '需要多少时间？', a: '1周' }]));
  // 无已回答记录时永不判重。
  assert.ok(!dup('任何问题', ['任何选项'], []));
});

test('buildClarifyConfirmedBlock: 注入已回答 Q&A 与禁重问硬规则', () => {
  if (!pp) return console.log('skip: core 未构建');
  const reply = plan.parseClarifyReply(clarifyReplyInput(2, ANSWERED, '最新股票148'));
  const block = plan.buildClarifyConfirmedBlock(reply);
  assert.ok(block.includes('用户第 2 轮澄清回复'));
  assert.ok(block.includes('1. 请选择用于评估增长速度的主要指标 → 波动率；股价绝对涨幅'));
  assert.ok(block.includes('用户补充：最新股票148'));
  assert.ok(block.includes('禁止再次提问'));
  // buildPlannerPrompt 自动注入（旧 harness 回退路径同样受保护）。
  assert.ok(plan.buildPlannerPrompt(clarifyReplyInput(2, ANSWERED)).includes('禁止再次提问'));
  assert.ok(!plan.buildPlannerPrompt('普通需求').includes('禁止再次提问'));
});

test('buildProposeUnderstandPrompt: 回复轮注入已确认块，达上限禁止澄清分支', () => {
  if (!pp) return console.log('skip: core 未构建');
  const r2 = plan.parseClarifyReply(clarifyReplyInput(2, ANSWERED));
  const p2 = pp.buildProposeUnderstandPrompt('输入', r2);
  assert.ok(p2.includes('禁止再次提问'));
  assert.ok(!p2.includes('禁止再输出第 3 种澄清 JSON'));
  const r3 = plan.parseClarifyReply(clarifyReplyInput(3, ANSWERED));
  const p3 = pp.buildProposeUnderstandPrompt('输入', r3);
  assert.ok(p3.includes('禁止再输出第 3 种澄清 JSON'));
});

test('管线：阶段1 重复追问已回答问题 → 收敛为直接规划并产出计划', async () => {
  if (!pp) return console.log('skip: core 未构建');
  const llm = mockLLM([{ content: CLARIFY_ECHO }, { content: PLAN_JSON }]);
  const events = [];
  const final = await pp.runPlanPropose({
    llm: llm.fn,
    tools: NO_TOOLS,
    userInput: clarifyReplyInput(2, ANSWERED, '最新股票148'),
    emit: (e) => events.push(e)
  });
  const parsed = plan.parsePlanOrClarify(final);
  assert.ok(parsed && parsed.kind === 'plan', '不得再弹出澄清卡');
  assert.ok(parsed.plan.goal.includes('SpaceX'));
  // 阶段1 收敛后不再调研：仅 阶段1 + 阶段3 两次调用。
  assert.equal(llm.calls.length, 2);
  assert.ok(!events.some((e) => e.type === 'tool:start'));
});

test('管线：阶段3 重复追问 → 守卫带反馈重试后收敛为计划', async () => {
  if (!pp) return console.log('skip: core 未构建');
  const llm = mockLLM([
    { content: '{"action":"plan","goal":"分析SpaceX涨幅并预测增速"}' },
    { content: CLARIFY_ECHO },
    { content: PLAN_JSON }
  ]);
  const final = await pp.runPlanPropose({
    llm: llm.fn,
    tools: NO_TOOLS,
    userInput: clarifyReplyInput(2, ANSWERED),
    emit: () => {}
  });
  const parsed = plan.parsePlanOrClarify(final);
  assert.ok(parsed && parsed.kind === 'plan');
  // 阶段1 + 阶段3 首次 + 守卫重试 = 3 次调用。
  assert.equal(llm.calls.length, 3);
  const feedback = llm.calls[2].messages.at(-1).content;
  assert.ok(feedback.includes('你再次提问了用户已回答的问题'));
});

test('管线：持续重复追问 → 剔除重复问题后无新问题可问，兜底计划收口', async () => {
  if (!pp) return console.log('skip: core 未构建');
  const llm = mockLLM([
    { content: CLARIFY_ECHO },
    { content: CLARIFY_ECHO },
    { content: CLARIFY_ECHO }
  ]);
  const final = await pp.runPlanPropose({
    llm: llm.fn,
    tools: NO_TOOLS,
    userInput: clarifyReplyInput(2, ANSWERED),
    emit: () => {}
  });
  const parsed = plan.parsePlanOrClarify(final);
  assert.ok(parsed && parsed.kind === 'plan', '兜底也必须是计划而非澄清卡');
  assert.ok(parsed.plan.tasks.length >= 1);
  assert.ok(parsed.plan.goal.includes('SpaceX'));
});

test('管线：回复轮提出真正的新问题 → 正常放行澄清卡', async () => {
  if (!pp) return console.log('skip: core 未构建');
  const fresh = JSON.stringify({
    clarify: true,
    goalDraft: '分析SpaceX最近的股票涨幅',
    questions: [{ q: '报告交付格式是 PPT 还是文档？', options: ['PPT', '文档'] }]
  });
  const llm = mockLLM([{ content: fresh }]);
  const final = await pp.runPlanPropose({
    llm: llm.fn,
    tools: NO_TOOLS,
    userInput: clarifyReplyInput(2, ANSWERED),
    emit: () => {}
  });
  const parsed = plan.parsePlanOrClarify(final);
  assert.ok(parsed && parsed.kind === 'clarify');
  assert.equal(parsed.clarify.questions.length, 1);
  assert.equal(llm.calls.length, 1);
});

test('管线：澄清达上限（第3轮回复）→ 即使提新问题也强制进入规划', async () => {
  if (!pp) return console.log('skip: core 未构建');
  const fresh = JSON.stringify({
    clarify: true,
    goalDraft: '分析SpaceX最近的股票涨幅',
    questions: [{ q: '报告交付格式是 PPT 还是文档？', options: ['PPT', '文档'] }]
  });
  const llm = mockLLM([{ content: fresh }, { content: PLAN_JSON }]);
  const final = await pp.runPlanPropose({
    llm: llm.fn,
    tools: NO_TOOLS,
    userInput: clarifyReplyInput(3, ANSWERED),
    emit: () => {}
  });
  const parsed = plan.parsePlanOrClarify(final);
  assert.ok(parsed && parsed.kind === 'plan', '达上限不得再弹澄清卡');
  assert.equal(llm.calls.length, 2);
});

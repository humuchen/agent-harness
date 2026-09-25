/* plan-propose.ts 单测：两段式规划管线的分支 / 调研 / 兜底行为。node --test 运行。 */
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
let pp;
let ToolRegistry;
try {
  pp = require(path.join(__dirname, '..', 'dist', 'plan-propose.js'));
  ToolRegistry = require(path.join(__dirname, '..', 'dist', 'tools.js')).ToolRegistry;
} catch {
  pp = null;
}

const PLAN_JSON = JSON.stringify({
  goal: '输出 Agent 行业落地研报',
  tasks: [
    { id: 't1', title: '收集资料', steps: ['检索'], dependsOn: [], expectedOutput: '资料清单' },
    { id: 't2', title: '成文', steps: ['写作'], dependsOn: ['t1'], expectedOutput: '研报' }
  ]
});
const CLARIFY_JSON = JSON.stringify({
  clarify: true,
  goalDraft: '写一份研报',
  questions: ['目标读者是谁？']
});

/** 构造脚本化 mock LLM：按调用序号依次返回 { content, tool_calls }。 */
function mockLLM(script) {
  let i = 0;
  const calls = [];
  const fn = async (messages, tools) => {
    calls.push({ messages, tools });
    const r = script[Math.min(i, script.length - 1)];
    i += 1;
    return {
      content: r.content ?? '',
      tool_calls: r.tool_calls ?? []
    };
  };
  fn.calls = calls;
  return { fn, calls };
}

/** failOnCallN：第 N 次工具调用抛错（0 = 永不失败）。 */
function makeTools(failOnCallN = 0) {
  const reg = new ToolRegistry();
  let n = 0;
  reg.register(
    'builtin__web_fetch',
    '抓取网页',
    { type: 'object', properties: { url: { type: 'string' } } },
    async () => {
      n += 1;
      // 0e2b9e9 起调研循环为 LLM 驱动（不再按 query 主动直调工具）：
      // 工具失败用例改为「首次调用即抛错」，验证「工具失败记数据缺口，仍产出计划」。
      if (failOnCallN > 0 && n === failOnCallN) throw new Error('network down');
      return '调研内容片段';
    }
  );
  return reg;
}

const PLAN_TASK_RUN = {
  goal: '输出 Agent 行业落地研报',
  tasks: [
    { id: 't1', title: '收集资料', steps: ['检索'], dependsOn: [], expectedOutput: '资料清单' },
    { id: 't2', title: '成文', steps: ['写作'], dependsOn: ['t1'], expectedOutput: '研报' }
  ]
};

test('parseUnderstandOutput: plan/research/clarify 三分支解析', () => {
  if (!pp) return console.log('skip: core 未构建');
  const a = pp.parseUnderstandOutput('{"action":"plan","goal":"做 X"}');
  assert.equal(a.kind, 'go');
  assert.deepEqual(a.queries, []);
  const b = pp.parseUnderstandOutput('{"action":"research","goal":"做 X","queries":["查 Y","查 Z","查 W","多余"]}');
  assert.equal(b.kind, 'go');
  assert.equal(b.queries.length, 3); // 上限 3 条
  const c = pp.parseUnderstandOutput(CLARIFY_JSON);
  assert.equal(c.kind, 'clarify');
  const bad = pp.parseUnderstandOutput('不是 JSON');
  assert.equal(bad, null);
});

test('管线：clarify 分支直接返回澄清 JSON，不执行任何工具', async () => {
  if (!pp) return console.log('skip: core 未构建');
  const llm = mockLLM([{ content: CLARIFY_JSON }]);
  const tools = makeTools();
  const events = [];
  const final = await pp.runPlanPropose({
    llm: llm.fn,
    tools,
    userInput: '做个东西',
    emit: (e) => events.push(e)
  });
  assert.ok(final.includes('"clarify": true') || final.includes('"clarify":true'));
  const types = events.map((e) => e.type);
  assert.ok(types.includes('plan:phase'));
  assert.ok(!types.includes('tool:start')); // 澄清不调研
  const phases = events.filter((e) => e.type === 'plan:phase').map((e) => e.phase);
  assert.deepEqual(phases, ['理解需求']);
});

test('管线：research 分支执行工具并最终产出计划 JSON', async () => {
  if (!pp) return console.log('skip: core 未构建');
  const llm = mockLLM([
    { content: '{"action":"research","goal":"输出研报","queries":["查市场规模"]}' },
    { content: '', tool_calls: [{ id: 'c1', name: 'builtin__web_fetch', arguments: { url: 'https://example.com/a' } }] },
    { content: '调研纪要：市场规模约 XX。' },
    { content: PLAN_JSON }
  ]);
  const tools = makeTools();
  const events = [];
  const final = await pp.runPlanPropose({
    llm: llm.fn,
    tools,
    userInput: '做一份研报',
    emit: (e) => events.push(e),
    // 显式放行出网（生产环境由 runner 解析租户/默认策略后注入；默认策略禁出网）。
    guardPolicy: { network: { mode: 'open' } }
  });
  const parsed = require(path.join(__dirname, '..', 'dist', 'plan.js')).parsePlanOutput(final);
  assert.ok(parsed);
  assert.equal(parsed.goal, '输出 Agent 行业落地研报');
  const phases = events.filter((e) => e.type === 'plan:phase').map((e) => e.phase);
  assert.deepEqual(phases, ['理解需求', '调研中', '生成计划']);
  assert.ok(events.some((e) => e.type === 'tool:start' && e.call.name === 'builtin__web_fetch'));
  assert.ok(events.some((e) => e.type === 'tool:result' && !e.errored));
  // 阶段3 调用不带工具（无工具表 → 结构上不可能再调研）。
  const lastCall = llm.calls[llm.calls.length - 1];
  assert.equal(lastCall.tools.length, 0);
});

test('管线：工具失败记数据缺口，仍产出计划（不白烧）', async () => {
  if (!pp) return console.log('skip: core 未构建');
  const llm = mockLLM([
    { content: '{"action":"research","goal":"输出研报","queries":["查资料"]}' },
    { content: '', tool_calls: [{ id: 'c1', name: 'builtin__web_fetch', arguments: { url: 'https://example.com/x' } }] },
    { content: '调研纪要：部分成功。' },
    { content: PLAN_JSON }
  ]);
  const events = [];
  const final = await pp.runPlanPropose({
    llm: llm.fn,
    tools: makeTools(1), // 工具首次调用即抛错
    userInput: '做一份研报',
    emit: (e) => events.push(e)
  });
  const parsed = require(path.join(__dirname, '..', 'dist', 'plan.js')).parsePlanOutput(final);
  assert.ok(parsed); // 工具失败不作废整轮
  const failed = events.find((e) => e.type === 'tool:result' && e.errored);
  assert.ok(failed);
});

test('管线：阶段3 首次输出非法 JSON 时带反馈重试一次', async () => {
  if (!pp) return console.log('skip: core 未构建');
  const llm = mockLLM([
    { content: '{"action":"plan","goal":"直接规划"}' },
    { content: '我尽量规划一下' }, // 非法
    { content: PLAN_JSON } // 重试成功
  ]);
  const events = [];
  const final = await pp.runPlanPropose({
    llm: llm.fn,
    tools: makeTools(),
    userInput: '做一份研报',
    emit: (e) => events.push(e)
  });
  const parsed = require(path.join(__dirname, '..', 'dist', 'plan.js')).parsePlanOutput(final);
  assert.ok(parsed);
  // 至少 3 次 LLM 调用（阶段1 + 阶段3 首次 + 重试）
  assert.ok(llm.calls.length >= 3);
});

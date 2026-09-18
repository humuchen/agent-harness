// 零依赖测试（node:test + node:assert）：覆盖 P0-2 在 AgentHarness.run() 内的
// 自动验证门禁（产出后校验 + 失败自动重试/自愈 + verify:result 事件）。
// 直接 require 编译后的叶子模块，避免引入其它运行时依赖。
const test = require('node:test');
const assert = require('node:assert');

const { AgentHarness } = require('../dist/harness.js');
const { ToolRegistry } = require('../dist/tools.js');
const { Memory } = require('../dist/memory.js');
const { specsVerifier } = require('../dist/verify.js');

/**
 * Mock LLM：第一次回答不含 SUCCESS（验证失败），在收到「未通过自动验证」的自检提示后
 * 第二次回答改为含 SUCCESS（验证通过）。用于验证「自动重试 + 自愈」链路。
 */
function makeSelfCorrectingLlm() {
  return async (messages) => {
    const last = messages[messages.length - 1];
    const text = last && last.content ? last.content : '';
    if (text.includes('未通过自动验证')) {
      return { content: 'SUCCESS achieved after self-correction', tool_calls: [] };
    }
    return { content: 'not yet', tool_calls: [] };
  };
}

/** 恒定返回固定文本的 LLM（用于「零重试、标记失败」场景）。 */
function makeConstantLlm(content) {
  return async () => ({ content, tool_calls: [] });
}

function makeHarness(opts) {
  return new AgentHarness({
    llm: opts.llm,
    tools: new ToolRegistry(),
    memory: new Memory(),
    onEvent: opts.onEvent,
    ...(opts.verify ? { verify: opts.verify } : {}),
    ...(opts.verifyMaxRetries != null ? { verifyMaxRetries: opts.verifyMaxRetries } : {}),
    ...(opts.verifySelfCorrect != null ? { verifySelfCorrect: opts.verifySelfCorrect } : {}),
  });
}

// ---------------------------------------------------------------------------
// 场景 1：一次性通过，不触发重试
// ---------------------------------------------------------------------------

test('verify 门禁首次通过：仅发一次 verify:result（passed=true），无 [verify:failed] 标记', async () => {
  const events = [];
  const harness = makeHarness({
    llm: makeConstantLlm('task SUCCESS done'),
    onEvent: (e) => events.push(e),
    verify: specsVerifier([{ contains: 'SUCCESS' }]),
    verifyMaxRetries: 0,
  });
  const final = await harness.run('do X');
  assert.ok(final.includes('SUCCESS'), '最终结果保留');
  assert.ok(!final.startsWith('[verify:failed]'), '通过时不应加失败标记');
  const vr = events.filter((e) => e.type === 'verify:result');
  assert.strictEqual(vr.length, 1, '只应发一次 verify:result');
  assert.strictEqual(vr[0].passed, true);
});

// ---------------------------------------------------------------------------
// 场景 2：失败 + 自动重试自愈 → 最终通过
// ---------------------------------------------------------------------------

test('verify 失败且 verifyMaxRetries>0：自动重试并自愈，最终通过', async () => {
  const events = [];
  const harness = makeHarness({
    llm: makeSelfCorrectingLlm(),
    onEvent: (e) => events.push(e),
    verify: specsVerifier([{ contains: 'SUCCESS' }]),
    verifyMaxRetries: 1,
    verifySelfCorrect: true,
  });
  const final = await harness.run('do X');
  assert.ok(final.includes('SUCCESS'), '自愈后应产出包含 SUCCESS');
  assert.ok(!final.startsWith('[verify:failed]'), '最终通过不应加失败标记');
  const vr = events.filter((e) => e.type === 'verify:result');
  assert.strictEqual(vr.length, 2, '应发两次 verify:result（首轮失败、重试后通过）');
  assert.strictEqual(vr[0].passed, false, '首轮未通过');
  assert.strictEqual(vr[1].passed, true, '重试后通过');
});

// ---------------------------------------------------------------------------
// 场景 3：失败 + 零重试 → 加 [verify:failed] 标记但不重跑
// ---------------------------------------------------------------------------

test('verify 失败且 verifyMaxRetries=0：加 [verify:failed] 标记、不重跑', async () => {
  const events = [];
  const harness = makeHarness({
    llm: makeConstantLlm('still not ok'),
    onEvent: (e) => events.push(e),
    verify: specsVerifier([{ contains: 'SUCCESS' }]),
    verifyMaxRetries: 0,
  });
  const final = await harness.run('do X');
  assert.ok(final.startsWith('[verify:failed]'), '应通过门禁应加失败标记前缀');
  assert.ok(final.includes('still not ok'), '原始结果仍附在标记之后');
  const vr = events.filter((e) => e.type === 'verify:result');
  assert.strictEqual(vr.length, 1, '零重试只发一次 verify:result');
  assert.strictEqual(vr[0].passed, false);
});

// ---------------------------------------------------------------------------
// 场景 5（P4.7）：软性未通过 → 只告警、不改写产出、不加 [verify:failed]
// ---------------------------------------------------------------------------

test('软性门禁未通过（重试后仍不通过）：产出原样保留，不追加 [verify:failed]，发告警', async () => {
  const events = [];
  const content = '一份切题且完整的产出，只是没有逐字复述验收词。';
  const harness = makeHarness({
    llm: makeConstantLlm(content),
    onEvent: (e) => events.push(e),
    verify: specsVerifier([{ contains: '__IMPOSSIBLE__' }], '任务验收', true),
    verifyMaxRetries: 1,
    verifySelfCorrect: true,
  });
  const final = await harness.run('do X');
  // 核心：产出不被改写（此前会变成 '[verify:failed] …' → 引擎出口闸门判无效产出 → step 失败）。
  assert.strictEqual(final, content, '软性未通过不得改写产出');
  assert.ok(!final.includes('[verify:failed]'), '不得追加失败标记');
  const vr = events.filter((e) => e.type === 'verify:result');
  assert.strictEqual(vr.length, 2, '仍走一次自检重试（首次 + 重试后）');
  assert.strictEqual(vr[0].passed, false);
  assert.strictEqual(vr[0].soft, true, 'verify:result 带 soft=true 供 UI 呈现为告警');
  assert.ok(
    events.some((e) => e.type === 'warn' && String(e.message).includes('验收告警')),
    '应发告警事件（验收缺口不静默丢失）'
  );
});

test('软性门禁首次通过：不加 soft 字段、发一次 verify:result', async () => {
  const events = [];
  const harness = makeHarness({
    llm: makeConstantLlm('含验收词 市场规模 的产出'),
    onEvent: (e) => events.push(e),
    verify: specsVerifier([{ contains: '市场规模' }], '任务验收', true),
    verifyMaxRetries: 1,
    verifySelfCorrect: true,
  });
  const final = await harness.run('do X');
  assert.ok(final.includes('市场规模'));
  const vr = events.filter((e) => e.type === 'verify:result');
  assert.strictEqual(vr.length, 1, '首次通过不重试');
  assert.strictEqual(vr[0].soft, undefined);
});

test('硬性门禁未通过仍照旧追加 [verify:failed]（软性化不外溢到硬门禁）', async () => {
  const harness = makeHarness({
    llm: makeConstantLlm('一份产出'),
    verify: specsVerifier([{ contains: '__IMPOSSIBLE__' }], '默认门禁'), // 非软性
    verifyMaxRetries: 0,
  });
  const final = await harness.run('do X');
  assert.ok(final.startsWith('[verify:failed]'), '硬性未通过保持原语义');
});

// ---------------------------------------------------------------------------
// 场景 4：未配置验证器 → 不发出 verify:result，行为等同于原 run
// ---------------------------------------------------------------------------

test('未配置 verify：无 verify:result 事件，结果透传', async () => {
  const events = [];
  const harness = makeHarness({
    llm: makeConstantLlm('plain result'),
    onEvent: (e) => events.push(e),
  });
  const final = await harness.run('do X');
  assert.strictEqual(final, 'plain result');
  assert.strictEqual(events.filter((e) => e.type === 'verify:result').length, 0);
});

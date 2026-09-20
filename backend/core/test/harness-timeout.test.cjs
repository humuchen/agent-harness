// P4.8 时间预算治理单测：覆盖「等待时间很长 → step 超时中止 → 无最终产出」的四处成因。
// 全部为确定性用例（不依赖真实模型 / 网络），用挂起 Promise 与人为延迟模拟真实故障形态。
const test = require('node:test');
const assert = require('node:assert');

const { AgentHarness } = require('../dist/harness.js');
const { ToolRegistry } = require('../dist/tools.js');
const { Memory } = require('../dist/memory.js');
const { specsVerifier } = require('../dist/verify.js');

const never = () => new Promise(() => {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeHarness(opts) {
  return new AgentHarness({
    llm: opts.llm,
    tools: opts.tools ?? new ToolRegistry(),
    memory: new Memory(),
    onEvent: opts.onEvent ?? (() => {}),
    ...(opts.timeoutMs != null ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.streamTokens != null ? { streamTokens: opts.streamTokens } : {}),
    ...(opts.verify ? { verify: opts.verify } : {}),
    ...(opts.verifyMaxRetries != null ? { verifyMaxRetries: opts.verifyMaxRetries } : {}),
    ...(opts.verifySelfCorrect != null ? { verifySelfCorrect: opts.verifySelfCorrect } : {}),
  });
}

// ---------------------------------------------------------------------------
// 1. 重试预算守卫：剩余时间不足时不重跑，保留第一轮产出
// ---------------------------------------------------------------------------

test('P4.8 重试预算守卫：剩余预算不足以跑完一轮时跳过自检重试，第一轮产出不被超时提示覆盖', async () => {
  let calls = 0;
  const FIRST = '第一轮完整报告：市场规模 120 亿，竞争格局 CR3=45%，技术趋势为端侧推理。';
  const events = [];
  const harness = makeHarness({
    // 总预算 1s → 重试门槛收敛为 min(60s, 250ms) = 250ms。首轮耗时 850ms 后剩余
    // 仅约 150ms < 250ms，与真实场景（第一轮吃掉大半预算）同形。
    timeoutMs: 1000,
    llm: async () => {
      calls += 1;
      if (calls === 1) {
        await sleep(850);
        return { content: FIRST, tool_calls: [] };
      }
      return never(); // 第二轮若被启动就会挂住并撞硬超时，把第一轮产出覆盖掉
    },
    onEvent: (e) => events.push(e),
    // 软性断言必然未通过 → 正常会触发一次反思重试
    verify: specsVerifier([{ contains: '__IMPOSSIBLE__' }], '任务验收', true),
    verifyMaxRetries: 1,
    verifySelfCorrect: true,
  });

  const final = await harness.run('写一份行业简报');
  assert.strictEqual(calls, 1, '剩余预算不足时不应再跑第二轮');
  assert.ok(final.includes('市场规模 120 亿'), `第一轮产出应被保留: ${final}`);
  assert.ok(!final.includes('[timeout]'), '产出不应被超时提示覆盖');
  const warned = events.some(
    (e) => e.type === 'warn' && String(e.message).includes('跳过自检重试')
  );
  assert.ok(warned, '应发出「跳过自检重试」告警');
});

test('P4.8 重试预算守卫：预算充足时重试照常执行（零回归）', async () => {
  let calls = 0;
  const harness = makeHarness({
    timeoutMs: 60_000, // 剩余充足 → 守卫不介入
    llm: async (messages) => {
      calls += 1;
      const last = messages[messages.length - 1];
      if (last && String(last.content).includes('未通过自动验证')) {
        return { content: '第二轮补齐 SUCCESS', tool_calls: [] };
      }
      return { content: '第一轮 not yet', tool_calls: [] };
    },
    verify: specsVerifier([{ contains: 'SUCCESS' }]),
    verifyMaxRetries: 1,
    verifySelfCorrect: true,
  });

  const final = await harness.run('do X');
  assert.strictEqual(calls, 2, '预算充足时反思重试必须照常发生');
  assert.ok(final.includes('SUCCESS'));
});

// ---------------------------------------------------------------------------
// 2. 工具执行可被中止打断（此前裸 await → 看门狗失效，整步挂死）
// ---------------------------------------------------------------------------

test('P4.8 工具可中止：挂死的工具不再让看门狗失效，运行按时中止', async () => {
  const tools = new ToolRegistry();
  tools.register('hang_tool', 'hangs forever', {}, never);
  const harness = makeHarness({
    tools,
    timeoutMs: 300,
    llm: async () => ({
      content: '',
      tool_calls: [{ id: 'c1', name: 'hang_tool', arguments: {} }],
    }),
  });

  const res = await Promise.race([
    harness.run('call the tool'),
    sleep(3000).then(() => '__STILL_HANGING__'),
  ]);
  assert.notStrictEqual(res, '__STILL_HANGING__', '挂死工具不得让运行无限期阻塞');
  assert.strictEqual(res, '[timeout] run exceeded time limit');
});

// ---------------------------------------------------------------------------
// 3. 单次工具调用超时：以工具错误回传，模型可改道继续（不拖垮整步）
// ---------------------------------------------------------------------------

test('P4.8 单次工具超时：超时作为工具结果回传，模型基于已有信息继续', async () => {
  const tools = new ToolRegistry();
  tools.register('slow_tool', 'never returns', {}, never);
  process.env.AGENT_TOOL_TIMEOUT_MS = '150';
  try {
    const harness = makeHarness({
      tools,
      timeoutMs: 5000, // 整步预算充足，故障只发生在单次工具调用
      llm: async (messages) => {
        if (messages.some((m) => m.role === 'tool')) {
          const hinted = messages.some(
            (m) => m.role === 'tool' && String(m.content).includes('工具执行超时')
          );
          return { content: hinted ? 'CONTINUED_WITH_HINT' : 'MISSING_HINT', tool_calls: [] };
        }
        return { content: '', tool_calls: [{ id: 'c1', name: 'slow_tool', arguments: {} }] };
      },
    });
    const res = await harness.run('call slow tool');
    assert.ok(
      res.includes('CONTINUED_WITH_HINT'),
      `模型应收到工具超时提示后继续: ${res}`
    );
  } finally {
    delete process.env.AGENT_TOOL_TIMEOUT_MS;
  }
});

// ---------------------------------------------------------------------------
// 4. 软截止收尾：接近预算时主动要求模型收尾，而不是硬超时丢弃产出
// ---------------------------------------------------------------------------

test('P4.8 软截止收尾：预算转紧时注入收尾提示并跳过新一轮工具调用', async () => {
  process.env.AGENT_SOFT_DEADLINE_MS = '500';
  const tools = new ToolRegistry();
  tools.register('t', 'demo', {}, async () => 'tool-output');
  try {
    const events = [];
    const harness = makeHarness({
      tools,
      timeoutMs: 2000, // 软截止收敛为 min(500, 2000/4=500) = 500ms
      llm: async (messages) => {
        const wrapUp = messages.some(
          (m) => m.role === 'user' && String(m.content).includes('时间预算即将耗尽')
        );
        if (wrapUp) return { content: 'WRAPUP_FINAL 已基于已有信息给出最终结果', tool_calls: [] };
        await sleep(1700); // 首轮耗时后剩余 300ms < 500ms → 下一轮进入软截止
        return { content: '', tool_calls: [{ id: 'c1', name: 't', arguments: {} }] };
      },
      onEvent: (e) => events.push(e),
    });

    const res = await harness.run('做一个长任务');
    assert.ok(res.includes('WRAPUP_FINAL'), `应主动收尾产出最终结果: ${res}`);
    assert.ok(
      !events.some((e) => e.type === 'tool:start'),
      '进入软截止后不得再启动新一轮工具调用'
    );
    assert.ok(
      events.some((e) => e.type === 'warn' && String(e.message).includes('时间预算')),
      '应发出时间预算告警'
    );
  } finally {
    delete process.env.AGENT_SOFT_DEADLINE_MS;
  }
});

// ---------------------------------------------------------------------------
// 5. 硬中止抢救：已流式生成的内容不再被丢弃
// ---------------------------------------------------------------------------

test('P4.8 硬中止抢救：超时中止时保留已流式生成内容并标注中断', async () => {
  const harness = makeHarness({
    timeoutMs: 300,
    streamTokens: true,
    llm: async (_messages, _tools, o) => {
      o.onToken('已经生成的大段内容：市场规模 120 亿，竞争格局 CR3=45%。');
      o.onToken('继续生成更多内容，用于验证中止时内容不丢失。');
      return never();
    },
  });

  const final = await harness.run('写长报告');
  assert.ok(final.includes('市场规模 120 亿'), `已生成内容必须保留: ${final}`);
  assert.ok(final.includes('生成已中断'), '应带明确的中断说明');
});

test('P4.8 硬中止抢救：无可保留内容时仍回固定超时文案（零回归）', async () => {
  const harness = makeHarness({ timeoutMs: 200, llm: async () => never() });
  const final = await harness.run('do X');
  assert.strictEqual(final, '[timeout] run exceeded time limit');
});

'use strict';
/**
 * 工具超时「真取消」语义测试：超时不再只是放弃等待——工具收到的 AbortSignal
 * 必须被真实触发（孤儿执行不再烧 token），run 级中止级联进工具信号，
 * 且超时后模型可改道、run 正常收尾。
 */
const test = require('node:test');
const assert = require('node:assert');
const { AgentHarness } = require('../dist/harness.js');
const { ToolRegistry } = require('../dist/tools.js');
const { Memory } = require('../dist/memory.js');

/** 装配一个「第 1 步调挂死工具、之后直接收尾」的 harness；可注入外部取消信号。 */
function makeHarness(toolFn, onEvent, externalSignal) {
  let llmCalls = 0;
  const harness = new AgentHarness({
    llm: async () => {
      llmCalls += 1;
      if (llmCalls === 1) {
        return {
          content: '',
          tool_calls: [{ id: 'call-1', name: 'hang', arguments: {} }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        };
      }
      return {
        content: 'recovered',
        tool_calls: [],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      };
    },
    tools: (() => {
      const reg = new ToolRegistry();
      reg.register('hang', 'hangs until aborted', { type: 'object', properties: {} }, toolFn, 'test');
      return reg;
    })(),
    memory: new Memory(),
    systemPrompt: '',
    signal: externalSignal,
    onEvent: onEvent || (() => {})
  });
  return harness;
}

test('工具超时：AbortSignal 被真实触发（真取消，而非放弃等待）', async () => {
  process.env.AGENT_TOOL_TIMEOUT_MS = '80';
  let toolSignal = null;
  let abortedAt = 0;
  const harness = makeHarness(async (_args, ctx) => {
    toolSignal = ctx.signal;
    await new Promise((resolve, reject) => {
      if (ctx.signal.aborted) return reject(new Error('already aborted'));
      ctx.signal.addEventListener(
        'abort',
        () => {
          abortedAt = Date.now();
          reject(new Error('tool aborted by timeout'));
        },
        { once: true }
      );
    });
  });
  try {
    const final = await harness.run('go');
    assert.strictEqual(final, 'recovered', '超时后模型改道，run 正常收尾');
    assert.ok(abortedAt > 0, '工具收到的 signal 必须在超时后被 abort');
  } finally {
    delete process.env.AGENT_TOOL_TIMEOUT_MS;
  }
});

test('工具超时：tool:result 事件携带新文案「已中止该工具执行」，旧「放弃等待」退役', async () => {
  process.env.AGENT_TOOL_TIMEOUT_MS = '80';
  const events = [];
  const harness = makeHarness(async (_args, ctx) => {
    await new Promise((_res, reject) => {
      ctx.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
    });
  }, (e) => events.push(e));
  try {
    await harness.run('go');
    const toolResult = events.find((e) => e.type === 'tool:result');
    assert.ok(toolResult, '应有 tool:result 事件');
    assert.match(String(toolResult.result), /已中止该工具执行/);
    assert.doesNotMatch(String(toolResult.result), /放弃等待/);
    assert.ok(toolResult.errored, '超时应标记 errored');
  } finally {
    delete process.env.AGENT_TOOL_TIMEOUT_MS;
  }
});

test('run 级中止级联：工具在 run 被取消时收到的 signal 一并 abort', async () => {
  const controller = new AbortController();
  let captured = null;
  let toolSawAbort = false;
  const harness = makeHarness(async (_args, ctx) => {
    captured = ctx.signal;
    await new Promise((_res, reject) => {
      ctx.signal.addEventListener('abort', () => {
        toolSawAbort = true;
        reject(new Error('cancelled'));
      }, { once: true });
    });
  }, null, controller.signal);
  const runP = harness.run('go').catch(() => {});
  // 等工具拿到 signal（最多 500ms）
  for (let i = 0; i < 50 && !captured; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(captured, '工具应收到 signal');
  controller.abort(); // 取消整个 run
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(captured.aborted, true, 'run 中止必须级联到工具信号');
  assert.strictEqual(toolSawAbort, true, '工具应感知 abort 并自行退出');
  await runP;
});

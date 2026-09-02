'use strict';
// 工具调用去重 / 单 step 预算（加固版）确定性回归 + 对比基准。
// 用 mock LLM 复现「模型在同一 run 内反复请求相同工具」的调用爆炸场景，
// 在同一份已加固代码内，通过 enableToolDedup / maxToolCallsPerStep 开关区分：
//   - 加固关闭 = 现有/现网版本行为
//   - 加固开启 = 去重版
//   - 加固+预算 = 去重 + 单 step 预算封顶
// 逐项对比 功能 / 性能 / 稳定性。

const test = require('node:test');
const assert = require('node:assert');
const { AgentHarness } = require('../dist/harness.js');
const { ToolRegistry, objectParams } = require('../dist/tools.js');
const { Memory } = require('../dist/memory.js');

// 确定性 mock 工具：模拟天气工具（不走网络，返回固定 JSON），便于复现与断言。
function weatherTools() {
  const reg = new ToolRegistry();
  reg.register(
    'builtin__weather',
    'Get weather for a place.',
    objectParams(
      { location: { type: 'string' }, days: { type: 'number' } },
      ['location']
    ),
    (a) =>
      JSON.stringify({
        place: a.location,
        current: { temperature: 30.8, condition: '晴' },
        forecast: [{ date: '2026-08-24', tempMax: 33, tempMin: 27 }],
      })
  );
  // 一个不同名的工具，用于验证「不同名不应被去重误伤」。
  reg.register(
    'builtin__calculator',
    'Calculate.',
    objectParams({ expr: { type: 'string' } }, ['expr']),
    (a) => String(eval(String(a.expr)))
  );
  return reg;
}

// 爆炸型 mock LLM：前 `toolSteps` 个 step 每 step 并行请求 `repeat` 次「相同参数」的同一工具，
// 之后返回 finalText。复现截图里 step=2 × 13 次 = 26 次的现象。
function explodingLLM(toolName, finalText, repeat, toolSteps) {
  let step = 0;
  return async () => {
    step += 1;
    if (step <= toolSteps) {
      const calls = [];
      for (let i = 0; i < repeat; i++) {
        calls.push({
          id: `c${step}_${i}`,
          name: toolName,
          arguments: { location: '上海', days: 3 },
        });
      }
      return { content: '', tool_calls: calls };
    }
    return { content: finalText, tool_calls: [] };
  };
}

// 混合 LLM：每个 step 请求若干「参数不同」的同名工具（如不同城市天气），验证去重不误伤。
function distinctArgsLLM(toolName, finalText, cities) {
  let step = 0;
  return async () => {
    step += 1;
    if (step === 1) {
      const calls = cities.map((city, i) => ({
        id: `c1_${i}`,
        name: toolName,
        arguments: { location: city, days: 3 },
      }));
      return { content: '', tool_calls: calls };
    }
    return { content: finalText, tool_calls: [] };
  };
}

// 收集一次 run 的指标。
async function runScenario({ llm, dedup, budget }) {
  const tools = weatherTools();
  const mem = new Memory();
  const events = [];
  const h = new AgentHarness({
    llm,
    tools,
    memory: mem,
    maxSteps: 12,
    onEvent: (e) => events.push(e),
    enableToolDedup: dedup,
    maxToolCallsPerStep: budget || 0,
  });
  const t0 = Date.now();
  const final = await h.run('查上海天气');
  const ms = Date.now() - t0;
  const count = (t) => events.filter((e) => e.type === t).length;
  return {
    final,
    toolStart: count('tool:start'),
    toolResult: count('tool:result'),
    toolDeduped: count('tool:deduped'),
    warn: count('warn'),
    stepStart: count('step:start'),
    runEnd: count('run:end'),
    memMessages: mem.history().length,
    ms,
  };
}

function fmt(n) {
  return String(n).padStart(4, ' ');
}

test('基准 A：重复同参数爆炸（step=2 × 13 = 26 次）→ 加固前后逐项对比', async () => {
  const FINAL = '上海今天晴，30.8°C，未来3天...';
  const llm = () => explodingLLM('builtin__weather', FINAL, 13, 2)();

  const base = await runScenario({ llm: explodingLLM('builtin__weather', FINAL, 13, 2), dedup: false });
  const reinforced = await runScenario({ llm: explodingLLM('builtin__weather', FINAL, 13, 2), dedup: true });
  const reinforcedBudget = await runScenario({
    llm: explodingLLM('builtin__weather', FINAL, 13, 2),
    dedup: true,
    budget: 8,
  });

  console.log('\n=== 场景 A：重复同参数工具调用爆炸（复现截图 26 次）===');
  console.log('指标            | 现有版本(加固关) | 加固版(去重) | 加固+预算(≤8)');
  console.log('----------------+------------------+--------------+--------------');
  console.log(`最终输出一致    | ${fmt(base.final === FINAL ? 1 : 0)}              | ${fmt(reinforced.final === FINAL ? 1 : 0)}            | ${fmt(reinforcedBudget.final === FINAL ? 1 : 0)}`);
  console.log(`tool:start(真实)| ${fmt(base.toolStart)}             | ${fmt(reinforced.toolStart)}            | ${fmt(reinforcedBudget.toolStart)}`);
  console.log(`tool:deduped    | ${fmt(base.toolDeduped)}              | ${fmt(reinforced.toolDeduped)}            | ${fmt(reinforcedBudget.toolDeduped)}`);
  console.log(`warn(预算截断)  | ${fmt(base.warn)}              | ${fmt(reinforced.warn)}            | ${fmt(reinforcedBudget.warn)}`);
  console.log(`step:start      | ${fmt(base.stepStart)}              | ${fmt(reinforced.stepStart)}            | ${fmt(reinforcedBudget.stepStart)}`);
  console.log(`run:end 到达    | ${fmt(base.runEnd)}              | ${fmt(reinforced.runEnd)}            | ${fmt(reinforcedBudget.runEnd)}`);
  console.log(`memory 消息数   | ${fmt(base.memMessages)}             | ${fmt(reinforced.memMessages)}            | ${fmt(reinforcedBudget.memMessages)}`);
  console.log(`耗时(ms)        | ${fmt(base.ms)}             | ${fmt(reinforced.ms)}            | ${fmt(reinforcedBudget.ms)}`);

  // —— 功能：最终输出必须一致（去重复用的是首次真实结果，内容等价）——
  assert.equal(reinforced.final, FINAL, '加固版最终输出应与现有版一致');
  assert.equal(reinforcedBudget.final, FINAL, '加固+预算版最终输出应与现有版一致');
  // —— 性能：真实工具执行次数应被显著砍掉 ——
  // 注意：去重缓存是 run 级（跨 step 共享）——第 2 个 step 的相同参数调用同样命中缓存，
  // 因此 26 次请求只保留首次真实执行（1 次），其余 25 次全部标记为复用。
  assert.equal(base.toolStart, 26, '现有版本应触发 26 次工具调用（复现爆炸）');
  assert.equal(reinforced.toolStart, 1, '去重后应只剩 1 次真实执行（run 级去重，跨 step 生效）');
  assert.equal(reinforced.toolDeduped, 25, '去重应标记 25 次复用');
  // 预算版：每 step 预算 8，计数在去重检查前递增 → 每 step 处理 8 个调用后截断（warn+break）。
  // step1: 1 真实 + 7 去重；step2: 8 去重（全命中缓存）→ 真实 1 次 / 去重 15 次 / warn 2 次。
  assert.equal(reinforcedBudget.toolStart, 1, '加固+预算(step≤8) 真实执行应为 1');
  assert.equal(reinforcedBudget.toolDeduped, 15, '加固+预算 去重应为 15');
  assert.equal(reinforcedBudget.warn, 2, '加固+预算 应发出 2 次预算截断 warn');
  // —— 稳定性 ——
  assert.equal(base.runEnd, 1, '现有版应正常结束');
  assert.equal(reinforced.runEnd, 1, '加固版应正常结束');
  assert.equal(reinforcedBudget.runEnd, 1, '加固+预算版应正常结束');
});

test('基准 B：不同参数（不同城市）不应被去重误伤', async () => {
  const FINAL = '已汇总上海/北京/东京天气';
  const cities = ['上海', '北京', '东京'];
  const base = await runScenario({ llm: distinctArgsLLM('builtin__weather', FINAL, cities), dedup: false });
  const reinforced = await runScenario({ llm: distinctArgsLLM('builtin__weather', FINAL, cities), dedup: true });

  console.log('\n=== 场景 B：不同参数（上海/北京/东京）去重不误伤 ===');
  console.log(`tool:start(真实) | 现有=${base.toolStart} | 加固=${reinforced.toolStart}`);
  console.log(`tool:deduped     | 现有=${base.toolDeduped} | 加固=${reinforced.toolDeduped}`);

  // 不同参数的同名工具必须全部执行，去重不应误伤 → 仍是 3 次
  assert.equal(base.toolStart, 3, '现有版应执行 3 次（3 个城市）');
  assert.equal(reinforced.toolStart, 3, '加固版对不同参数仍应执行 3 次，不被去重');
  assert.equal(reinforced.toolDeduped, 0, '不同参数不应产生去重');
  assert.equal(reinforced.final, FINAL, '功能不应退化');
});

test('基准 C：不同名工具混用不被去重误伤', async () => {
  // 一个 step 内先天气(上海) 再计算(1+1)，两者都该执行。
  // 注意：必须用工厂函数为每次 runScenario 生成全新 llm 闭包——
  // 共享闭包会让 base 消耗掉 step 计数，reinforced 拿到的是已耗尽的状态。
  const makeLlm = () => {
    let step = 0;
    return async () => {
      step += 1;
      if (step === 1) {
        return {
          content: '',
          tool_calls: [
            { id: 'w1', name: 'builtin__weather', arguments: { location: '上海' } },
            { id: 'c1', name: 'builtin__calculator', arguments: { expr: '1+1' } },
          ],
        };
      }
      return { content: 'done', tool_calls: [] };
    };
  };
  const base = await runScenario({ llm: makeLlm(), dedup: false });
  const reinforced = await runScenario({ llm: makeLlm(), dedup: true });

  console.log('\n=== 场景 C：不同名工具(天气+计算器)混用 ===');
  console.log(`tool:start(真实) | 现有=${base.toolStart} | 加固=${reinforced.toolStart}`);

  assert.equal(base.toolStart, 2, '现有版应执行 2 次');
  assert.equal(reinforced.toolStart, 2, '加固版对不同名工具应执行 2 次');
  assert.equal(reinforced.toolDeduped, 0, '不同名不应去重');
});

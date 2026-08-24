/* 回归测试：计划模式 propose 的输出护栏旁路（planPropose）。
 *
 * 背景：planner 产出的计划 JSON 会被业务合规输出规则（registerOutputRule，如医疗
 * 广告法关键词正则）误命中；拦截后 harness 走「合规话术重试」破坏 JSON 格式，最终
 * 返回中性兜底文案 → parsePlanOutput 失败 → 计划永远生成失败。
 * 修复：HarnessOptions.planPropose 开启时，能解析为合法计划的输出仅做密钥/注入扫描。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
let core;
try {
  core = require(path.join(__dirname, '..', 'dist', 'index.js'));
} catch {
  core = null;
}

/** 计划 JSON：任务描述里刻意包含会命中业务合规正则的措辞（如「保证成功」）。 */
const planJson = JSON.stringify({
  goal: '完成项目交付',
  tasks: [
    {
      id: 't1',
      title: '开发并保证构建成功',
      steps: ['编码', '确保测试 100% 有效通过'],
      dependsOn: [],
      expectedOutput: '可运行的构建产物'
    }
  ]
});

function makeLLM(responses) {
  let i = 0;
  // LLM 契约是可调用函数：(messages, tools?, opts?) => LLMResponse。
  return async () => {
    const content = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return { content, tool_calls: [] };
  };
}

test('planPropose: 含业务规则关键词的计划 JSON 不被输出护栏拦截', () => {
  if (!core) return console.log('skip: core 未构建（dist/index.js 不存在）');
  const { AgentHarness, ToolRegistry } = core;

  // 注册一条必然命中计划文案的业务输出规则（模拟 medical-ad-guard 场景）。
  core.registerOutputRule(/保证.{0,10}(成功|有效)/, '医疗广告法：不得作绝对化保证');

  try {
    // 开启 planPropose：计划 JSON 应原样透出，不被拦截、不触发重试兜底。
    const h1 = new AgentHarness({
      llm: makeLLM([planJson]),
      tools: new ToolRegistry(),
      planPropose: true,
    });
    return h1.run('做个规划').then((final) => {
      assert.equal(final, planJson, 'planPropose 下合法计划 JSON 应原样返回');
    });
  } finally {
    // 清理：registerOutputRule 无注销 API，只能依赖进程内顺序；
    // 该规则保留会影响后续用例，故后续用例放在独立 test 文件执行前先验证关闭态。
  }
});

test('未开启 planPropose（默认）：同样的计划 JSON 仍被业务规则拦截（行为不变）', async () => {
  if (!core) return console.log('skip: core 未构建（dist/index.js 不存在）');
  const { AgentHarness, ToolRegistry } = core;
  // 上一个用例已注册 /保证.{0,10}(成功|有效)/ 规则且无法注销 —— 默认路径应仍被拦截，
  // 经一次重试后仍命中，最终返回中性兜底文案。
  const h2 = new AgentHarness({
    llm: makeLLM([planJson, planJson]),
    tools: new ToolRegistry(),
  });
  const final = await h2.run('做个规划');
  assert.match(final, /暂时无法提供该内容的回复/);
});

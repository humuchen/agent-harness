/**
 * 回归测试：动态工具选择 + 子集外工具兜底扩展。
 *
 * 背景：harness 原本对「任何含疑问词的中文输入」回退全量工具 schema（looksLikeTask 正则
 * 含 什么/怎么/如何…），导致简单问答也把全量（含 MCP 大 schema）工具每轮发给模型，
 * 用户实测「工具」项高达 ~12968 tok。修复：首轮一律发相关性子集；若模型请求了子集外的
 * 工具，扩展到全量 schema 重试一次（执行注册表始终全量，能力不丢）。
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const core = require(path.join(__dirname, '..', 'dist', 'index.js'));
const { AgentHarness, ToolRegistry } = core;

function buildRegistry() {
  const reg = new ToolRegistry();
  // 12 个工具：模拟「少量内置小 schema + 大量 MCP/插件大 schema」的真实构成。
  const specs = [
    ['builtin__datetime_now', 'builtin', '返回当前日期时间'],
    ['builtin__calculator', 'builtin', '数学计算'],
    ['builtin__shell_exec', 'builtin', '执行 shell 命令'],
    ['mcp__web_search', 'mcp:web', '联网搜索网页与资讯'],
    ['mcp__weather', 'mcp:weather', '查询天气'],
    ['mcp__rag_retrieve', 'mcp:rag', '检索知识库'],
    ['mcp__translate', 'mcp:translate', '翻译文本'],
    ['mcp__filesearch', 'mcp:filesearch', '在文件系统中搜索'],
    ['mcp__zzz_ghost', 'mcp:ghost', '操作冰箱温控器并同步家庭物联网'],
    ['plugin__a', 'plugin:a', '插件A能力'],
    ['plugin__b', 'plugin:b', '插件B能力'],
    ['plugin__c', 'plugin:c', '插件C能力']
  ];
  const executed = [];
  for (const [name, source, description] of specs) {
    // 给 MCP/插件工具放大 parameters，模拟真实大 schema。
    const parameters =
      source === 'builtin'
        ? { type: 'object', properties: { q: { type: 'string' } } }
        : {
            type: 'object',
            properties: {
              query: { type: 'string', description: '查询语句' },
              options: { type: 'object', description: '可选配置项' },
              extra: { type: 'array', description: '一组扩展参数' }
            }
          };
    reg.register(name, description, parameters, async (args) => {
      executed.push(name);
      return `ok:${name}`;
    }, source);
  }
  return { reg, executed, allNames: specs.map((s) => s[0]) };
}

function fakeLLM(plan) {
  const calls = [];
  let n = 0;
  const fn = async (messages, tools) => {
    n += 1;
    calls.push(tools.map((t) => t.name));
    return plan(n, tools);
  };
  return { calls, fn };
}

const usage = { prompt_tokens: 60, completion_tokens: 12, total_tokens: 72 };
const textResp = (content) => ({ content, tool_calls: [], usage, model: 'test' });
const toolResp = (name) => ({
  content: '',
  tool_calls: [{ id: 'c1', name, arguments: {} }],
  usage,
  model: 'test'
});

test('简单问答首轮只发相关性子集（非全量）', async () => {
  const { reg, allNames } = buildRegistry();
  const llm = fakeLLM(() => textResp('今天天气晴。'));
  const h = new AgentHarness({
    llm: llm.fn,
    tools: reg,
    model: 'test',
    maxSteps: 4
  });
  const out = await h.run('今天天气怎么样');
  assert.match(out, /天气/);
  // 首轮（第 1 次 LLM 调用）收到的是子集，而不是全部 12 个工具。
  assert.ok(llm.calls.length >= 1, '应至少调用一次 LLM');
  assert.ok(
    llm.calls[0].length < allNames.length,
    `首轮应发子集而非全量：收到 ${llm.calls[0].length}/${allNames.length}`
  );
  // 简单问答不应触发工具执行（无 tool_calls，调用次数为 1）。
  assert.strictEqual(llm.calls.length, 1, '简单问答应只调用一次 LLM');
});

test('子集外的已注册工具仍被直接执行（能力不丢，且不丢弃有效 tool_call）', async () => {
  const { reg, executed, allNames } = buildRegistry();
  const ghost = 'mcp__zzz_ghost';
  // 输入命中 weather 等工具描述、但不命中 ghost 的「冰箱温控器」描述，
  // 因此首轮子集不含 ghost；模型点名 ghost 属于「子集外但已注册」的工具。
  const llm = fakeLLM((n, tools) => {
    const present = tools.map((t) => t.name);
    if (n === 1) {
      // 首轮：子集（非空、不含 ghost）。
      assert.ok(present.length > 0 && present.length < allNames.length, `首轮应是子集：${present.length}/${allNames.length}`);
      assert.ok(!present.includes(ghost), '首轮子集不应包含 ghost');
      return toolResp(ghost); // 模型点名了子集外的 ghost
    }
    // 第二步起：返回最终文本，结束运行。
    return textResp('已通过 ghost 工具处理完毕');
  });
  const h = new AgentHarness({
    llm: llm.fn,
    tools: reg,
    model: 'test',
    maxSteps: 6
  });
  const out = await h.run('帮我查一下今天的天气');
  // 首轮确实是子集（动态选择生效）。
  assert.ok(llm.calls[0].length < allNames.length, '首轮应发子集');
  // 关键：子集外的 ghost 是已注册工具，harness 走全量注册表直接执行，
  // 不会因「不在子集」而丢弃 tool_call，也不应无脑重发全量 schema。
  assert.ok(executed.includes(ghost), `子集外的已注册工具应被执行，实际：${JSON.stringify(executed)}`);
  assert.match(out, /ghost/);
});

test('模型幻觉的未知工具名触发一次全量 schema 重试', async () => {
  const { reg, executed, allNames } = buildRegistry();
  const hallucinated = 'mcp__does_not_exist';
  let expanded = false;
  const llm = fakeLLM((n, tools) => {
    if (n === 1) {
      // 模型点名一个根本不存在的工具（幻觉）。
      return toolResp(hallucinated);
    }
    if (n === 2) {
      expanded = tools.length === allNames.length;
      // 重试时给一个合法工具调用，结束。
      return toolResp('mcp__weather');
    }
    return textResp('done');
  });
  const h = new AgentHarness({
    llm: llm.fn,
    tools: reg,
    model: 'test',
    maxSteps: 6
  });
  await h.run('帮我查一下今天的天气');
  // 未知工具名 → 扩展到全量 schema 重试一次。
  assert.ok(expanded, '幻觉的未知工具名应触发一次全量 schema 重试');
  // 全量 schema 重试后模型改选了合法工具，执行阶段不应去执行不存在的工具。
  assert.ok(!executed.includes(hallucinated), '不应执行不存在的幻觉工具');
});

test('DYNAMIC_TOOLS=false 时退回全量（行为不变）', async () => {
  process.env.DYNAMIC_TOOLS = 'false';
  try {
    const { reg, allNames } = buildRegistry();
    const llm = fakeLLM(() => textResp('好的'));
    const h = new AgentHarness({ llm: llm.fn, tools: reg, model: 'test', maxSteps: 3 });
    await h.run('今天天气怎么样');
    assert.ok(
      llm.calls[0].length === allNames.length,
      `关闭动态选择应发全量，实际 ${llm.calls[0].length}/${allNames.length}`
    );
  } finally {
    delete process.env.DYNAMIC_TOOLS;
  }
});

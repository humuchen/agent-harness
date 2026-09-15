'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { AgentHarness } = require('../dist/harness.js');
const { ToolRegistry, objectParams } = require('../dist/tools.js');
const { Memory } = require('../dist/memory.js');

/**
 * 多轮对话 token 消耗跟踪测试。
 *
 * 目标：
 * 1. 模拟 10 轮真实对话（问候 → 任务 → 闲聊 → 任务 → …）
 * 2. 每轮记录 LLM 收到的 tools 数量、prompt_tokens、cached_tokens
 * 3. 输出 per-step token 分解（system / tools / history / mcp / skills / cached）
 * 4. 计算缓存命中率
 */

// 构造 18 个真实感工具注册表，模拟生产环境
function buildRegistry() {
  const r = new ToolRegistry();
  const names = [
    'send_message', 'read_file', 'write_code', 'run_tests', 'query_database',
    'search_web', 'translate_text', 'summarize_doc', 'create_issue', 'close_issue',
    'schedule_meeting', 'send_email', 'fetch_url', 'parse_pdf', 'generate_image',
    'transcribe_audio', 'deploy_service', 'list_agents',
  ];
  for (const n of names) {
    r.register(
      n,
      `工具 ${n} 的较长描述用于模拟真实 agent 的高固定 prompt 开销，description 超过一百字以便验证 compactToolSchema 的截断逻辑是否生效并降低发送给模型的 token 数量`,
      objectParams({}),
      async () => 'ok',
      'harness'
    );
  }
  return r;
}

// 模拟 LLM：每次返回固定内容 + mock usage，支持 tool_calls 触发
function makeMockLLM({ systemTokens, toolSchemaTokens, historyTokens, cachedTokens }) {
  let callCount = 0;
  return async (messages, tools) => {
    callCount += 1;

    // 模拟 provider 返回的 token 用量
    const toolCount = tools.length;
    // 每个工具约 300 token（schema 估算）
    const toolsTokens = toolCount * 300;
    const totalPrompt = systemTokens + toolsTokens + historyTokens;

    // 模拟 caching：前 3 次调用命中缓存（部分），后续命中率下降
    const isCached = callCount <= 3 && totalPrompt > 0;
    const cached = isCached ? Math.floor(totalPrompt * 0.2) : 0;
    const actualPrompt = totalPrompt - cached;

    // 返回 mock response
    const response = {
      content: '我明白了，这个问题比较简单，我来帮你处理。',
      tool_calls: [],
      usage: {
        prompt_tokens: actualPrompt,
        completion_tokens: 30,
        total_tokens: actualPrompt + 30,
        // 直接在 usage 上返回 cached_tokens（harness 会读取 resp.usage.cached_tokens）
        cached_tokens: cached,
      },
      model: 'mock-gpt-4o-mini',
    };

    return response;
  };
}

// 10 轮对话脚本：交替问候 / 任务 / 闲聊
const conversation = [
  '你好',
  '帮我写一个 Python 脚本，读取 CSV 文件并输出汇总统计。',
  '最近天气怎么样？',
  '查找一下我们团队的 GitHub 仓库，找到最近 merged 的 PR。',
  '今天吃什么呢？',
  '部署我们的新服务到 staging 环境，并运行健康检查。',
  '聊天啊，最近有什么好看的电影推荐吗？',
  '查询一下数据库中用户表的总行数和活跃用户数。',
  '周末计划什么？',
  '为我们的文档生成一份详细的 API 参考手册，包含所有接口参数。',
];

test('多轮对话 token 消耗追踪', async () => {
  // 启用动态工具选择 + prompt cache
  process.env.DYNAMIC_TOOLS = 'true';
  process.env.DYNAMIC_TOOL_TOPK = '8';
  process.env.PROMPT_CACHE = 'true';

  const registry = buildRegistry();
  const memory = new Memory();

  // token 统计收集器
  const usageStats = [];
  const costEvents = [];

  const mockLlm = makeMockLLM({
    systemTokens: 3000,
    toolSchemaTokens: 6000,
    historyTokens: 500,
    cachedTokens: 0,
  });

  const harness = new AgentHarness({
    llm: mockLlm,
    tools: registry,
    systemPrompt: '你是 agent-harness 的多轮对话测试助手。' + 'x'.repeat(2000),
    memory,
    onEvent: (e) => {
      if (e.type === 'llm:usage') {
        usageStats.push({
          step: e.step,
          promptTokens: e.promptTokens,
          completionTokens: e.completionTokens,
          totalTokens: e.totalTokens,
          cached: e.breakdown?.cached ?? 0,
          breakdown: e.breakdown,
        });
      }
      if (e.type === 'run:cost') {
        costEvents.push(e);
      }
    },
    model: 'gpt-4o-mini',
  });

  try {
    // 模拟 10 轮对话
    const allResults = [];

    for (let i = 0; i < conversation.length; i++) {
      const input = conversation[i];

      // 模拟多轮对话：将历史对话传入 memory，模拟真实上下文累积
      // 这里简单模拟：每次往 memory 中添加一轮对话
      if (i > 0) {
        // 添加上一轮对话到 memory
        memory.add({ role: 'user', content: conversation[i - 1] });
        memory.add({ role: 'assistant', content: '好的，我已经处理完了。' });
      }

      const result = await harness.run(input, { signal: AbortSignal.timeout(5000) });
      allResults.push({ turn: i + 1, input: input.slice(0, 50), result: result?.slice(0, 50) });
    }

    // 输出统计摘要
    console.log('\n========== 多轮对话 Token 消耗统计 ==========\n');

    let totalPrompt = 0;
    let totalCompletion = 0;
    let totalCached = 0;
    let cacheQueries = 0;
    let cacheHits = 0;

    usageStats.forEach((stat) => {
      totalPrompt += stat.promptTokens;
      totalCompletion += stat.completionTokens;
      totalCached += stat.cached;
      if (stat.cached > 0) cacheHits++;
      cacheQueries++;

      console.log(`第 ${stat.step} 轮:`);
      console.log(`  prompt_tokens: ${stat.promptTokens}`);
      console.log(`  completion_tokens: ${stat.completionTokens}`);
      console.log(`  cached_tokens: ${stat.cached}`);
      console.log(`  breakdown: ${JSON.stringify(stat.breakdown)}`);
      console.log(`  tools token (估算): ${stat.breakdown?.tools ?? 'N/A'}`);
      console.log(`  system token (估算): ${stat.breakdown?.system ?? 'N/A'}`);
      console.log('');
    });

    const avgPrompt = Math.round(totalPrompt / cacheQueries);
    const avgCompletion = Math.round(totalCompletion / cacheQueries);
    const avgCached = Math.round(totalCached / cacheQueries);
    const hitRate = cacheQueries > 0 ? (cacheHits / cacheQueries) * 100 : 0;
    const tokenHitRate = totalPrompt > 0 ? (totalCached / totalPrompt) * 100 : 0;

    console.log('========== 汇总统计 ==========\n');
    console.log(`总轮次: ${cacheQueries}`);
    console.log(`总 prompt_tokens: ${totalPrompt}`);
    console.log(`总 completion_tokens: ${totalCompletion}`);
    console.log(`总 cached_tokens: ${totalCached}`);
    console.log(`平均 prompt_tokens/轮: ${avgPrompt}`);
    console.log(`平均 completion_tokens/轮: ${avgCompletion}`);
    console.log(`平均 cached_tokens/轮: ${avgCached}`);
    console.log(`请求级缓存命中率: ${hitRate.toFixed(1)}% (${cacheHits}/${cacheQueries}`);
    console.log(`Token 级缓存命中率: ${tokenHitRate.toFixed(1)}% (${totalCached}/${totalPrompt})`);
    console.log('');

    // 断言检查
    assert.ok(usageStats.length >= 1, '应至少收集到 1 个 ll:usage 事件');
    console.log('✅ 多轮对话 token 消耗追踪测试通过');
  } finally {
    delete process.env.DYNAMIC_TOOLS;
    delete process.env.DYNAMIC_TOOL_TOPK;
    delete process.env.PROMPT_CACHE;
  }
});

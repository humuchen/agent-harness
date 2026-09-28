'use strict';
// 压缩方案实施（Token 成本优化）回归测试，对应六条压缩方案的四个代码落点：
//   1) web_fetch 默认抓取上限收紧（200k → 4k 字符，env WEB_FETCH_DEFAULT_MAX_CHARS 可调）
//   2) web_fetch 近空结果检测（near_empty + 引导提示 + stats.nearEmpty）
//   3) Memory.foldStaleToolResults 陈旧工具结果折叠（保配对、env 可关）
//   4) 同批 tool_calls 有界并发执行（保序回填、AH_TOOL_CONCURRENCY 控制）
// 零依赖（node:test + node:assert），直接 require 编译产物。
const test = require('node:test');
const assert = require('node:assert');

const { ToolRegistry, objectParams } = require('../dist/tools.js');
const {
  registerWebFetch,
  getWebFetchStats,
  resetWebFetchStats,
} = require('../dist/builtins/webfetch.js');
const { Memory } = require('../dist/memory.js');
const { AgentHarness } = require('../dist/harness.js');

// ---------------------------------------------------------------------------
// env 沙箱：保存/恢复，避免测试间串扰
// ---------------------------------------------------------------------------
function withEnv(env, fn) {
  const saved = {};
  for (const k of Object.keys(env)) saved[k] = process.env[k];
  for (const k of Object.keys(env)) {
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const k of Object.keys(saved)) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    });
}

function mockFetch(body, contentType = 'text/html; charset=utf-8') {
  const prev = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(body, { status: 200, headers: { 'content-type': contentType } });
  return () => {
    globalThis.fetch = prev;
  };
}

function webFetchRegistry(opts = {}) {
  const r = new ToolRegistry();
  registerWebFetch(r, opts);
  return r;
}

// ---------------------------------------------------------------------------
// 1) 默认抓取上限收紧
// ---------------------------------------------------------------------------

test('web_fetch 默认抓取上限收紧为 4000 字符', () =>
  withEnv(
    { WEB_FETCH_ALLOW_PRIVATE_NETWORK: 'on', WEB_FETCH_DEFAULT_MAX_CHARS: undefined },
    async () => {
      restore = mockFetch(
        '<html><title>长文</title><body><p>' + 'x'.repeat(20000) + '</p></body></html>'
      );
      try {
        resetWebFetchStats();
        const out = await webFetchRegistry().call('builtin__web_fetch', {
          url: 'https://example.com/long',
        });
        const obj = JSON.parse(out);
        assert.ok(
          obj.length <= 4000 + 100,
          '截断后总长不应超过默认上限 4000（+标记余量），实际 ' + obj.length
        );
        assert.ok(out.includes('truncated at 4000 chars'), '应包含默认上限截断标记');
      } finally {
        restore();
      }
    }
  ));

let restore = () => {};

test('WEB_FETCH_DEFAULT_MAX_CHARS 可覆盖默认上限', () =>
  withEnv(
    { WEB_FETCH_ALLOW_PRIVATE_NETWORK: 'on', WEB_FETCH_DEFAULT_MAX_CHARS: '500' },
    async () => {
      restore = mockFetch('<html><body><p>' + 'y'.repeat(5000) + '</p></body></html>');
      try {
        const out = await webFetchRegistry().call('builtin__web_fetch', {
          url: 'https://example.com/mid',
        });
        const obj = JSON.parse(out);
        assert.ok(obj.length <= 500 + 100, '应按 env 上限 500 截断，实际 ' + obj.length);
        assert.ok(out.includes('truncated at 500 chars'));
      } finally {
        restore();
      }
    }
  ));

test('显式传 max_bytes 仍可单次提升上限', () =>
  withEnv(
    { WEB_FETCH_ALLOW_PRIVATE_NETWORK: 'on', WEB_FETCH_DEFAULT_MAX_CHARS: undefined },
    async () => {
      restore = mockFetch('<html><body><p>' + 'z'.repeat(9000) + '</p></body></html>');
      try {
        const out = await webFetchRegistry().call('builtin__web_fetch', {
          url: 'https://example.com/need-more',
          max_bytes: 10000,
        });
        const obj = JSON.parse(out);
        assert.ok(obj.length >= 9000, '显式 max_bytes=10000 时 9000 字符正文不应被截断');
        assert.ok(!out.includes('truncated at'));
      } finally {
        restore();
      }
    }
  ));

// ---------------------------------------------------------------------------
// 2) 近空结果检测
// ---------------------------------------------------------------------------

test('web_fetch 近空正文返回 near_empty 提示并计入 stats', () =>
  withEnv({ WEB_FETCH_ALLOW_PRIVATE_NETWORK: 'on' }, async () => {
    restore = mockFetch('<html><body><p>hi</p></body></html>');
    try {
      resetWebFetchStats();
      const out = await webFetchRegistry().call('builtin__web_fetch', {
        url: 'https://example.com/empty-shell',
      });
      const obj = JSON.parse(out);
      assert.strictEqual(obj.near_empty, true, '近空正文应标记 near_empty');
      assert.ok(obj.hint.includes('Do NOT retry'), '应包含「勿重试同一 URL」引导');
      assert.ok(getWebFetchStats().nearEmpty >= 1, 'stats.nearEmpty 应计数');
    } finally {
      restore();
    }
  }));

test('web_fetch 正常长文不标记 near_empty', () =>
  withEnv({ WEB_FETCH_ALLOW_PRIVATE_NETWORK: 'on' }, async () => {
    restore = mockFetch(
      '<html><body>' + Array.from({ length: 60 }, (_, i) => `<p>第${i}段内容，足够长的正常正文。</p>`).join('') + '</body></html>'
    );
    try {
      const out = await webFetchRegistry().call('builtin__web_fetch', {
        url: 'https://example.com/normal',
      });
      const obj = JSON.parse(out);
      assert.ok(!('near_empty' in obj), '正常长文不应标记 near_empty');
    } finally {
      restore();
    }
  }));

// ---------------------------------------------------------------------------
// 3) Memory.foldStaleToolResults 陈旧工具结果折叠
// ---------------------------------------------------------------------------

function longToolContent(n) {
  return '抓取正文开始\n' + Array.from({ length: n }, (_, i) => `行${i}：内容细节 ${i * 7}`).join('\n') + '\n抓取正文结束';
}

function buildMemoryWithStaleTool() {
  const mem = new Memory();
  // 组0: user；组1: assistant(tool_calls)+tool（长结果，将被折叠）
  mem.add({ role: 'user', content: '第一个问题' });
  mem.add({
    role: 'assistant',
    content: '',
    tool_calls: [{ id: 'c1', name: 'builtin__web_fetch', arguments: { url: 'https://a.example' } }],
  });
  mem.add({ role: 'tool', tool_call_id: 'c1', name: 'builtin__web_fetch', content: longToolContent(300) });
  // 组2: user；组3: assistant(tool_calls)+tool（近期长结果，应保留完整）
  mem.add({ role: 'user', content: '第二个问题' });
  mem.add({
    role: 'assistant',
    content: '',
    tool_calls: [{ id: 'c2', name: 'builtin__web_fetch', arguments: { url: 'https://b.example' } }],
  });
  mem.add({ role: 'tool', tool_call_id: 'c2', name: 'builtin__web_fetch', content: longToolContent(300) });
  return mem;
}

test('foldStaleToolResults 折叠陈旧工具结果、保留近期结果且不破坏配对', () =>
  withEnv({}, () => {
    const mem = buildMemoryWithStaleTool();
    const changed = mem.foldStaleToolResults();
    assert.strictEqual(changed, true, '应折叠至少一条陈旧结果');
    const tools = mem.history().filter((m) => m.role === 'tool');
    assert.strictEqual(tools.length, 2, 'tool 消息条数不变');
    const stale = tools.find((m) => m.tool_call_id === 'c1');
    const fresh = tools.find((m) => m.tool_call_id === 'c2');
    assert.ok(stale.content.includes('【工具结果已折叠】'), '陈旧结果应含折叠标记');
    assert.ok(stale.content.length < 1500, '折叠后长度应大幅缩减');
    assert.ok(stale.content.startsWith('抓取正文开始'), '保留开头');
    assert.ok(stale.content.trimEnd().endsWith('抓取正文结束'), '保留结尾');
    assert.ok(!fresh.content.includes('【工具结果已折叠】'), '近期组结果应保留完整');
    // 配对完整性：tool_call_id 与 name 保留
    assert.strictEqual(stale.tool_call_id, 'c1');
    assert.strictEqual(stale.name, 'builtin__web_fetch');
    // 幂等：再次折叠不重复处理
    assert.strictEqual(mem.foldStaleToolResults(), false, '已折叠内容不应二次折叠');
  }));

test('AH_STALE_TOOL_FOLD=off 时关闭折叠', () =>
  withEnv({ AH_STALE_TOOL_FOLD: 'off' }, () => {
    const mem = buildMemoryWithStaleTool();
    assert.strictEqual(mem.foldStaleToolResults(), false, '关闭时应直接返回 false');
    const tools = mem.history().filter((m) => m.role === 'tool');
    assert.ok(!tools.some((m) => m.content.includes('【工具结果已折叠】')), '不应有任何折叠');
  }));

test('短工具结果不触发折叠', () =>
  withEnv({}, () => {
    const mem = new Memory();
    mem.add({ role: 'user', content: 'q' });
    mem.add({ role: 'assistant', content: '', tool_calls: [{ id: 'c1', name: 't', arguments: {} }] });
    mem.add({ role: 'tool', tool_call_id: 'c1', name: 't', content: '短结果' });
    mem.add({ role: 'user', content: 'q2' });
    mem.add({ role: 'assistant', content: 'a2' });
    assert.strictEqual(mem.foldStaleToolResults(), false, '低于 MIN_CHARS 的结果不折叠');
  }));

// ---------------------------------------------------------------------------
// 4) 同批 tool_calls 有界并发执行 + 保序回填
// ---------------------------------------------------------------------------

function makeConcurrencyLLM(captured) {
  let n = 0;
  return async (messages) => {
    n += 1;
    captured.push(messages);
    if (n === 1) {
      return {
        content: '',
        tool_calls: [
          { id: 'c1', name: 'slow', arguments: { i: 1 } },
          { id: 'c2', name: 'slow', arguments: { i: 2 } },
          { id: 'c3', name: 'slow', arguments: { i: 3 } },
        ],
      };
    }
    return { content: 'done', tool_calls: [] };
  };
}

function makeSlowTools(state) {
  const tools = new ToolRegistry();
  tools.register(
    'slow',
    '慢工具',
    objectParams({ i: { type: 'number' } }, ['i']),
    async (a) => {
      state.concurrent += 1;
      state.maxConcurrent = Math.max(state.maxConcurrent, state.concurrent);
      await new Promise((r) => setTimeout(r, 40));
      state.concurrent -= 1;
      return 'r' + a.i;
    }
  );
  return tools;
}

test('同批 tool_calls 并发执行且按原序回填', () =>
  withEnv({ AH_TOOL_CONCURRENCY: '4' }, async () => {
    const state = { concurrent: 0, maxConcurrent: 0 };
    const captured = [];
    const h = new AgentHarness({ llm: makeConcurrencyLLM(captured), tools: makeSlowTools(state) });
    const out = await h.run('go');
    assert.strictEqual(out, 'done');
    assert.ok(state.maxConcurrent >= 2, `应至少 2 路并发，实测 ${state.maxConcurrent}`);
    // 保序：第二轮喂给 LLM 的历史中 tool 结果顺序与 tool_calls 一致
    const toolMsgs = captured[1].filter((m) => m.role === 'tool');
    assert.deepStrictEqual(
      toolMsgs.map((m) => m.tool_call_id),
      ['c1', 'c2', 'c3'],
      'tool 结果顺序必须与 tool_calls 严格一致'
    );
    assert.deepStrictEqual(
      toolMsgs.map((m) => m.content),
      ['r1', 'r2', 'r3'],
      '每个 tool_call_id 对应正确结果'
    );
  }));

test('AH_TOOL_CONCURRENCY=1 退化为串行执行', () =>
  withEnv({ AH_TOOL_CONCURRENCY: '1' }, async () => {
    const state = { concurrent: 0, maxConcurrent: 0 };
    const captured = [];
    const h = new AgentHarness({ llm: makeConcurrencyLLM(captured), tools: makeSlowTools(state) });
    const out = await h.run('go');
    assert.strictEqual(out, 'done');
    assert.strictEqual(state.maxConcurrent, 1, '并发 1 时不允许重叠执行');
    const toolMsgs = captured[1].filter((m) => m.role === 'tool');
    assert.deepStrictEqual(toolMsgs.map((m) => m.tool_call_id), ['c1', 'c2', 'c3']);
  }));

// 零依赖测试（node:test + node:assert）：覆盖 builtin__jev_decide 的注册门控与运行期行为。
// 直接 require 编译后的叶子模块（../dist/...），与 builtins.test.cjs 保持一致。
const test = require('node:test');
const assert = require('node:assert');

const { ToolRegistry } = require('../dist/tools.js');
const { registerJevDecide } = require('../dist/builtins/index.js');

/** 用 opts.apiKey 注册 Jev 工具，返回注册表。 */
function regWithKey(apiKey, extra = {}) {
  const r = new ToolRegistry();
  registerJevDecide(r, { apiKey, baseUrl: 'https://api.typesafe.ai/v1', timeoutMs: 1000, ...extra });
  return r;
}

test('无 Key（env 与 opts 均缺）时不注册 Jev 工具', () => {
  const orig = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  const r = new ToolRegistry();
  registerJevDecide(r, {}); // 不传 apiKey，且不依赖 env
  assert.equal(r.schemas().length, 0, '缺失 Key 时应不注册任何工具');
  if (orig !== undefined) process.env.TYPESAFE_API_KEY = orig;
});

test('传入 apiKey 后注册 builtin__jev_decide，且参数含 state/questions', () => {
  const schemas = regWithKey('ts_test_key').schemas();
  assert.equal(schemas.length, 1);
  assert.equal(schemas[0].name, 'builtin__jev_decide');
  const props = schemas[0].parameters.properties;
  assert.ok(props.state, '应有 state 参数');
  assert.ok(props.questions, '应有 questions 参数');
  assert.ok(props.model, '应有可选 model 参数');
});

test('成功路径：把 Jev 结构化决策原样透传（含 latency_ms）', async () => {
  const fakeAnswers = {
    answers: {
      category: { choice: 'billing', probabilities: { billing: 0.81, technical: 0.12, sales: 0.07 }, confidence: 0.81 },
      urgency: { score: 73, confidence: 0.66 },
      is_chargeback_risk: { noul: 0.22, confidence: 0.9 }
    }
  };
  const calls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return {
      ok: true,
      status: 200,
      json: async () => fakeAnswers
    };
  };
  try {
    const r = new ToolRegistry();
    registerJevDecide(r, { apiKey: 'ts_test_key', baseUrl: 'https://api.typesafe.ai/v1' });
    const out = JSON.parse(await r.call('builtin__jev_decide', {
      state: '用户两周内两次催退款失败，语气焦虑',
      questions: {
        category: { type: 'choice', options: ['billing', 'technical', 'sales'], instructions: '哪个团队处理' },
        urgency: { type: 'score', min: 0, max: 100 },
        is_chargeback_risk: { type: 'noul' }
      }
    }));
    // 断言：请求打到正确的 /systemone 端点，且带 Bearer 鉴权。
    assert.equal(calls[0].url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(calls[0].opts.headers.Authorization, 'Bearer ts_test_key');
    const body = JSON.parse(calls[0].opts.body);
    assert.equal(body.model, 'jev-latest', '默认模型应为 jev-latest');
    assert.equal(body.state, '用户两周内两次催退款失败，语气焦虑');
    assert.ok(body.questions.category, '请求体应携带 questions');
    // 断言：决策内容被透传，并附带 latency_ms。
    assert.ok(out.latency_ms >= 0, '应回传 latency_ms');
    assert.deepEqual(out.answers, fakeAnswers.answers, 'Jev 的结构化决策应原样透传');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('非 2xx 响应：返回 Jev API error 且不含明文崩溃', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 401, text: async () => 'unauthorized' });
  try {
    const r = new ToolRegistry();
    registerJevDecide(r, { apiKey: 'ts_test_key' });
    const out = JSON.parse(await r.call('builtin__jev_decide', {
      state: 'x', questions: { a: { type: 'noul' } }
    }));
    assert.ok(out.error, '应回传 error 字段');
    assert.match(out.error, /Jev API error: 401/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('网络/超时异常：被捕获并回传 error（不抛出）', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };
  try {
    const r = new ToolRegistry();
    registerJevDecide(r, { apiKey: 'ts_test_key' });
    const out = JSON.parse(await r.call('builtin__jev_decide', {
      state: 'x', questions: { a: { type: 'noul' } }
    }));
    assert.ok(out.error, '应回传 error 字段');
    assert.match(out.error, /Jev decision failed/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('参数校验：缺少 state 时返回 error', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
  try {
    const r = new ToolRegistry();
    registerJevDecide(r, { apiKey: 'ts_test_key' });
    const out = JSON.parse(await r.call('builtin__jev_decide', { questions: { a: { type: 'noul' } } }));
    assert.ok(out.error, '缺少 state 应返回 error');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('参数校验：questions 为空对象时返回 error', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
  try {
    const r = new ToolRegistry();
    registerJevDecide(r, { apiKey: 'ts_test_key' });
    const out = JSON.parse(await r.call('builtin__jev_decide', { state: 'x', questions: {} }));
    assert.ok(out.error, 'questions 为空应返回 error');
  } finally {
    globalThis.fetch = origFetch;
  }
});

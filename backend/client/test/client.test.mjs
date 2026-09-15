/**
 * @agent-harness/client 离线契约测试（零网络、零依赖、可在任意 CI 环境跑）。
 *
 * 用注入的 fetchImpl 替身覆盖客户端全部关键行为：URL 拼装、Bearer 鉴权、
 * JSON/错误映射、202 审批工单、以及 SSE 解析原语的分帧健壮性。
 * 端到端（真实 server）验证在 test/smoke.mjs，由 `pnpm run test:e2e` 触发。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(HERE, '..', 'dist', 'index.js');

if (!existsSync(DIST)) {
  console.error(
    `[client:test] 未找到构建产物 ${DIST}\n` +
      '           请先构建：pnpm --filter @agent-harness/client run build（或 pnpm -r build）'
  );
  process.exit(1);
}

// Windows 下 ESM 动态 import 必须用 file:// URL，绝对路径（c:\...）会被当成未知协议。
const { AgentClient, ApiError, ApprovalRequiredError, parseSse } = await import(
  pathToFileURL(DIST).href
);

/* --------------------------------- 测试替身 --------------------------------- */

/**
 * 记录调用并按序返回预置响应的 fetch 替身。
 * 注意：Response 的 body 只能消费一次，多次调用请传工厂函数（() => jsonRes(...)）。
 */
function fakeFetch(responses) {
  const calls = [];
  const queue = Array.isArray(responses) ? [...responses] : [responses];
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), init, headers: new Headers(init.headers) });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    return typeof next === 'function' ? next() : next;
  };
  return { impl, calls };
}

function jsonRes(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** 用给定分片构造一条 SSE 响应（分片刻意跨帧边界切开）。 */
function sseRes(chunks, status = 200) {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    start(c) {
      for (const s of chunks) c.enqueue(enc.encode(s));
      c.close();
    },
  });
  return new Response(stream, {
    status,
    headers: { 'content-type': 'text/event-stream' },
  });
}

const frame = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

/* --------------------------------- REST 契约 -------------------------------- */

test('getState 命中 /api/v1/state 且 baseUrl 尾部斜杠被规范化', async () => {
  const { impl, calls } = fakeFetch(jsonRes({ model: 'mock', mcpServers: [] }));
  const client = new AgentClient({ baseUrl: 'http://h.test///', fetchImpl: impl });
  const state = await client.getState();
  assert.equal(calls[0].url, 'http://h.test/api/v1/state');
  assert.equal(state.model, 'mock');
  assert.deepEqual(state.mcpServers, []);
});

test('token 以 Bearer 注入，且 setToken 可动态切换/清除', async () => {
  const { impl, calls } = fakeFetch(() => jsonRes({}));
  const client = new AgentClient({ baseUrl: 'http://h.test', token: 't1', fetchImpl: impl });
  await client.getState();
  assert.equal(calls[0].headers.get('authorization'), 'Bearer t1');

  client.setToken('t2');
  await client.getState();
  assert.equal(calls[1].headers.get('authorization'), 'Bearer t2');

  client.setToken(undefined);
  await client.getState();
  assert.equal(calls[2].headers.get('authorization'), null);
});

test('带 body 的请求自动补 content-type: application/json', async () => {
  const { impl, calls } = fakeFetch(jsonRes({ recipe: { id: 'r1' } }));
  const client = new AgentClient({ baseUrl: 'http://h.test', fetchImpl: impl });
  await client.saveRecipe({ jobId: 'j1', name: 'n' });
  assert.equal(calls[0].url, 'http://h.test/api/v1/recipes');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].headers.get('content-type'), 'application/json');
  assert.deepEqual(JSON.parse(calls[0].init.body), { jobId: 'j1', name: 'n' });
});

test('查询参数正确编码（approvals / memory）', async () => {
  const { impl, calls } = fakeFetch(() => jsonRes({ tickets: [] }));
  const client = new AgentClient({ baseUrl: 'http://h.test', fetchImpl: impl });
  await client.listApprovals('pending');
  await client.getMemory('tenant/a b');
  assert.equal(calls[0].url, 'http://h.test/api/v1/approvals?status=pending');
  assert.equal(calls[1].url, 'http://h.test/api/v1/memory?session=tenant%2Fa%20b');
});

test('非 2xx 抛 ApiError，message 取服务端 error 字段', async () => {
  const { impl } = fakeFetch(jsonRes({ error: 'forbidden' }, 403));
  const client = new AgentClient({ baseUrl: 'http://h.test', fetchImpl: impl });
  await assert.rejects(() => client.getState(), (e) => {
    assert.ok(e instanceof ApiError);
    assert.equal(e.status, 403);
    assert.equal(e.message, 'forbidden');
    assert.deepEqual(e.body, { error: 'forbidden' });
    return true;
  });
});

test('空响应体不炸（204 视为 undefined）', async () => {
  const { impl } = fakeFetch(new Response('', { status: 200 }));
  const client = new AgentClient({ baseUrl: 'http://h.test', fetchImpl: impl });
  assert.equal(await client.getState(), undefined);
});

test('运行时缺少 fetch 时构造即报错，而非运行到一半才失败', () => {
  const original = globalThis.fetch;
  try {
    delete globalThis.fetch;
    assert.throws(
      () => new AgentClient({ baseUrl: 'http://h.test' }),
      /global fetch unavailable/
    );
  } finally {
    globalThis.fetch = original;
  }
});

/* --------------------------------- SSE 契约 --------------------------------- */

test('streamRun 逐帧产出事件，含 job:accepted 与 _done 终结帧', async () => {
  const { impl, calls } = fakeFetch(
    sseRes([
      frame({ type: 'job:accepted', jobId: 'j1' }),
      frame({ type: 'step', index: 0 }),
      frame({ type: '_done' }),
    ])
  );
  const client = new AgentClient({ baseUrl: 'http://h.test', fetchImpl: impl });
  const seen = [];
  for await (const ev of client.streamRun({ mode: 'mock', prompt: 'hi' })) seen.push(ev.type);
  assert.equal(calls[0].url, 'http://h.test/api/v1/run');
  assert.deepEqual(seen, ['job:accepted', 'step', '_done']);
});

test('streamRun 遇 202 抛 ApprovalRequiredError（携带 ticketId / poll）', async () => {
  const { impl } = fakeFetch(jsonRes({ ticketId: 'tk1', poll: '/api/v1/approvals/tk1' }, 202));
  const client = new AgentClient({ baseUrl: 'http://h.test', fetchImpl: impl });
  await assert.rejects(
    async () => {
      for await (const _ of client.streamRun({ mode: 'mock', prompt: 'hi' })) void _;
    },
    (e) => {
      assert.ok(e instanceof ApprovalRequiredError);
      assert.equal(e.ticketId, 'tk1');
      assert.equal(e.poll, '/api/v1/approvals/tk1');
      assert.equal(e.action, 'agent:run');
      return true;
    }
  );
});

test('SSE 端点非 2xx 抛 ApiError（streamVerify）', async () => {
  const { impl } = fakeFetch(new Response('nope', { status: 500 }));
  const client = new AgentClient({ baseUrl: 'http://h.test', fetchImpl: impl });
  await assert.rejects(
    async () => {
      for await (const _ of client.streamVerify()) void _;
    },
    (e) => e instanceof ApiError && e.status === 500
  );
});

test('parseSse 跨 chunk 重组帧、跳过畸形帧、收尾处理无 \\n\\n 的末帧', async () => {
  const res = sseRes([
    'data: {"type":"a"',
    '}\n\ndata: {不是 json}\n\n',
    'data: {"type":"b"}\n\n',
    'data: {"type":"tail"}',
  ]);
  const out = [];
  for await (const ev of parseSse(res)) out.push(ev.type);
  assert.deepEqual(out, ['a', 'b', 'tail']);
});

test('parseSse 支持多行 data 拼接并忽略注释/心跳帧', async () => {
  const res = sseRes([': keep-alive\n\n', 'data: {"type":\ndata: "multi"}\n\n']);
  const out = [];
  for await (const ev of parseSse(res)) out.push(ev.type);
  assert.deepEqual(out, ['multi']);
});

test('parseSse 响应无 body 时明确报错', async () => {
  await assert.rejects(async () => {
    for await (const _ of parseSse({ body: null })) void _;
  }, /no body/);
});

test('signal 已中断时 SSE 迭代立即安全退出', async () => {
  const res = sseRes([frame({ type: 'a' }), frame({ type: '_done' })]);
  const ac = new AbortController();
  ac.abort();
  const out = [];
  for await (const ev of parseSse(res, { signal: ac.signal })) out.push(ev);
  assert.deepEqual(out, []);
});

/* ------------------------- 工作流（plan 来源 / P3） ------------------------- */

test('streamWorkflowFromPlan POST /api/v1/workflows 带 { plan, agentRef, mode }，SSE 逐帧产出', async () => {
  const plan = { goal: 'g', tasks: [{ id: 't1', title: 'x', steps: [], dependsOn: [], expectedOutput: 'o' }] };
  const { impl, calls } = fakeFetch(
    sseRes([frame({ type: 'wf:start', workflowId: 'plan-1' }), frame({ type: 'wf:done', workflowId: 'plan-1', run: {} })])
  );
  const client = new AgentClient({ baseUrl: 'http://h.test', fetchImpl: impl });
  const out = [];
  for await (const ev of client.streamWorkflowFromPlan(plan, { agentRef: 'agent-a', mode: 'real' })) out.push(ev.type);
  assert.deepEqual(out, ['wf:start', 'wf:done']);
  assert.equal(calls[0].url, 'http://h.test/api/v1/workflows');
  assert.deepEqual(JSON.parse(calls[0].init.body).plan, plan);
  assert.equal(JSON.parse(calls[0].init.body).agentRef, 'agent-a');
  assert.equal(JSON.parse(calls[0].init.body).mode, 'real');
});

test('streamWorkflowFromPlan 全空 opts 时 body 仅 { plan }（服务端回落默认 agent / mock 模式）', async () => {
  const { impl, calls } = fakeFetch(sseRes([frame({ type: 'wf:done', workflowId: 'w', run: {} })]));
  const client = new AgentClient({ baseUrl: 'http://h.test', fetchImpl: impl });
  const out = [];
  for await (const _ of client.streamWorkflowFromPlan({ goal: 'g', tasks: [] })) out.push(_);
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(Object.keys(body), ['plan']);
});

test('streamWorkflowFromPlan 非 2xx 抛 ApiError', async () => {
  const { impl } = fakeFetch(new Response('bad plan', { status: 400 }));
  const client = new AgentClient({ baseUrl: 'http://h.test', fetchImpl: impl });
  await assert.rejects(
    async () => {
      for await (const _ of client.streamWorkflowFromPlan({ goal: 'g' })) void _;
    },
    (e) => e instanceof ApiError && e.status === 400
  );
});

test('streamWorkflowResume POST /api/v1/workflows/:id/resume，SSE 逐帧产出', async () => {
  const { impl, calls } = fakeFetch(sseRes([frame({ type: 'wf:done', workflowId: 'plan-9', run: {} })]));
  const client = new AgentClient({ baseUrl: 'http://h.test', fetchImpl: impl });
  const out = [];
  for await (const ev of client.streamWorkflowResume('plan-9')) out.push(ev.type);
  assert.deepEqual(out, ['wf:done']);
  assert.equal(calls[0].url, 'http://h.test/api/v1/workflows/plan-9/resume');
  assert.equal(calls[0].init.method, 'POST');
});

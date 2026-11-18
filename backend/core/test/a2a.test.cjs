// 零依赖测试（node:test + node:assert）：覆盖 P1-④ A2A 统一通信协议。
// - LocalA2ATransport：进程内 handoff（runner 回调），成功/失败映射为 TaskResult
// - HttpA2ATransport：跨主机投递到 /api/a2a/tasks，成功/HTTP 错误/网络异常三种形态
// - transportFor / dispatchAgentTask：按 AgentCard.transport+endpoint 选择传输

const test = require('node:test');
const assert = require('node:assert');

const a2a = require('../dist/a2a/index.js');
const { LocalA2ATransport, HttpA2ATransport, transportFor, dispatchAgentTask, deliverA2ACallback } = a2a;
const { makeDefaultAgentCard, DEFAULT_AGENT_ID } = require('../dist/agents/index.js');

// 一个把 input 包成结构化输出的 runner，模拟「本地 agent 执行」。
function makeRunner(map = {}) {
  return async (agentRef, input, meta) => {
    const id = typeof agentRef === 'string' ? agentRef : agentRef.id;
    if (map[id] && map[id].throw) throw new Error(map[id].throw);
    return { agent: id, got: input, meta };
  };
}

test('LocalA2ATransport: 进程内 handoff 成功映射为 TaskResult.success', async () => {
  const runner = makeRunner();
  const transport = new LocalA2ATransport(runner);
  const env = {
    taskId: 't1',
    tenantId: 'tenantA',
    traceId: 'tr1',
    fromAgent: 'default',
    toAgent: DEFAULT_AGENT_ID,
    input: { q: 'hello' },
  };
  const result = await transport.send(env);
  assert.strictEqual(result.taskId, 't1');
  assert.strictEqual(result.status, 'success');
  assert.deepStrictEqual(result.output, { agent: DEFAULT_AGENT_ID, got: { q: 'hello' }, meta: { tenantId: 'tenantA', traceId: 'tr1', fromAgent: 'default' } });
});

test('LocalA2ATransport: runner 抛错映射为 TaskResult.failed（不向上抛）', async () => {
  const runner = makeRunner({ [DEFAULT_AGENT_ID]: { throw: 'boom' } });
  const transport = new LocalA2ATransport(runner);
  const env = { taskId: 't2', tenantId: 't', fromAgent: 'a', toAgent: DEFAULT_AGENT_ID, input: 'x' };
  const result = await transport.send(env);
  assert.strictEqual(result.status, 'failed');
  assert.ok(result.error && result.error.includes('boom'));
});

test('HttpA2ATransport: 成功响应解析为 TaskResult.success', async () => {
  const fakeFetch = async (url, opts) => {
    assert.ok(url.endsWith('/api/a2a/tasks'));
    assert.strictEqual(opts.method, 'POST');
    const body = JSON.parse(opts.body);
    assert.ok(body.envelope && body.envelope.taskId === 't3');
    return {
      ok: true,
      status: 200,
      json: async () => ({ result: { taskId: 't3', status: 'success', output: { remote: true } } }),
    };
  };
  const transport = new HttpA2ATransport('https://agent-b.example.com/', fakeFetch);
  const env = { taskId: 't3', tenantId: 't', fromAgent: 'a', toAgent: 'agentB', input: 'go' };
  const result = await transport.send(env);
  assert.strictEqual(result.status, 'success');
  assert.deepStrictEqual(result.output, { remote: true });
});

test('HttpA2ATransport: 远端非 2xx 映射为 failed', async () => {
  const fakeFetch = async () => ({ ok: false, status: 500, text: async () => 'boom server' });
  const transport = new HttpA2ATransport('https://agent-b.example.com', fakeFetch);
  const env = { taskId: 't4', tenantId: 't', fromAgent: 'a', toAgent: 'agentB', input: 'go' };
  const result = await transport.send(env);
  assert.strictEqual(result.status, 'failed');
  assert.ok(result.error && result.error.includes('500'));
});

test('HttpA2ATransport: 网络异常映射为 failed（不向上抛）', async () => {
  const fakeFetch = async () => { throw new Error('ECONNREFUSED'); };
  const transport = new HttpA2ATransport('https://agent-b.example.com', fakeFetch);
  const env = { taskId: 't5', tenantId: 't', fromAgent: 'a', toAgent: 'agentB', input: 'go' };
  const result = await transport.send(env);
  assert.strictEqual(result.status, 'failed');
  assert.ok(result.error && result.error.includes('ECONNREFUSED'));
});

test('transportFor: a2a+endpoint → Http；local → Local', () => {
  const runner = makeRunner();
  const remote = { ...makeDefaultAgentCard(), id: 'agentB', transport: 'a2a', endpoint: 'https://b/' };
  const local = { ...makeDefaultAgentCard(), id: 'agentC', transport: 'local' };
  assert.ok(transportFor(remote, runner) instanceof HttpA2ATransport);
  assert.ok(transportFor(local, runner) instanceof LocalA2ATransport);
});

test('dispatchAgentTask: 按 card 选择传输并派发（remote 走 Http）', async () => {
  let hitUrl = null;
  const fakeFetch = async (url) => { hitUrl = url; return { ok: true, status: 200, json: async () => ({ result: { taskId: 't6', status: 'success', output: 'remote-ok' } }) }; };
  const runner = makeRunner();
  const remote = { ...makeDefaultAgentCard(), id: 'agentB', transport: 'a2a', endpoint: 'https://b/' };
  const result = await dispatchAgentTask(remote, { taskId: 't6', tenantId: 't', fromAgent: 'a', toAgent: 'agentB', input: 'x' }, runner, fakeFetch);
  assert.strictEqual(result.status, 'success');
  assert.strictEqual(result.output, 'remote-ok');
  assert.ok(hitUrl && hitUrl.endsWith('/api/a2a/tasks'));
});

// ── P0 SSRF 防护：A2A 出网私网判定（callback 与 HttpA2ATransport.baseUrl） ──
// 覆盖：私网 IP / localhost / 非法协议 拦截；opts 与 env 两级逃生舱；公网放行。

test('SSRF: HttpA2ATransport 拒绝私网 IP baseUrl（fetch 不发起）', async () => {
  let called = 0;
  const fakeFetch = async () => { called++; throw new Error('should not reach'); };
  const transport = new HttpA2ATransport('http://10.0.0.5:4173', fakeFetch);
  const result = await transport.send({ taskId: 's1', tenantId: 't', fromAgent: 'a', toAgent: 'b', input: 'x' });
  assert.strictEqual(result.status, 'failed');
  assert.ok(result.error && result.error.includes('private network'), `error=${result.error}`);
  assert.strictEqual(called, 0);
});

test('SSRF: HttpA2ATransport 拒绝 localhost baseUrl（含云元数据段）', async () => {
  let called = 0;
  const fakeFetch = async () => { called++; return { ok: true }; };
  const t1 = new HttpA2ATransport('http://127.0.0.1:4173', fakeFetch);
  const r1 = await t1.send({ taskId: 's2', tenantId: 't', fromAgent: 'a', toAgent: 'b', input: 'x' });
  assert.strictEqual(r1.status, 'failed');
  assert.ok(r1.error && r1.error.includes('private network'));
  const t2 = new HttpA2ATransport('http://169.254.169.254/latest/meta-data', fakeFetch);
  const r2 = await t2.send({ taskId: 's3', tenantId: 't', fromAgent: 'a', toAgent: 'b', input: 'x' });
  assert.strictEqual(r2.status, 'failed');
  assert.ok(r2.error && r2.error.includes('private network'));
  assert.strictEqual(called, 0);
});

test('SSRF: HttpA2ATransport 拒绝非 http(s) 协议', async () => {
  let called = 0;
  const fakeFetch = async () => { called++; return { ok: true }; };
  const transport = new HttpA2ATransport('file:///etc/passwd', fakeFetch);
  const result = await transport.send({ taskId: 's4', tenantId: 't', fromAgent: 'a', toAgent: 'b', input: 'x' });
  assert.strictEqual(result.status, 'failed');
  assert.ok(result.error && result.error.includes('scheme not allowed'));
  assert.strictEqual(called, 0);
});

test('SSRF: opts.allowPrivate=true 显式放行私网（内部 mesh）', async () => {
  const fakeFetch = async () => ({ ok: true, status: 200, json: async () => ({ result: { taskId: 's5', status: 'success', output: 'mesh-ok' } }) });
  const transport = new HttpA2ATransport('http://127.0.0.1:4173', fakeFetch, { allowPrivate: true });
  const result = await transport.send({ taskId: 's5', tenantId: 't', fromAgent: 'a', toAgent: 'b', input: 'x' });
  assert.strictEqual(result.status, 'success');
  assert.strictEqual(result.output, 'mesh-ok');
});

test('SSRF: env A2A_ALLOW_PRIVATE_NETWORK=true 逃生舱（用后还原）', async () => {
  const prev = process.env.A2A_ALLOW_PRIVATE_NETWORK;
  process.env.A2A_ALLOW_PRIVATE_NETWORK = 'true';
  try {
    const fakeFetch = async () => ({ ok: true, status: 200, json: async () => ({ result: { taskId: 's6', status: 'success', output: 1 } }) });
    const transport = new HttpA2ATransport('http://192.168.1.10:4173', fakeFetch);
    const result = await transport.send({ taskId: 's6', tenantId: 't', fromAgent: 'a', toAgent: 'b', input: 'x' });
    assert.strictEqual(result.status, 'success');
  } finally {
    if (prev === undefined) delete process.env.A2A_ALLOW_PRIVATE_NETWORK;
    else process.env.A2A_ALLOW_PRIVATE_NETWORK = prev;
  }
});

test('SSRF: deliverA2ACallback 拦截私网 callback（fetch 不发起，返回 false）', async () => {
  let called = 0;
  const fakeFetch = async () => { called++; return { ok: true }; };
  const envelope = { taskId: 's7', tenantId: 't', fromAgent: 'a', toAgent: 'b', input: 'x', callback: 'http://169.254.169.254/latest/meta-data' };
  const ok = await deliverA2ACallback(envelope, { taskId: 's7', status: 'success', output: 'secret' }, fakeFetch);
  assert.strictEqual(ok, false);
  assert.strictEqual(called, 0);
});

test('SSRF: deliverA2ACallback 拦截非法 URL 与非 http 协议', async () => {
  let called = 0;
  const fakeFetch = async () => { called++; return { ok: true }; };
  const bad1 = { taskId: 's8', tenantId: 't', fromAgent: 'a', toAgent: 'b', input: 1, callback: '::not a url::' };
  assert.strictEqual(await deliverA2ACallback(bad1, { taskId: 's8', status: 'success' }, fakeFetch), false);
  const bad2 = { taskId: 's9', tenantId: 't', fromAgent: 'a', toAgent: 'b', input: 1, callback: 'ftp://evil/x' };
  assert.strictEqual(await deliverA2ACallback(bad2, { taskId: 's9', status: 'success' }, fakeFetch), false);
  assert.strictEqual(called, 0);
});

test('SSRF: deliverA2ACallback 放行公网 callback', async () => {
  const fakeFetch = async () => ({ ok: true, status: 200 });
  const envelope = { taskId: 's10', tenantId: 't', fromAgent: 'a', toAgent: 'b', input: 'x', callback: 'https://dispatcher.example.com/cb' };
  const ok = await deliverA2ACallback(envelope, { taskId: 's10', status: 'success', output: 1 }, fakeFetch);
  assert.strictEqual(ok, true);
});

test('SSRF: LocalA2ATransport 的 callback 投递同样过防护（默认拒私网）', async () => {
  let called = 0;
  const fakeFetch = async () => { called++; return { ok: true }; };
  // LocalA2ATransport 内部用全局 fetch 投递 callback；这里 monkey-patch 全局 fetch 以断言「未发起」。
  const prevFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  try {
    const transport = new LocalA2ATransport(makeRunner());
    const env = { taskId: 's11', tenantId: 't', fromAgent: 'a', toAgent: DEFAULT_AGENT_ID, input: 'x', callback: 'http://127.0.0.1:9/cb' };
    const result = await transport.send(env);
    assert.strictEqual(result.status, 'success');
    // fire-and-forget：等一拍让 promise 链走完
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(called, 0, 'private callback must not be fetched');
  } finally {
    globalThis.fetch = prevFetch;
  }
});

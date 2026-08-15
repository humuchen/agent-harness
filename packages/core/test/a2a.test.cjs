// 零依赖测试（node:test + node:assert）：覆盖 P1-④ A2A 统一通信协议。
// - LocalA2ATransport：进程内 handoff（runner 回调），成功/失败映射为 TaskResult
// - HttpA2ATransport：跨主机投递到 /api/a2a/tasks，成功/HTTP 错误/网络异常三种形态
// - transportFor / dispatchAgentTask：按 AgentCard.transport+endpoint 选择传输

const test = require('node:test');
const assert = require('node:assert');

const a2a = require('../dist/a2a/index.js');
const { LocalA2ATransport, HttpA2ATransport, transportFor, dispatchAgentTask } = a2a;
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

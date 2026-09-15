// 生成层测试（P2：检索 + LLM 生成一体化）。
// 覆盖：generateAnswer 检索融入上下文、引用标注、LLM 失败 fail-closed、
//       /v1/generate HTTP 端点、MCP rag_generate 工具。
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const http = require('node:http');
const path = require('node:path');

const { MemoryVectorStore } = require('../dist/store');
const { HashEmbedding } = require('../dist/embed');
const { ingestDocument } = require('../dist/ingest');
const { generateAnswer, OpenAIProvider } = require('../dist/generate');
const { createRagServer } = require('../dist/server');

const RAG_BIN = path.resolve(__dirname, '../dist/index.js');

/** 起一个本地 stub LLM：把 system+user 消息拼接返回（模拟生成）。 */
function startStubLLM() {
  const stub = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let messages = [];
      try {
        messages = JSON.parse(body).messages || [];
      } catch {
        /* ignore */
      }
      // 模拟生成：提取 user 消息中的问题 + 引用标注
      const userMsg = messages.find((m) => m.role === 'user');
      const content = userMsg?.content ?? '';
      const questionMatch = /用户问题：(.+?)\n/.exec(content);
      const question = questionMatch?.[1] ?? '未知问题';
      const hasContext = content.includes('【知识库片段】') && !content.includes('（知识库中没有检索到相关内容）');
      let answer;
      if (hasContext) {
        answer = `根据知识库，${question}的答案是：支持七天无理由退款。[1]\n\n来源：\n[1] 退款政策：支持七天无理由退款，退款原路返回支付账户。`;
      } else {
        answer = '我不清楚，知识库中没有相关权威来源。';
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: answer } }] }));
    });
  });
  return new Promise((resolve) => {
    stub.listen(0, () => resolve(stub));
  });
}

async function listen(srv) {
  await srv.listen();
  return `http://127.0.0.1:${srv.server.address().port}`;
}

test('generateAnswer: 检索融入上下文 + 引用标注', async () => {
  const dim = 256;
  const store = new MemoryVectorStore(dim);
  const provider = new HashEmbedding(dim);
  await ingestDocument(store, provider, {
    doc_id: 'kb1',
    tenant_id: 'acme',
    title: '退款政策',
    text: '支持七天无理由退款，退款原路返回支付账户，通常三个工作日内到账。',
  });

  // Mock LLM provider
  const mockLLM = {
    async chat(messages) {
      const userMsg = messages.find((m) => m.role === 'user');
      assert.ok(userMsg.content.includes('【知识库片段】'), '应注入检索上下文');
      assert.ok(userMsg.content.includes('[1]'), '应标注引用 [1]');
      assert.ok(userMsg.content.includes('退款政策'), '应包含检索到的文档标题');
      assert.ok(userMsg.content.includes('用户问题：'), '应包含用户问题');
      return '根据知识库，答案是：支持七天无理由退款。[1]\n\n来源：\n[1] 退款政策：支持七天无理由退款。';
    },
  };

  const result = await generateAnswer(store, provider, mockLLM, {
    query: '退款政策是怎样的？',
    tenant_id: 'acme',
    top_k: 3,
  });

  assert.ok(result.answer.includes('[1]'), '回答应包含引用标注');
  assert.equal(result.retrieved, 1, '应检索到 1 条');
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].doc_id, 'kb1');
  assert.ok(result.latency_ms >= 0);
});

test('generateAnswer: 检索为空时 fail-closed（不伪造）', async () => {
  const dim = 256;
  const store = new MemoryVectorStore(dim);
  const provider = new HashEmbedding(dim);
  // 不入库，直接检索

  const mockLLM = {
    async chat(messages) {
      const userMsg = messages.find((m) => m.role === 'user');
      assert.ok(userMsg.content.includes('（知识库中没有检索到相关内容）'), '应告知无相关内容');
      return '我不清楚，知识库中没有相关权威来源。';
    },
  };

  const result = await generateAnswer(store, provider, mockLLM, {
    query: '完全不相关的火箭发射问题',
    tenant_id: 'acme',
    top_k: 3,
  });

  assert.equal(result.retrieved, 0, '应检索到 0 条');
  assert.equal(result.answer, '我不清楚，知识库中没有相关权威来源。');
});

test('generateAnswer: LLM 失败时 fail-closed（返回检索结果）', async () => {
  const dim = 256;
  const store = new MemoryVectorStore(dim);
  const provider = new HashEmbedding(dim);
  await ingestDocument(store, provider, {
    doc_id: 'kb1',
    tenant_id: 'acme',
    title: '退款政策',
    text: '支持七天无理由退款。',
  });

  const failingLLM = {
    async chat() {
      throw new Error('LLM service unavailable');
    },
  };

  const result = await generateAnswer(store, provider, failingLLM, {
    query: '退款政策',
    tenant_id: 'acme',
  });

  assert.ok(result.answer.includes('生成服务暂时不可用'), '应告知服务不可用');
  assert.ok(result.answer.includes('支持七天无理由退款'), '应附带检索到的参考');
  assert.equal(result.retrieved, 1);
});

test('HTTP /v1/generate: 未配置 LLM 返回 503', async () => {
  const srv = createRagServer({
    port: 0,
    store: new MemoryVectorStore(256),
    provider: new HashEmbedding(256),
    defaultTenant: 'acme',
  });
  const baseUrl = await listen(srv);

  try {
    const r = await fetch(`${baseUrl}/v1/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: '退款政策' }),
    });
    assert.equal(r.status, 503, '未配置 LLM 应返回 503');
    const j = await r.json();
    assert.ok(j.error.includes('LLM provider 未配置'));
  } finally {
    await srv.close();
  }
});

test('HTTP /v1/generate: 真实 LLM 生成（stub）', async () => {
  const stub = await startStubLLM();
  const llmUrl = `http://127.0.0.1:${stub.address}`;
  process.env.RAG_LLM_BASE_URL = llmUrl;
  process.env.RAG_LLM_API_KEY = 'test-key';
  process.env.RAG_LLM_MODEL = 'stub-model';
  process.env.RAG_ASYNC_INGEST = 'false';

  const srv = createRagServer({
    port: 0,
    store: new MemoryVectorStore(256),
    provider: new HashEmbedding(256),
    defaultTenant: 'acme',
  });
  const baseUrl = await listen(srv);

  try {
    // 先入库
    await fetch(`${baseUrl}/v1/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ doc_id: 'kb1', title: '退款政策', text: '支持七天无理由退款，退款原路返回支付账户。' }),
    });

    const r = await fetch(`${baseUrl}/v1/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: '退款政策是怎样的？', top_k: 3 }),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.ok(j.answer.includes('[1]'), '回答应包含引用');
    assert.equal(j.retrieved, 1);
    assert.equal(j.sources.length, 1);
    assert.ok(j.trace_id.startsWith('rag_'));
  } finally {
    await srv.close();
    stub.close();
    delete process.env.RAG_LLM_BASE_URL;
    delete process.env.RAG_LLM_API_KEY;
    delete process.env.RAG_LLM_MODEL;
    delete process.env.RAG_ASYNC_INGEST;
  }
});

test('MCP: rag_generate 端到端（stub LLM）', async () => {
  const stub = await startStubLLM();
  const llmUrl = `http://127.0.0.1:${stub.address}`;

  const proc = spawn('node', [RAG_BIN], {
    env: {
      ...process.env,
      RAG_TRANSPORT: 'mcp',
      RAG_TENANT_ID: 'acme',
      RAG_ASYNC_INGEST: 'false',
      RAG_LLM_BASE_URL: llmUrl,
      RAG_LLM_API_KEY: 'test-key',
      RAG_LLM_MODEL: 'stub-model',
    },
    stdio: ['pipe', 'pipe', 'inherit'],
  });

  const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
  const pending = new Map();
  rl.on('line', (line) => {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (m.id !== undefined && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      p(m);
    }
  });
  function call(method, params, id) {
    return new Promise((resolve) => {
      pending.set(id, resolve);
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  try {
    // initialize
    await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e', version: '1.0.0' } }, 1);

    // tools/list 应包含 rag_generate
    const list = await call('tools/list', {}, 2);
    assert.ok(list.result.tools.some((t) => t.name === 'rag_generate'), '应暴露 rag_generate');

    // 先入库
    await call('tools/call', { name: 'rag_ingest', arguments: { doc_id: 'kb1', title: '退款政策', text: '支持七天无理由退款，退款原路返回。' } }, 3);

    // rag_generate
    const gen = await call('tools/call', { name: 'rag_generate', arguments: { query: '退款政策', top_k: 3 } }, 4);
    const parsed = JSON.parse(gen.result.content[0].text);
    assert.ok(parsed.answer.includes('[1]'), '回答应包含引用');
    assert.equal(parsed.retrieved, 1);
    assert.ok(parsed.trace_id.startsWith('rag_'));
  } finally {
    proc.kill();
    stub.close();
  }
});

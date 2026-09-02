// MCP 端到端：手写最小 MCP client（标准 JSON-RPC over stdio）连接 RAG server，
// 验证 agent 经 rag__rag_retrieve / rag__rag_ingest 取数的完整闭环（对应设计文档 P1）。
// 不依赖任何 MCP SDK，纯协议级验证。
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const path = require('node:path');

const RAG_BIN = path.resolve(__dirname, '../dist/index.js');

test('MCP: rag_ingest + rag_retrieve 端到端', async () => {
  const proc = spawn('node', [RAG_BIN], {
    env: { ...process.env, RAG_TRANSPORT: 'mcp', RAG_TENANT_ID: 'acme' },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
  const pending = new Map();
  rl.on('line', (line) => {
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
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

  const init = await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e', version: '1.0.0' } }, 1);
  assert.ok(init.result.capabilities.tools, '应声明 tools 能力');

  const list = await call('tools/list', {}, 2);
  assert.ok(list.result.tools.some((t) => t.name === 'rag_retrieve'), '应暴露 rag_retrieve');
  assert.ok(list.result.tools.some((t) => t.name === 'rag_ingest'), '应暴露 rag_ingest');

  const ing = await call('tools/call', { name: 'rag_ingest', arguments: { doc_id: 'kb1', title: '退款政策', text: '支持七天无理由退款，退款原路返回支付账户。', tags: ['policy'] } }, 3);
  assert.ok(ing.result.content[0].text.includes('chunks'), '入库应返回 chunk 数');

  const ret = await call('tools/call', { name: 'rag_retrieve', arguments: { query: '退款政策', top_k: 3 } }, 4);
  const parsed = JSON.parse(ret.result.content[0].text);
  assert.ok(parsed.results.length >= 1, '检索应召回片段');
  assert.equal(parsed.results[0].doc_id, 'kb1');
  assert.ok(parsed.trace_id.startsWith('rag_'));

  proc.kill();
});

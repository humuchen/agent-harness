'use strict';
/**
 * P2.5（每 step 调用链路）server e2e：真实构建产物 dist/server.js 子进程，覆盖
 * step 执行期间的 harness 事件经 StepTraceCollector 采集、引擎合并进 StepRun.trace
 * 并随检查点持久化的完整链路（「执行详情」抽屉的数据源）：
 * - mock 模式 2 task 计划跑完 → GET 快照：每个 step 的 trace 非空，
 *   含 run:start（任务开始）与 run:end（任务结束）首尾节点；
 * - trace 节点不落任何凭据字段（BYOK 红线：无 modelBaseUrl / apiKey 字样）；
 * - 节点数有界（≤ STEP_TRACE_MAX_NODES=500，mock 场景远小于）。
 *
 * 运行前需 pnpm --filter @agent-harness/server run build（mock 模式离线可跑）。
 */
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const { join } = require('node:path');
const http = require('node:http');

const SERVER_JS = join(__dirname, '..', 'dist', 'server.js');
const RUN = existsSync(SERVER_JS);
const TOKEN = 'p25-trace-test-token';
const TOKENS_JSON = JSON.stringify({ [TOKEN]: 'admin' });

function freshPort() {
  return 42500 + Math.floor(Math.random() * 3000);
}

function startServer() {
  const port = freshPort();
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      PORT: String(port),
      UI_HOST: '127.0.0.1',
      UI_TOKENS: TOKENS_JSON,
      MAX_BODY_BYTES: '65536',
      RATE_LIMIT: '0',
      MCP_SERVER_URL: '',
      MCP_SERVERS: '',
      OPEN_API_KEY: '',
      HARNESS_API_KEY: '',
      WORKFLOW_STORE_DIR: ''
    };
    const child = spawn(process.execPath, [SERVER_JS], {
      env,
      cwd: join(__dirname, '..')
    });
    let buf = '';
    let resolved = false;
    child.stdout.on('data', (d) => {
      buf += d.toString();
      if (!resolved && buf.includes('已启动')) {
        resolved = true;
        resolve({ child, port });
      }
    });
    child.on('error', (e) => {
      if (!resolved) reject(e);
    });
    child.on('exit', () => {
      if (!resolved) reject(new Error('server exited before startup'));
    });
    setTimeout(() => {
      if (!resolved) reject(new Error('server startup timeout'));
    }, 15000);
  });
}

function request(method, path, port, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body != null ? JSON.stringify(body) : null;
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: { ...headers, ...(payload != null ? { 'content-type': 'application/json' } : {}) }
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf-8')
          })
        );
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    if (payload != null) req.write(payload);
    req.end();
  });
}

const auth = () => ({ authorization: `Bearer ${TOKEN}` });

test('P2.5 e2e：step 检查点快照携带调用链路（trace）', { skip: !RUN }, async () => {
  const { child, port } = await startServer();
  const req = (m, p, o) => request(m, p, port, o);
  try {
    const wfId = 'p25-trace-wf-1';
    const plan = {
      goal: '发布前检查（链路采集验证）',
      tasks: [
        { id: 't1', title: '写核心逻辑', steps: ['实现 A'], dependsOn: [], expectedOutput: '核心模块' },
        { id: 't2', title: '写测试', steps: ['单测'], dependsOn: ['t1'], expectedOutput: '全绿测试' }
      ]
    };

    // 首跑（mock）→ SSE 跑完至 wf:done。
    let r = await req('POST', '/api/workflows', {
      headers: auth(),
      body: { plan, workflowId: wfId, mode: 'mock' }
    });
    assert.equal(r.status, 200, '首跑应 200 SSE');
    assert.ok(r.body.includes('wf:done'), 'SSE 应正常跑完至 wf:done');

    // 快照：两个 step 都应有非空 trace，且首尾是 run:start / run:end。
    r = await req('GET', `/api/workflows/${wfId}`, { headers: auth() });
    assert.equal(r.status, 200);
    const snap = JSON.parse(r.body).workflow;
    assert.equal(snap.state, 'done');
    for (const id of ['t1', 't2']) {
      const trace = snap.steps[id]?.trace;
      assert.ok(Array.isArray(trace) && trace.length >= 2, `step ${id} 的 trace 应非空（实际 ${trace?.length} 节点）`);
      const types = trace.map((n) => n.type);
      assert.ok(types.includes('run:start'), `step ${id} trace 应含 run:start（实际 ${types.join(',')}）`);
      assert.ok(types.includes('run:end'), `step ${id} trace 应含 run:end`);
      // 每个节点必须有时间戳（回放相对时间轴依赖它）。
      for (const n of trace) assert.ok(typeof n.ts === 'number', 'trace 节点缺 ts');
      // 节点数有界（引擎合并侧上限 500，mock 场景远小于）。
      assert.ok(trace.length <= 500, 'trace 超上限（引擎应截断）');
      // BYOK 红线：快照里不得出现凭据类字段。
      const dumped = JSON.stringify(snap);
      assert.ok(!dumped.includes('apiKeys'), '快照不得携带 apiKeys');
      assert.ok(!dumped.includes('modelBaseUrl'), '快照不得携带 modelBaseUrl');
    }
  } finally {
    child.kill();
  }
});

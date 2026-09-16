'use strict';
/**
 * P3（人工审批门）server e2e：真实构建产物 dist/server.js 子进程，覆盖
 * POST /api/workflows/:id/approve 完整链路：
 * - plan 携带 requireApproval 任务 → 首跑 SSE 下发 wf:awaiting-approval + _wf_done(state=awaiting)
 * - GET /api/workflows/:id 快照 state=awaiting
 * - POST /:id/approve {all:true} → 放行续跑 → wf:done + _wf_done(state=done)
 * - 404（无检查点）/ 400（缺 stepId 与 all）/ 400（终态工作流不可审批）
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
const TOKEN = 'p3-approve-test-token';
const TOKENS_JSON = JSON.stringify({ [TOKEN]: 'admin' });

function freshPort() {
  return 42000 + Math.floor(Math.random() * 3000);
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
      // P3 测试确定性：不接文件检查点目录（Volatile 即可），避免跨用例污染。
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

/** 阻塞式请求：等待响应流结束（SSE 场景即服务端 res.end() 后）。 */
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

test('P3 approve e2e：审批门暂停 → 放行 → 完成', { skip: !RUN }, async () => {
  const { child, port } = await startServer();
  const req = (m, p, o) => request(m, p, port, o);
  try {
    const wfId = 'p3-approve-wf-1';
    const plan = {
      goal: '发布前检查',
      tasks: [
        { id: 't1', title: '前置检查', steps: ['lint'], dependsOn: [], expectedOutput: 'lint 通过' },
        {
          id: 't2',
          title: '高风险发布',
          steps: ['publish'],
          dependsOn: ['t1'],
          expectedOutput: '已发布',
          requireApproval: true
        }
      ]
    };

    // 1) 首跑：SSE 应含审批门暂停事件，且 run 收敛为 awaiting（不是 failed）。
    let r = await req('POST', '/api/workflows', {
      headers: auth(),
      body: { plan, workflowId: wfId, mode: 'mock' }
    });
    assert.equal(r.status, 200, '首跑应 200 SSE');
    assert.match(r.headers['content-type'] || '', /text\/event-stream/);
    assert.ok(r.body.includes('wf:awaiting-approval'), 'SSE 应下发 wf:awaiting-approval');
    assert.ok(r.body.includes('t2'), '事件应携带待批 task id');

    // 2) 快照：state=awaiting + t1 已完成 + approvals 未含 t2。
    r = await req('GET', `/api/workflows/${wfId}`, { headers: auth() });
    assert.equal(r.status, 200);
    let snap = JSON.parse(r.body).workflow;
    assert.equal(snap.state, 'awaiting');
    assert.equal(snap.steps.t1.state, 'done');
    assert.equal(snap.steps.t2.state, 'awaiting');
    assert.ok(!(snap.approvals ?? []).includes('t2'), '未批准时 approvals 不应含 t2');

    // 3) 缺参 400（stepId 与 all 二选一）。
    r = await req('POST', `/api/workflows/${wfId}/approve`, { headers: auth(), body: {} });
    assert.equal(r.status, 400, '缺 stepId/all 应 400');

    // 4) 指定未知 step 400。
    r = await req('POST', `/api/workflows/${wfId}/approve`, {
      headers: auth(),
      body: { stepId: 'nope' }
    });
    assert.equal(r.status, 400, '未知 stepId 应 400');

    // 5) 放行全部未决门 → 续跑至 done。
    r = await req('POST', `/api/workflows/${wfId}/approve`, {
      headers: auth(),
      body: { all: true, mode: 'mock' }
    });
    assert.equal(r.status, 200, 'approve 应 200 SSE');
    assert.ok(r.body.includes('wf:done'), '放行后 SSE 应含 wf:done');

    // 6) 终态：t2 done + approvals 含 t2 + 再 approve 应 400。
    r = await req('GET', `/api/workflows/${wfId}`, { headers: auth() });
    snap = JSON.parse(r.body).workflow;
    assert.equal(snap.state, 'done');
    assert.equal(snap.steps.t2.state, 'done');
    assert.ok(snap.approvals.includes('t2'), 'approvals 应持久化 t2');
    r = await req('POST', `/api/workflows/${wfId}/approve`, { headers: auth(), body: { all: true } });
    assert.equal(r.status, 400, '终态工作流不可审批，应 400');

    // 7) 无检查点 404。
    r = await req('POST', '/api/workflows/p3-approve-nope/approve', {
      headers: auth(),
      body: { all: true }
    });
    assert.equal(r.status, 404, '无检查点应 404');

    // 8) 无令牌 401。
    r = await req('POST', `/api/workflows/${wfId}/approve`, { body: { all: true } });
    assert.equal(r.status, 401, '无令牌应 401');
  } finally {
    child.kill();
  }
});

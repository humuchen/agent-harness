'use strict';
// UI server 集成测试：启动真实构建产物 dist/server.js 子进程，验证
// 鉴权(P0-3)、请求体上限(413)、审计(P0-4)、/api/metrics(P1-6)、SSE /api/run 等端点。
// 仅依赖 node 内置模块；测试 runner 不直接 require server（避免拉入 MCP SDK）。
// 运行前需 `pnpm --filter @agent-harness/server run build` 产 dist。
//
// 用单个测试串行执行 setup → 断言 → teardown，避免 node:test 默认并发导致的时序问题。

const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const { join } = require('node:path');
const http = require('node:http');

const SERVER_JS = join(__dirname, '..', 'dist', 'server.js');
const TOKEN = 'test-token-xyz';
const PORT = 40000 + Math.floor(Math.random() * 5000);
const RUN = existsSync(SERVER_JS);
// 前端产物是可选前置：server 单测不应因 webapp 未构建而失败（CI 里 build 会产出，本地常常没有）。
const WEBAPP_BUILT = existsSync(join(__dirname, '..', '..', '..', 'frontend', 'webapp', 'dist', 'index.html'));

function startServer() {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      PORT: String(PORT),
      UI_HOST: '127.0.0.1',
      UI_AUTH_TOKEN: TOKEN,
      // 收紧体上限以便测试 413；关闭限流避免误伤；不接 MCP / 真实 LLM。
      MAX_BODY_BYTES: '1024',
      RATE_LIMIT: '0',
      MCP_SERVER_URL: '',
      MCP_SERVERS: '',
      OPENROUTER_API_KEY: '',
      HARNESS_API_KEY: '',
    };
    const child = spawn(process.execPath, [SERVER_JS], { env, cwd: join(__dirname, '..') });
    let buf = '';
    let resolved = false;
    child.stdout.on('data', (d) => {
      buf += d.toString();
      if (!resolved && buf.includes('已启动')) {
        resolved = true;
        resolve(child);
      }
    });
    child.stderr.on('data', (d) => process.stderr.write('[server stderr] ' + d.toString()));
    child.on('error', reject);
    child.on('exit', (code) => {
      if (!resolved) reject(new Error('server exited before ready, code=' + code));
    });
    setTimeout(() => {
      if (!resolved) reject(new Error('server startup timeout (8s)'));
    }, 8000);
  });
}

function request(method, path, { headers = {}, body, rawBody } = {}) {
  return new Promise((resolve, reject) => {
    const payload = rawBody != null ? rawBody : (body != null ? JSON.stringify(body) : null);
    const req = http.request(
      { host: '127.0.0.1', port: PORT, method, path, headers: { ...headers } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf-8'),
        }));
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    if (payload != null) {
      req.setHeader('content-type', 'application/json');
      req.setHeader('content-length', Buffer.byteLength(payload));
      req.write(payload);
    }
    req.end();
  });
}

const auth = () => ({ authorization: 'Bearer ' + TOKEN });

test('UI server 集成：鉴权 / 体上限 / metrics / SSE', { skip: !RUN }, async () => {
  let child = null;
  try {
    child = await startServer();

    // 1) /api/state 始终开放（供 Render 等健康检查）。
    let r = await request('GET', '/api/state');
    assert.equal(r.status, 200, 'GET /api/state 应 200');

    // 2) / 托管 webapp 首页。本用例不隐式依赖前端构建产物：
    //    webapp 已构建 → 必须 200 + text/html；未构建 → 必须是可读的 500 兜底提示。
    r = await request('GET', '/');
    if (WEBAPP_BUILT) {
      assert.equal(r.status, 200, 'GET / 应 200（webapp 已构建）');
      assert.match(r.headers['content-type'] || '', /text\/html/, '首页 content-type 应为 text/html');
    } else {
      assert.equal(r.status, 500, 'GET / 在 webapp 未构建时应 500 兜底');
      assert.match(r.body || '', /webapp/i, '兜底响应应提示先构建 webapp');
    }

    // 3) 受保护端点无令牌 → 401。
    r = await request('GET', '/api/metrics');
    assert.equal(r.status, 401, '无令牌 /api/metrics 应 401');

    // 4) 错误令牌 → 401。
    r = await request('GET', '/api/metrics', { headers: { authorization: 'Bearer wrong' } });
    assert.equal(r.status, 401, '错误令牌应 401');

    // 5) /api/metrics 带正确令牌 → 200，含 cost/costByModel/tokens（P1-6）。
    r = await request('GET', '/api/metrics', { headers: auth() });
    assert.equal(r.status, 200, '带令牌 /api/metrics 应 200');
    const metrics = JSON.parse(r.body);
    assert.ok(typeof metrics.cost === 'number', 'metrics.cost 应为 number');
    assert.ok(metrics.costByModel && typeof metrics.costByModel === 'object', 'metrics.costByModel 应为对象');
    assert.ok(metrics.tokens && typeof metrics.tokens.total === 'number', 'metrics.tokens.total 应为 number');

    // 6) /api/mcp/list 带令牌 → 200。
    r = await request('GET', '/api/mcp/list', { headers: auth() });
    assert.equal(r.status, 200, '/api/mcp/list 应 200');
    assert.ok(Array.isArray(JSON.parse(r.body).servers), 'servers 应为数组');

    // 7) POST /api/run 无令牌 → 401。
    r = await request('POST', '/api/run', { body: { mode: 'mock', prompt: 'hi' } });
    assert.equal(r.status, 401, '无令牌 /api/run 应 401');

    // 8) POST /api/run 带令牌(mock) → 200 SSE；事件流含 job:accepted 与终结节点 _done。
    r = await request('POST', '/api/run', { headers: auth(), body: { mode: 'mock', prompt: '帮我在 feature/x 分支拉起临时环境' } });
    assert.equal(r.status, 200, '/api/run mock 应 200');
    assert.match(r.headers['content-type'] || '', /text\/event-stream/, '/api/run 应返回 SSE');
    assert.ok(r.body.includes('job:accepted'), 'SSE 应首先下发 job:accepted（运行队列提交模式）');
    assert.ok(r.body.includes('_done'), 'SSE 应以 _done 终结节点的（验证队列执行 + 事件重放闭环）');

    // 9) 请求体超限 → 413（MAX_BODY_BYTES=1024）。
    const big = { mode: 'mock', prompt: 'p'.repeat(2000) };
    r = await request('POST', '/api/run', { headers: auth(), body: big });
    assert.equal(r.status, 413, '超限 body 应 413');

    // 10) 未知路径 → 404。
    r = await request('GET', '/api/does-not-exist');
    assert.equal(r.status, 404, '未知路径应 404');

    // 11) /api/jobs 带令牌 → 200，返回运行队列快照（并发配置 + jobs 数组，验证有界化/统计）。
    r = await request('GET', '/api/jobs', { headers: auth() });
    assert.equal(r.status, 200, '/api/jobs 应 200');
    const jobsView = JSON.parse(r.body);
    assert.ok(Array.isArray(jobsView.jobs), 'jobs.jobs 应为数组');
    assert.ok(typeof jobsView.queue.concurrency === 'number', 'jobs.queue 应含并发上限');
    assert.ok(typeof jobsView.queue.sessionsRunning === 'number', 'jobs.queue 应含在飞会话数');
  } finally {
    if (child) {
      try { child.kill('SIGTERM'); } catch {}
    }
  }
});

// dist 未构建时给出明确失败提示，而非静默跳过整个套件。
test('dist 未构建时显式提示', { skip: RUN }, () => {
  assert.fail('access/server/dist/server.js 不存在：请先 `pnpm --filter @agent-harness/server run build` 再跑本测试');
});

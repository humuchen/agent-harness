'use strict';
// UI server 集成测试：启动真实构建产物 dist/server.js 子进程，验证
// 鉴权(P0-3)、请求体上限(413)、审计(P0-4)、/api/metrics(P1-6)、SSE /api/run 等端点。
// 仅依赖 node 内置模块；测试 runner 不直接 require server（避免拉入 MCP SDK）。
// 运行前需 `pnpm --filter @agent-harness/server run build` 产 dist。
//
// 并发安全：node:test 默认并发执行顶层 test()。因此每个测试独立持有自己的 server
// 子进程与端口，request 必须显式携带「本测试」的 port，绝不读写模块级共享端口——
// 否则一个测试的请求可能命中另一个测试的服务端（交叉串话），表现为偶发 413/401/404。

const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const { join } = require('node:path');
const http = require('node:http');

const SERVER_JS = join(__dirname, '..', 'dist', 'server.js');
const TOKEN = 'test-token-xyz';
const TOKENS_JSON = JSON.stringify({ [TOKEN]: 'admin' });
const RUN = existsSync(SERVER_JS);
// 每次启动服务端都用全新随机端口，避免上一次测试的端口尚未释放（TIME_WAIT / SIGTERM
// 延迟）导致后续测试 EADDRINUSE 崩溃。范围避开常用端口。
function freshPort() {
  return 40000 + Math.floor(Math.random() * 5000);
}
// 前端产物是可选前置：server 单测不应因 webapp 未构建而失败（CI 里 build 会产出，本地常常没有）。
const WEBAPP_BUILT = existsSync(
  join(__dirname, '..', '..', '..', 'frontend', 'webapp', 'dist', 'index.html')
);

// 启动一个专属 server 子进程，返回 { child, port }。
function startServer() {
  const port = freshPort();
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      PORT: String(port),
      UI_HOST: '127.0.0.1',
      UI_TOKENS: TOKENS_JSON,
      // 收紧体上限以便测试 413；关闭限流避免误伤；不接 MCP / 真实 LLM。
      MAX_BODY_BYTES: '1024',
      RATE_LIMIT: '0',
      MCP_SERVER_URL: '',
      MCP_SERVERS: '',
      OPEN_API_KEY: '',
      HARNESS_API_KEY: ''
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
    child.stderr.on('data', (d) =>
      process.stderr.write('[server stderr] ' + d.toString())
    );
    child.on('error', reject);
    child.on('exit', (code) => {
      if (!resolved)
        reject(new Error('server exited before ready, code=' + code));
    });
    setTimeout(() => {
      if (!resolved) reject(new Error('server startup timeout (8s)'));
    }, 8000);
  });
}

// 向「指定 port」的 server 发请求。port 必须由调用方显式传入（本测试），
// 不得依赖任何共享全局，避免并发测试交叉串话。
function request(method, path, port, { headers = {}, body, rawBody } = {}) {
  return new Promise((resolve, reject) => {
    const payload =
      rawBody != null ? rawBody : body != null ? JSON.stringify(body) : null;
    const req = http.request(
      { host: '127.0.0.1', port, method, path, headers: { ...headers } },
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
    if (payload != null) {
      req.setHeader('content-type', 'application/json');
      req.setHeader('content-length', Buffer.byteLength(payload));
      req.write(payload);
    }
    req.end();
  });
}

const auth = () => ({ authorization: 'Bearer ' + TOKEN });

// 在单个测试作用域内包一个自动注入 port 的 req 便捷函数，避免逐个手写 port。
function makeReq(port) {
  return (method, path, opts) => request(method, path, port, opts);
}

test(
  'UI server 集成：鉴权 / 体上限 / metrics / SSE',
  { skip: !RUN },
  async () => {
    const { child, port } = await startServer();
    const req = makeReq(port);
    try {
      // 1) /api/state 始终开放（供 Render 等健康检查）。
      let r = await req('GET', '/api/state');
      assert.equal(r.status, 200, 'GET /api/state 应 200');

      // 2) / 托管 webapp 首页。本用例不隐式依赖前端构建产物：
      //    webapp 已构建 → 必须 200 + text/html；未构建 → 必须是可读的 500 兜底提示。
      r = await req('GET', '/');
      if (WEBAPP_BUILT) {
        assert.equal(r.status, 200, 'GET / 应 200（webapp 已构建）');
        assert.match(
          r.headers['content-type'] || '',
          /text\/html/,
          '首页 content-type 应为 text/html'
        );
      } else {
        assert.equal(r.status, 500, 'GET / 在 webapp 未构建时应 500 兜底');
        assert.match(r.body || '', /webapp/i, '兜底响应应提示先构建 webapp');
      }

      // 3) 受保护端点无令牌 → 401。
      r = await req('GET', '/api/metrics');
      assert.equal(r.status, 401, '无令牌 /api/metrics 应 401');

      // 4) 错误令牌 → 401。
      r = await req('GET', '/api/metrics', {
        headers: { authorization: 'Bearer wrong' }
      });
      assert.equal(r.status, 401, '错误令牌应 401');

      // 5) /api/metrics 带正确令牌 → 200，含 cost/costByModel/tokens（P1-6）。
      r = await req('GET', '/api/metrics', { headers: auth() });
      assert.equal(r.status, 200, '带令牌 /api/metrics 应 200');
      const metrics = JSON.parse(r.body);
      assert.ok(typeof metrics.cost === 'number', 'metrics.cost 应为 number');
      assert.ok(
        metrics.costByModel && typeof metrics.costByModel === 'object',
        'metrics.costByModel 应为对象'
      );
      assert.ok(
        metrics.tokens && typeof metrics.tokens.total === 'number',
        'metrics.tokens.total 应为 number'
      );

      // 6) /api/mcp/list 带令牌 → 200。
      r = await req('GET', '/api/mcp/list', { headers: auth() });
      assert.equal(r.status, 200, '/api/mcp/list 应 200');
      assert.ok(Array.isArray(JSON.parse(r.body).servers), 'servers 应为数组');

      // 7) POST /api/run 无令牌 → 401。
      r = await req('POST', '/api/run', {
        body: { mode: 'mock', prompt: 'hi' }
      });
      assert.equal(r.status, 401, '无令牌 /api/run 应 401');

      // 8) POST /api/run 带令牌(mock) → 200 SSE；事件流含 job:accepted 与终结节点 _done。
      r = await req('POST', '/api/run', {
        headers: auth(),
        body: { mode: 'mock', prompt: '帮我在 feature/x 分支拉起临时环境' }
      });
      assert.equal(r.status, 200, '/api/run mock 应 200');
      assert.match(
        r.headers['content-type'] || '',
        /text\/event-stream/,
        '/api/run 应返回 SSE'
      );
      assert.ok(
        r.body.includes('job:accepted'),
        'SSE 应首先下发 job:accepted（运行队列提交模式）'
      );
      assert.ok(
        r.body.includes('_done'),
        'SSE 应以 _done 终结节点的（验证队列执行 + 事件重放闭环）'
      );

      // 9) 请求体超限 → 413（MAX_BODY_BYTES=1024）。
      const big = { mode: 'mock', prompt: 'p'.repeat(2000) };
      r = await req('POST', '/api/run', { headers: auth(), body: big });
      assert.equal(r.status, 413, '超限 body 应 413');

      // 10) 未知路径 → 404。
      r = await req('GET', '/api/does-not-exist');
      assert.equal(r.status, 404, '未知路径应 404');

      // 11) /api/jobs 带令牌 → 200，返回运行队列快照（并发配置 + jobs 数组，验证有界化/统计）。
      r = await req('GET', '/api/jobs', { headers: auth() });
      assert.equal(r.status, 200, '/api/jobs 应 200');
      const jobsView = JSON.parse(r.body);
      assert.ok(Array.isArray(jobsView.jobs), 'jobs.jobs 应为数组');
      assert.ok(
        typeof jobsView.queue.concurrency === 'number',
        'jobs.queue 应含并发上限'
      );
      assert.ok(
        typeof jobsView.queue.sessionsRunning === 'number',
        'jobs.queue 应含在飞会话数'
      );
    } finally {
      try {
        child.kill('SIGTERM');
      } catch {}
    }
  }
);

// 回归：调用链路（trace）中 LLM 节点的「消息上下文」必须包含 assistant 内容。
// 根因：llm:call 发生时 assistant 尚未落盘，导致 trace.messages 仅含用户消息、
// meta 却显示「消息 N」，重新进入历史后点开调用链路看不到 agent 助理内容；
// 修复在 run:end（assistant 已完整）时按消息计数重建每个 LLM 节点的 messages。
// 直接用真实构建产物跑一轮 mock run 并回看持久化会话，断言 LLM 节点 messages 含 assistant。
test(
  '调用链路 LLM 节点的消息上下文包含 assistant（trace rebuild 回归）',
  { skip: !RUN, timeout: 150000 },
  async () => {
    const { child, port } = await startServer();
    const req = makeReq(port);
    try {
      // 1) 创建聊天会话（非 anon 鉴权）。
      let r = await req('POST', '/api/chat/sessions', {
        headers: auth(),
        body: { title: 'trace-regression' }
      });
      assert.equal(r.status, 200, '创建会话应 200');
      const sid = JSON.parse(r.body).id;
      assert.ok(sid, '应返回会话 id');

      // 2) 触发一轮 mock run，绑定到该会话（SSE 直到 _done 关闭连接）。
      r = await req('POST', '/api/run', {
        headers: auth(),
        body: { prompt: '用一句话介绍你自己', chatSessionId: sid }
      });
      assert.equal(r.status, 200, '/api/run 应 200');
      assert.ok(r.body.includes('job:accepted'), 'SSE 应下发 job:accepted');
      assert.ok(r.body.includes('_done'), 'SSE 应以 _done 终结');

      // 3) 回看持久化会话，定位 LLM 调用节点的消息上下文。
      r = await req('GET', `/api/chat/sessions/${sid}`, { headers: auth() });
      assert.equal(r.status, 200, '读取会话应 200');
      const sess = JSON.parse(r.body);

      // 找到携带 trace 的 assistant 消息，遍历其 trace 树。
      const traced = sess.messages.find(
        (m) => m.role === 'assistant' && Array.isArray(m.trace) && m.trace.length
      );
      assert.ok(traced, '应存在携带 trace 的 assistant 消息');

      const roles = [];
      const walk = (n) => {
        if (n.kind === 'llm' && Array.isArray(n.messages)) {
          n.messages.forEach((m) => roles.push(m.role));
        }
        (n.children || []).forEach(walk);
      };
      (traced.trace || []).forEach(walk);

      assert.ok(roles.length > 0, 'LLM 节点的消息上下文不应为空');
      assert.ok(
        roles.includes('assistant'),
        `LLM 节点的消息上下文必须包含 assistant（实际角色：${JSON.stringify(
          roles
        )}）—— 否则重新进入历史后点开调用链路会丢失助理内容`
      );
    } finally {
      try {
        child.kill('SIGTERM');
      } catch {}
    }
  }
);

// 修复：LLM 节点 meta.tools 是「注入模型的可用工具数」，不是本次真实执行数，
// 会导致重新进入历史后「工具 N」chip 与实际工具子节点脱节。已改为不写入 tools，
// 真实执行的工具节点作为 children 挂载，由前端从 n.children.length 计数展示。
test(
  '调用链路 LLM 节点工具计数来自真实执行的子节点（tools meta 回归）',
  { skip: !RUN, timeout: 150000 },
  async () => {
    const { child, port } = await startServer();
    const req = makeReq(port);
    try {
      const r = await req('POST', '/api/chat/sessions', {
        headers: auth(),
        body: { title: 'tool-trace-regression' }
      });
      assert.equal(r.status, 200, '创建会话应 200');
      const sid = JSON.parse(r.body).id;
      assert.ok(sid, '应返回会话 id');

      // mock LLM 在输入命中「创建临时环境」意图时会调用 create/destroy 工具闭环。
      const run = await req('POST', '/api/run', {
        headers: auth(),
        body: { prompt: '创建一个临时环境', chatSessionId: sid }
      });
      assert.equal(run.status, 200, '/api/run 应 200');
      assert.ok(run.body.includes('tool:start'), 'SSE 应下发 tool:start');
      assert.ok(run.body.includes('_done'), 'SSE 应以 _done 终结');

      const get = await req('GET', `/api/chat/sessions/${sid}`, {
        headers: auth()
      });
      assert.equal(get.status, 200, '读取会话应 200');
      const sess = JSON.parse(get.body);
      const traced = sess.messages.find(
        (m) => m.role === 'assistant' && Array.isArray(m.trace) && m.trace.length
      );
      assert.ok(traced, '应存在携带 trace 的 assistant 消息');

      const toolNodes = [];
      const llmMetas = [];
      const walk = (n) => {
        if (n.kind === 'llm') {
          llmMetas.push(n.meta || {});
        }
        if (n.kind === 'tool') {
          toolNodes.push(n);
        }
        (n.children || []).forEach(walk);
      };
      (traced.trace || []).forEach(walk);

      assert.ok(toolNodes.length > 0, '调用链路应包含真实执行的工具子节点');
      assert.ok(
        toolNodes.some((t) => t.detail && t.result),
        '工具节点应同时保留入参（detail）与结果（result）'
      );
      assert.ok(
        llmMetas.every((m) => m.tools === undefined),
        'LLM 节点 meta 不应再包含误导性的 tools 字段（可用工具数≠执行数）'
      );
    } finally {
      try {
        child.kill('SIGTERM');
      } catch {}
    }
  }
);

// dist 未构建时给出明确失败提示，而非静默跳过整个套件。
test('dist 未构建时显式提示', { skip: RUN }, () => {
  assert.fail(
    'access/server/dist/server.js 不存在：请先 `pnpm --filter @agent-harness/server run build` 再跑本测试'
  );
});

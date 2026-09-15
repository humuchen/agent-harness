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

      // 10) 未知路径（已鉴权）→ 404。未鉴权时会被 auth 网关先拦 401（防路径枚举），
      //     故此处带令牌以验证「鉴权通过后」的 404 路由兜底。
      r = await req('GET', '/api/does-not-exist', { headers: auth() });
      assert.equal(r.status, 404, '未知路径（已鉴权）应 404');

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

// 左侧历史列表「滚动加载」的端到端契约：GET /api/chat/sessions 支持 limit/offset，
// 并返回 total/hasMore 供前端判断是否续拉；不传参时保持「全量」旧契约。
// 刻意只建会话、不跑 /api/run —— 本用例验证的是分页接线，跑真实 run 只会拖慢套件。
test(
  '会话列表分页：limit/offset 切片 + total/hasMore（scroll 加载契约）',
  { skip: !RUN, timeout: 60000 },
  async () => {
    const { child, port } = await startServer();
    const req = makeReq(port);
    try {
      // 同一 token → 同一 owner，建 5 个会话。
      const created = [];
      for (let i = 0; i < 5; i++) {
        const r = await req('POST', '/api/chat/sessions', {
          headers: auth(),
          body: { title: `paging-${i}` }
        });
        assert.equal(r.status, 200, `创建第 ${i} 个会话应 200`);
        created.push(JSON.parse(r.body).id);
      }

      // 1) 不传分页参数 → 全量，保持向后兼容（老客户端行为不变）。
      const allRes = await req('GET', '/api/chat/sessions', { headers: auth() });
      assert.equal(allRes.status, 200);
      const all = JSON.parse(allRes.body);
      assert.ok(Array.isArray(all.sessions), 'sessions 应为数组');
      assert.equal(all.total, all.sessions.length, '缺省 limit 应返回全量');
      assert.equal(all.hasMore, false, '全量返回时 hasMore 必须为 false');
      for (const id of created) {
        assert.ok(
          all.sessions.some((s) => s.id === id),
          `全量列表应含刚创建的会话 ${id}`
        );
      }

      // 2) 显式分页：逐页拼接应无重复、无遗漏，且顺序与全量一致。
      const expected = all.sessions.map((s) => s.id);
      const seen = [];
      let offset = 0;
      let hasMore = true;
      for (let round = 0; round < 50 && hasMore; round++) {
        const r = await req(
          'GET',
          `/api/chat/sessions?limit=2&offset=${offset}`,
          { headers: auth() }
        );
        assert.equal(r.status, 200, '分页请求应 200');
        const p = JSON.parse(r.body);
        assert.equal(p.total, expected.length, 'total 不应随分页变化');
        assert.ok(p.sessions.length <= 2, 'limit=2 时单页不得超过 2 条');
        seen.push(...p.sessions.map((s) => s.id));
        offset += p.sessions.length;
        hasMore = p.hasMore;
        if (hasMore) {
          assert.equal(p.sessions.length, 2, 'hasMore=true 时单页应为满页');
        }
      }
      assert.equal(hasMore, false, '分页必须在取完末尾时收敛');
      assert.equal(new Set(seen).size, seen.length, '分页拼接不得出现重复会话');
      assert.deepEqual(seen, expected, '分页拼接应逐条覆盖全量且顺序一致');

      // 3) offset 越界 → 空页 + hasMore=false（前端据此停止续拉）。
      const over = await req(
        'GET',
        '/api/chat/sessions?limit=2&offset=9999',
        { headers: auth() }
      );
      assert.equal(over.status, 200);
      const overPage = JSON.parse(over.body);
      assert.equal(overPage.sessions.length, 0, 'offset 越界应返回空页');
      assert.equal(overPage.hasMore, false, 'offset 越界应无下一页');

      // 4) 非法参数必须回落全量而不是 500（前端可能传来被截断的参数）。
      const bad = await req(
        'GET',
        '/api/chat/sessions?limit=abc&offset=-3',
        { headers: auth() }
      );
      assert.equal(bad.status, 200, '非法分页参数应回落全量而非报错');
      const badPage = JSON.parse(bad.body);
      assert.equal(badPage.sessions.length, expected.length);
      assert.equal(badPage.hasMore, false);
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

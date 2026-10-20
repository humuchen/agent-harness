// CLI e2e 测试：在随机端口起一个最小 mock HTTP server（实现 CLI 消费的 /api/v1 端点），
// 用子进程真实运行 dist/cli.js，断言 stdout / 退出码 —— 覆盖此前完全无测试的命令解析
// 与错误映射路径（需先 pnpm --filter @agent-harness/cli run build；CI 的 -r build 先行）。
//
// 覆盖：
// - state / metrics / mcp list：成功路径 + --json 机器可读输出
// - health：服务不可达 exit 1、可达 exit 0
// - 未知命令 exit 1；缺必选参数（eval --job / approvals decide --id）exit 1
// - HTTP 403 错误映射：错误信息进 stderr、exit 1
const test = require('node:test');
const assert = require('node:assert');
const { createServer } = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const CLI_JS = path.join(__dirname, '..', 'dist', 'cli.js');
const BUILT = fs.existsSync(CLI_JS);

function startMockServer(routes) {
  const server = createServer((req, res) => {
    const url = req.url ?? '/';
    const handler = routes[`${req.method} ${url.split('?')[0]}`];
    if (!handler) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    const out = handler({ method: req.method, url });
    // Connection: close —— 让 CLI 的 fetch 在响应后关闭 socket，进程可立即退出
    //（keep-alive 连接会把事件循环挂住，导致 spawnSync 15s 超时被杀）。
    res.writeHead(out.status ?? 200, { 'content-type': 'application/json', connection: 'close' });
    res.end(JSON.stringify(out.body ?? {}));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/**
 * 异步运行 CLI（收集 stdout/stderr/退出码）。
 * 注意：必须用 spawn 而非 spawnSync —— mock server 与本测试同进程，spawnSync 会
 * 阻塞事件循环导致父进程无法应答 HTTP 请求，形成「CLI 连上却收不到响应」的死锁。
 */
function runCli(args, baseUrl, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_JS, ...args], {
      env: { ...process.env, AH_BASE: baseUrl, NO_COLOR: '1', ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let errOut = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (errOut += d));
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ status: code, stdout: out, stderr: errOut, signal });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ status: -1, stdout: out, stderr: `${errOut}${e.message}`, signal: null });
    });
  });
}

test('state：打印 JSON 状态（人类可读）与 --json 机器可读输出', { skip: !BUILT }, async () => {
  const { server, port } = await startMockServer({
    'GET /api/v1/state': () => ({ body: { ok: true, features: { a: 1 } } }),
  });
  try {
    const base = `http://127.0.0.1:${port}`;
    const human = await runCli(['state'], base);
    assert.strictEqual(human.status, 0);
    assert.ok(human.stdout.includes('ok'), `应含状态内容：${human.stdout}`);
    const machine = await runCli(['--json', 'state'], base);
    assert.strictEqual(machine.status, 0);
    const parsed = JSON.parse(machine.stdout.trim());
    assert.deepStrictEqual(parsed.features, { a: 1 }, '--json 应输出纯 JSON 行');
  } finally {
    server.close();
  }
});

test('metrics / mcp list：成功路径', { skip: !BUILT }, async () => {
  const { server, port } = await startMockServer({
    'GET /api/v1/metrics': () => ({ body: { runs: { total: 3 } } }),
    'GET /api/v1/mcp/list': () => ({
      body: { servers: [{ name: 'ctx7', status: 'connected', toolCount: 2 }] },
    }),
  });
  try {
    const base = `http://127.0.0.1:${port}`;
    const m = await runCli(['metrics'], base);
    assert.strictEqual(m.status, 0);
    assert.ok(m.stdout.includes('total'), `metrics 应含数据：${m.stdout}`);
    const list = await runCli(['mcp', 'list'], base);
    assert.strictEqual(list.status, 0);
    assert.ok(list.stdout.includes('ctx7'), `mcp list 应含 server 名：${list.stdout}`);
    assert.ok(list.stdout.includes('tools=2'));
  } finally {
    server.close();
  }
});

test('health：可达 exit 0 / 不可达 exit 1（错误信息进 stderr）', { skip: !BUILT }, async () => {
  const { server, port } = await startMockServer({
    'GET /api/v1/state': () => ({ body: { ok: true } }),
  });
  try {
    const ok = await runCli(['health'], `http://127.0.0.1:${port}`);
    assert.strictEqual(ok.status, 0);
    assert.ok(ok.stdout.includes('ok'));
  } finally {
    server.close();
  }
  // 不可达端口：随机高端口上大概率无监听
  const bad = await runCli(['health'], 'http://127.0.0.1:59999');
  assert.strictEqual(bad.status, 1, '不可达应 exit 1');
  assert.ok(bad.stderr.length > 0, '错误信息应输出到 stderr');
});

test('未知命令 / 缺参：exit 1 + 用法提示', { skip: !BUILT }, async () => {
  const unknown = await runCli(['definitely-not-a-cmd'], 'http://127.0.0.1:59999');
  assert.strictEqual(unknown.status, 1);
  assert.ok(unknown.stderr.includes('未知命令'), `应提示未知命令：${unknown.stderr}`);

  const noJob = await runCli(['eval'], 'http://127.0.0.1:59999');
  assert.strictEqual(noJob.status, 1, 'eval 缺 --job 应 exit 1');
  assert.ok(noJob.stderr.includes('--job'));

  const noId = await runCli(['approvals', 'decide'], 'http://127.0.0.1:59999');
  assert.strictEqual(noId.status, 1, 'approvals decide 缺 --id 应 exit 1');
  assert.ok(noId.stderr.includes('--id'));

  const badSub = await runCli(['mcp', 'frobnicate'], 'http://127.0.0.1:59999');
  assert.strictEqual(badSub.status, 1, '未知子命令应 exit 1');
});

test('错误映射：HTTP 403 → stderr 错误信息 + exit 1', { skip: !BUILT }, async () => {
  const { server, port } = await startMockServer({
    'GET /api/v1/state': () => ({ status: 403, body: { error: 'forbidden' } }),
  });
  try {
    const r = await runCli(['state'], `http://127.0.0.1:${port}`);
    assert.strictEqual(r.status, 1, '403 应映射为 exit 1');
    assert.ok(r.stderr.length > 0, '错误信息应进 stderr');
    assert.ok(!r.stdout.includes('ok'), '成功内容不应输出');
  } finally {
    server.close();
  }
});

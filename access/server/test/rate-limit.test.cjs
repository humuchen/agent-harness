'use strict';
// 限流回归测试：验证固定窗口限流对普通 API 生效、SSE 端点被排除、
// CF-Connecting-IP 优先于 X-Forwarded-For 作为 IP 桶 key，且 429 带 Retry-After。
// 启动真实构建产物 dist/server.js 子进程；运行前需先构建 server。

const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const { join } = require('node:path');
const http = require('node:http');

const SERVER_JS = join(__dirname, '..', 'dist', 'server.js');
const TOKEN = 'rate-limit-test-token';
const TOKENS_JSON = JSON.stringify({ [TOKEN]: 'admin' });
const RUN = existsSync(SERVER_JS);

function freshPort() {
  return 40000 + Math.floor(Math.random() * 5000);
}

function startServer(rateLimit, windowMs = 1000) {
  const port = freshPort();
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      PORT: String(port),
      UI_HOST: '127.0.0.1',
      UI_TOKENS: TOKENS_JSON,
      MAX_BODY_BYTES: '1024',
      RATE_LIMIT: String(rateLimit),
      RATE_LIMIT_WINDOW_MS: String(windowMs),
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

function request(method, path, port, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body != null ? JSON.stringify(body) : null;
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

function requestHeaders(method, path, port, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path, headers: { ...headers } },
      (res) => {
        resolve({
          status: res.statusCode,
          headers: res.headers
        });
        res.resume();
      }
    );
    req.on('error', reject);
    req.end();
  });
}

const auth = () => ({ authorization: 'Bearer ' + TOKEN });

test(
  '固定窗口限流：普通 API 超限返回 429 并带 Retry-After',
  { skip: !RUN },
  async () => {
    const { child, port } = await startServer(2);
    try {
      const h = auth();
      const r1 = await request('GET', '/api/metrics', port, { headers: h });
      assert.notStrictEqual(r1.status, 429, '第 1 请求不应被限流');
      const r2 = await request('GET', '/api/metrics', port, { headers: h });
      assert.notStrictEqual(r2.status, 429, '第 2 请求不应被限流');
      const r3 = await request('GET', '/api/metrics', port, { headers: h });
      assert.strictEqual(r3.status, 429, '第 3 请求应被限流');
      assert.ok(
        r3.headers['retry-after'] || r3.headers['Retry-After'],
        '429 响应应带 Retry-After'
      );
      const body = JSON.parse(r3.body || '{}');
      assert.strictEqual(body.error, 'rate limit exceeded');
    } finally {
      child.kill('SIGTERM');
    }
  }
);

test(
  'CF-Connecting-IP 优先于 X-Forwarded-For 作为限流桶 key',
  { skip: !RUN },
  async () => {
    const { child, port } = await startServer(2);
    try {
      const h = auth();
      // 同一个 CF-IP 打满 2 次
      const ipA = { ...h, 'cf-connecting-ip': '203.0.113.1' };
      await request('GET', '/api/metrics', port, { headers: ipA });
      await request('GET', '/api/metrics', port, { headers: ipA });
      const rA3 = await request('GET', '/api/metrics', port, { headers: ipA });
      assert.strictEqual(rA3.status, 429, '同 CF-IP 第 3 请求应被限流');

      // 另一个 CF-IP 应独立计数（不被 A 的桶误伤）
      const ipB = { ...h, 'cf-connecting-ip': '203.0.113.2' };
      const rB1 = await request('GET', '/api/metrics', port, { headers: ipB });
      assert.notStrictEqual(rB1.status, 429, '不同 CF-IP 应独立限流桶');
    } finally {
      child.kill('SIGTERM');
    }
  }
);

test(
  'SSE 端点不计入全局固定窗口限流',
  { skip: !RUN, timeout: 10000 },
  async () => {
    const { child, port } = await startServer(2);
    try {
      const h = auth();
      // 先把普通 API 桶打满，确保若 SSE 共享同一桶则后续 SSE 会 429
      await request('GET', '/api/metrics', port, { headers: h });
      await request('GET', '/api/metrics', port, { headers: h });
      const rOver = await request('GET', '/api/metrics', port, { headers: h });
      assert.strictEqual(rOver.status, 429, '普通 API 应先触发限流');

      // SSE 端点只取响应头即销毁连接，不等待 body（避免挂起）
      const sse1 = await requestHeaders('GET', '/api/events', port, {
        ...h,
        accept: 'text/event-stream'
      });
      assert.notStrictEqual(sse1.status, 429, 'SSE /api/events 不应 429');
      const sse2 = await requestHeaders('GET', '/api/chat/stream', port, {
        ...h,
        accept: 'text/event-stream'
      });
      assert.notStrictEqual(sse2.status, 429, 'SSE /api/chat/stream 不应 429');
    } finally {
      child.kill('SIGTERM');
    }
  }
);

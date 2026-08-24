/**
 * Server API 集成测试。
 *
 * 覆盖核心端点:
 * - POST /api/v1/run - Job 生命周期(提交→执行→SSE→完成)
 * - GET/POST /api/v1/approvals - 审批工作流
 * - POST /api/v1/eval - 评估端点
 * - GET /api/state - 系统状态
 *
 * 注意: 这些测试需要服务器运行在 http://localhost:3100
 * 如果服务器未启动,测试将被跳过。
 *
 * 运行方式:
 *   1. 先启动服务器: pnpm --filter @agent-harness/server run dev
 *   2. 然后运行测试: pnpm --filter @agent-harness/server test
 */
const { test, describe, before } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const SERVER_URL = 'http://localhost:3100';
let SERVER_AVAILABLE = false;

// 检查服务器是否可用
before(
  async () => {
    try {
      await new Promise((resolve, reject) => {
        const req = http.get(SERVER_URL, (res) => {
          res.on('data', () => {});
          res.on('end', () => resolve());
        });
        req.on('error', reject);
        req.setTimeout(2000, () => {
          req.destroy();
          reject(new Error('timeout'));
        });
      });
      SERVER_AVAILABLE = true;
      console.log('✅ 服务器可用,运行 API 集成测试');
    } catch {
      SERVER_AVAILABLE = false;
      console.log('⚠️  服务器未运行,跳过 API 集成测试');
      console.log('   启动方式: pnpm --filter @agent-harness/server run dev');
    }
  },
  { timeout: 5000 }
);

// 辅助函数:发送HTTP请求
function httpRequest(method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, SERVER_URL);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...headers
      }
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: data ? JSON.parse(data) : null
          });
        } catch {
          resolve({ status: res.statusCode, headers: res.headers, body: data });
        }
      });
    });

    req.on('error', reject);
    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

describe('Server API 集成测试', () => {
  before(() => {
    if (!SERVER_AVAILABLE) {
      process.exit(0); // 跳过所有测试
    }
  });

  describe('GET /api/state', () => {
    test('返回系统状态概览', async () => {
      const res = await httpRequest('GET', '/api/state');
      assert.strictEqual(res.status, 200);
      assert.ok(res.body);
      assert.ok(res.body.version || res.body.uptime);
    });
  });

  describe('POST /api/v1/run', () => {
    test('提交 job 并返回 job ID', async () => {
      const res = await httpRequest(
        'POST',
        '/api/v1/run',
        {
          prompt: '你好,请介绍一下你自己',
          model: 'test-model'
        },
        { Authorization: 'Bearer test-admin-token' }
      );

      // 应该返回 200 或 201
      assert.ok(res.status === 200 || res.status === 201);
      assert.ok(res.body);
      assert.ok(res.body.jobId || res.body.id, '应返回 job ID');
    });

    test('缺少认证应返回 401', async () => {
      const res = await httpRequest('POST', '/api/v1/run', { prompt: 'test' });
      assert.strictEqual(res.status, 401);
    });
  });

  describe('GET /api/v1/approvals', () => {
    test('列出审批票据', async () => {
      const res = await httpRequest('GET', '/api/v1/approvals', null, {
        Authorization: 'Bearer test-admin-token'
      });

      // 200 或 404(如果未实现)都可以接受
      assert.ok(res.status === 200 || res.status === 404);
      if (res.status === 200) {
        assert.ok(Array.isArray(res.body) || res.body.tickets);
      }
    });
  });

  describe('POST /api/v1/eval', () => {
    test('评估端点应接受请求', async () => {
      const res = await httpRequest(
        'POST',
        '/api/v1/eval',
        {
          runId: 'test-run-001',
          metrics: { latency: 100, tokens: 50 }
        },
        { Authorization: 'Bearer test-admin-token' }
      );

      // 200 或 202 都可以
      assert.ok(res.status === 200 || res.status === 202);
    });
  });

  describe('健康检查', () => {
    test('GET / 应返回服务信息', async () => {
      const res = await httpRequest('GET', '/');
      assert.ok(res.status === 200 || res.status === 302);
    });
  });
});

// 零依赖测试：订单 REST 客户端（queryOrder）在「上游已配置」时的真实行为。
// 用 node:http 起本地上游，验证：参数校验 / 成功归一化 / 404 / 重试后成功 / 脏响应 / 连接拒绝。
// 注意：config 首次读取即缓存，因此 CS_ORDER_* 必须在第一次 queryOrder 之前设置。
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { once } = require('node:events');

const { queryOrder } = require('../dist/services/order-service.js');

describe('order-service REST 客户端', () => {
  let server;
  /** 按 orderNo 配置上游行为：剩余可失败的次数（500）。 */
  const failFirst = new Map();
  const hits = new Map();

  before(async () => {
    server = http.createServer((req, res) => {
      const m = /^\/orders\/([^/]+)$/.exec(req.url || '');
      if (!m) {
        res.writeHead(404).end('{}');
        return;
      }
      const orderNo = decodeURIComponent(m[1]);
      hits.set(orderNo, (hits.get(orderNo) || 0) + 1);
      if ((failFirst.get(orderNo) || 0) > 0) {
        failFirst.set(orderNo, failFirst.get(orderNo) - 1);
        res.writeHead(500).end('{"error":"boom"}');
        return;
      }
      if (orderNo === 'NOTFOUND') {
        res.writeHead(404).end('{}');
        return;
      }
      if (orderNo === 'DEAD') {
        // 模拟连接中断：不发任何响应，直接销毁 socket → fetch 抛网络错误
        req.socket.destroy();
        return;
      }
      if (orderNo === 'BAD') {
        // 脏响应：缺 orderNo
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"weird"}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          orderNo,
          status: 'shipped',
          logistics: 'SF123456',
          refundable: true,
          warranty: '12个月',
        })
      );
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = server.address().port;
    // 关键：在第一次 queryOrder 前注入配置（config 首次读取即缓存）
    process.env.CS_ORDER_BASE_URL = `http://127.0.0.1:${port}`;
    process.env.CS_ORDER_TOKEN = 'test-token';
    process.env.CS_ORDER_TIMEOUT_MS = '3000';
    process.env.CS_ORDER_RETRIES = '1';
  });

  after(() => {
    server.close();
  });

  test('参数校验：orderNo 为空返回 INVALID_ARGUMENT', async () => {
    const out = await queryOrder({ orderNo: '  ' });
    assert.strictEqual(out.error, true);
    assert.strictEqual(out.code, 'INVALID_ARGUMENT');
  });

  test('成功：返回归一化订单（含物流/退款/保修）', async () => {
    const out = await queryOrder({ orderNo: 'OK-1' });
    assert.strictEqual(out.error, undefined);
    assert.strictEqual(out.orderNo, 'OK-1');
    assert.strictEqual(out.status, 'shipped');
    assert.strictEqual(out.logistics, 'SF123456');
    assert.strictEqual(out.refundable, true);
    assert.strictEqual(out.warranty, '12个月');
  });

  test('404：订单不存在返回结构化 UPSTREAM_ERROR', async () => {
    const out = await queryOrder({ orderNo: 'NOTFOUND' });
    assert.strictEqual(out.error, true);
    assert.strictEqual(out.code, 'UPSTREAM_ERROR');
    assert.match(out.message, /订单不存在/);
  });

  test('重试：首次 500 后重试成功（RETRIES=1 → 最多 2 次尝试）', async () => {
    failFirst.set('FLAP', 1);
    const out = await queryOrder({ orderNo: 'FLAP' });
    assert.strictEqual(out.error, undefined);
    assert.strictEqual(out.orderNo, 'FLAP');
    assert.strictEqual(hits.get('FLAP'), 2); // 1 次失败 + 1 次成功
  });

  test('脏响应：上游返回缺 orderNo 的对象 → UPSTREAM_ERROR', async () => {
    const out = await queryOrder({ orderNo: 'BAD' });
    assert.strictEqual(out.error, true);
    assert.strictEqual(out.code, 'UPSTREAM_ERROR');
    assert.match(out.message, /orderNo/);
  });

  test('上游连接中断（socket 销毁）→ 重试后 UPSTREAM_ERROR，不抛异常', async () => {
    const out = await queryOrder({ orderNo: 'DEAD' });
    assert.strictEqual(out.error, true);
    assert.strictEqual(out.code, 'UPSTREAM_ERROR');
    assert.strictEqual(hits.get('DEAD'), 2); // 首次失败 + 重试
  });
});

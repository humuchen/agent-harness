'use strict';
// 边缘路由表纯函数单测：routeMatches / findEdgeRoute / createEdgeRoutes。
// 不依赖真实 server 进程，仅验证路由匹配语义（精确 / 前缀 / 方法不匹配）。
// 运行于已编译产物（dist）；与 server.test.cjs 同约定（先 build 再 test）。
const test = require('node:test');
const assert = require('node:assert');
const { routeMatches, findEdgeRoute, createEdgeRoutes, tryDispatchEdgeRoute } =
  require('../dist/routes/edge-routes');

test('routeMatches: 精确路径仅同方法命中', () => {
  const def = { method: 'GET', path: '/api/state' };
  assert.equal(routeMatches(def, 'GET', '/api/state'), true);
  assert.equal(routeMatches(def, 'POST', '/api/state'), false);
  assert.equal(routeMatches(def, 'GET', '/api/state/'), false);
  assert.equal(routeMatches(def, 'GET', '/api/state/x'), false);
});

test('routeMatches: 前缀路径匹配自身与子路径', () => {
  const def = { method: 'GET', path: '/api/plugins/' };
  assert.equal(routeMatches(def, 'GET', '/api/plugins/'), true);
  assert.equal(routeMatches(def, 'GET', '/api/plugins/memo'), true);
  assert.equal(routeMatches(def, 'GET', '/api/plugins/memo/tools'), true);
  assert.equal(routeMatches(def, 'GET', '/api/plugin'), false);
  assert.equal(routeMatches(def, 'POST', '/api/plugins/x'), false);
});

test('routeMatches: method=* 匹配任意方法', () => {
  const def = { method: '*', path: '/api/run' };
  assert.equal(routeMatches(def, 'GET', '/api/run'), true);
  assert.equal(routeMatches(def, 'POST', '/api/run'), true);
});

test('findEdgeRoute: 返回第一个命中且顺序即优先级', () => {
  const routes = [
    { method: 'GET', path: '/api/state', handler: () => 'state' },
    { method: 'GET', path: '/api/sandbox', handler: () => 'sandbox' }
  ];
  assert.equal(findEdgeRoute(routes, 'GET', '/api/sandbox').handler(), 'sandbox');
  assert.equal(findEdgeRoute(routes, 'GET', '/nope'), null);
  assert.equal(findEdgeRoute(routes, 'POST', '/api/state'), null);
});

test('createEdgeRoutes: 含健康探针与公开端点', () => {
  const routes = createEdgeRoutes();
  const paths = routes.map((r) => `${r.method} ${r.path}`);
  assert.ok(paths.includes('GET /health/live'));
  assert.ok(paths.includes('GET /health/ready'));
  assert.ok(paths.includes('GET /api/state'));
  assert.ok(paths.includes('GET /api/sandbox'));
  assert.ok(paths.includes('GET /api/auth/config'));
  assert.ok(paths.includes('GET /api/errors'));
  // 每个 handler 必须是函数
  assert.ok(routes.every((r) => typeof r.handler === 'function'));
});

test('tryDispatchEdgeRoute: 命中后调用 handler 并短路返回 true', async () => {
  // 通过 createEdgeRoutes + 桩 deps 验证 /api/state 能分发且写入 200 JSON。
  const { tryDispatchEdgeRoute } = require('../dist/routes/edge-routes');
  const routes = createEdgeRoutes();
  const res = {
    headers: null,
    body: null,
    writeHead(code, h) {
      this.code = code;
      this.headers = h;
    },
    end(s) {
      this.body = s;
    }
  };
  const deps = {
    buildState: () => ({ ok: 1 }),
    getSandboxStatus: () => null,
    getAuthConfig: () => ({ provider: 'token' }),
    getErrorLog: () => [],
    getErrorSummary: () => ({}),
    formatErrorReport: () => '',
    handleLiveness: () => {},
    handleReadiness: () => {}
  };
  const url = new URL('http://localhost/api/state');
  const dispatched = await tryDispatchEdgeRoute(routes, { method: 'GET', url }, res, url, deps);
  assert.equal(dispatched, true);
  assert.equal(res.code, 200);
  assert.deepEqual(JSON.parse(res.body), { ok: 1 });
});

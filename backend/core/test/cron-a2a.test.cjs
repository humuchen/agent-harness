// 中期/长期首片测试：框架级 cron + leader 选举锁 + A2A 异步回调投递。
const { test, describe } = require('node:test');
const assert = require('node:assert');
const { createServer } = require('node:http');
const {
  CronScheduler,
  MemoryLeaderElector,
  RedisLeaderElector,
  LocalA2ATransport,
  deliverA2ACallback,
  makeTaskId,
} = require('../dist/index.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('CronScheduler', () => {
  test('周期执行：按 everyMs 触发 run，统计与失败隔离正确', async () => {
    const s = new CronScheduler();
    let runs = 0;
    let failures = 0;
    s.register({ name: 'a', everyMs: 60, run: () => { runs++; } });
    s.register({ name: 'b', everyMs: 60, run: () => { throw new Error('boom'); } });
    await sleep(600);
    s.stopAll();
    assert.ok(runs >= 2, `应多次执行（runs=${runs}）`);
    const stats = s.stats();
    assert.equal(stats.length, 0, 'stopAll 应清空任务');
  });

  test('单飞：上一轮未完成时跳过本轮（不重叠）', async () => {
    const s = new CronScheduler();
    let concurrent = 0;
    let maxConcurrent = 0;
    s.register({
      name: 'slow',
      everyMs: 30,
      run: async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await sleep(120);
        concurrent--;
      },
    });
    await sleep(400);
    s.stopAll();
    assert.equal(maxConcurrent, 1, '单飞语义：任一时刻最多一个执行');
  });

  test('重名注册覆盖旧任务（幂等注册）', () => {
    const s = new CronScheduler();
    s.register({ name: 'x', everyMs: 1000, run: () => {} });
    s.register({ name: 'x', everyMs: 2000, run: () => {} });
    assert.equal(s.size, 1);
    s.stopAll();
  });

  test('everyMs 下限收敛到 250ms（防误设打满 CPU）', async () => {
    const s = new CronScheduler();
    let runs = 0;
    s.register({ name: 'hot', everyMs: 1, run: () => { runs++; } });
    await sleep(320);
    s.stopAll();
    assert.ok(runs <= 3, `下限生效，1ms 间隔不应打满（runs=${runs}）`);
  });

  test('leaderOnly：无选举器时照常执行；注入恒否选举器时跳过', async () => {
    const s = new CronScheduler();
    let runs = 0;
    s.register({ name: 'led', everyMs: 50, leaderOnly: true, run: () => { runs++; } });
    await sleep(200);
    const before = runs;
    assert.ok(before >= 1, '未注入选举器：leaderOnly 任务照常执行');
    s.configureLeaderElector({ isLeader: async () => false });
    await sleep(200);
    s.stopAll();
    assert.equal(runs, before, '注入恒否选举器后应跳过执行');
  });

  test('注销函数：单任务停止', async () => {
    const s = new CronScheduler();
    let runs = 0;
    const unreg = s.register({ name: 'once', everyMs: 50, run: () => { runs++; } });
    await sleep(180);
    unreg();
    const at = runs;
    await sleep(180);
    assert.equal(runs, at, '注销后不再执行');
  });
});

describe('LeaderElector', () => {
  test('MemoryLeaderElector：单进程恒为 leader', async () => {
    assert.equal(await new MemoryLeaderElector().isLeader(), true);
  });

  test('RedisLeaderElector：Fake client —— SET NX 成功/占用/自持/故障 fail-open', async () => {
    const store = new Map();
    const fake = {
      async set(key, value, _nx, _px, ttl) {
        if (store.has(key)) return null;
        store.set(key, { value, ttl });
        return 'OK';
      },
      async get(key) {
        return store.get(key)?.value ?? null;
      },
      async eval(_script, _n, key, token) {
        if (store.get(key)?.value === token) { store.delete(key); return 1; }
        return 0;
      },
    };
    const a = new RedisLeaderElector({ client: fake, key: 'k' });
    const b = new RedisLeaderElector({ client: fake, key: 'k', ttlMs: 1000 });
    assert.equal(await a.isLeader(), true, '首个实例抢锁成功');
    assert.equal(await b.isLeader(), false, '他方持锁时非 leader');
    assert.equal(await a.isLeader(), true, '自持锁仍为 leader（续期语义）');
    await a.release();
    assert.equal(await b.isLeader(), true, '释放后他方可抢锁');
    // 故障 fail-open：client 抛错 → 按 leader 处理（宁重复不全停）
    const broken = new RedisLeaderElector({ client: { set: async () => { throw new Error('down'); }, eval: async () => { throw new Error('down'); } } });
    assert.equal(await broken.isLeader(), true, 'Redis 故障 fail-open');
  });
});

describe('A2A 异步回调投递（长期首片）', () => {
  test('LocalA2ATransport：任务完成/失败均向 callback POST 结果', async () => {
    const received = [];
    const srv = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push(JSON.parse(body));
        res.statusCode = 204;
        res.end();
      });
    });
    await new Promise((r) => srv.listen(0, r));
    const cbUrl = `http://127.0.0.1:${srv.address().port}/cb`;
    try {
      const okRunner = async () => ({ value: 42 });
      const t1 = new LocalA2ATransport(okRunner);
      const r1 = await t1.send({
        taskId: makeTaskId(), tenantId: 't1', fromAgent: 'a', toAgent: 'b',
        input: {}, traceId: 'tr-1', callback: cbUrl,
      });
      assert.equal(r1.status, 'success');
      const failRunner = async () => { throw new Error('kaput'); };
      const t2 = new LocalA2ATransport(failRunner);
      const r2 = await t2.send({
        taskId: makeTaskId(), tenantId: 't1', fromAgent: 'a', toAgent: 'b',
        input: {}, callback: cbUrl,
      });
      assert.equal(r2.status, 'failed');
      await sleep(150);
      assert.equal(received.length, 2, '成功与失败各投递一次');
      assert.equal(received[0].status, 'success');
      assert.deepEqual(received[0].output, { value: 42 });
      assert.equal(received[0].traceId, 'tr-1');
      assert.equal(received[1].status, 'failed');
      assert.ok(received[1].error.includes('kaput'));
      assert.equal(received[1].fromAgent, 'a');
      assert.equal(received[1].toAgent, 'b');
    } finally {
      srv.close();
    }
  });

  test('deliverA2ACallback：无 callback 返回 false；非 2xx/网络失败不抛错', async () => {
    assert.equal(await deliverA2ACallback(
      { taskId: 'x', tenantId: 't', fromAgent: 'a', toAgent: 'b', input: null },
      { taskId: 'x', status: 'success' },
    ), false, '无 callback 直接返回 false');
    // 不可达端口：返回 false 且不抛
    const ok = await deliverA2ACallback(
      { taskId: 'x', tenantId: 't', fromAgent: 'a', toAgent: 'b', input: null, callback: 'http://127.0.0.1:1/nope' },
      { taskId: 'x', status: 'success' },
    );
    assert.equal(ok, false);
  });
});

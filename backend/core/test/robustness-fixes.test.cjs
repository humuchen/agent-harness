'use strict';
/**
 * 健壮性收尾修复测试：
 * 1. db-adapter Turso 降级——降级必须落本地 localFile（远程 URL 绝不当本地路径），
 *    且不同 opts.file 的降级实例相互独立（此前共享一个实例会串库）。
 * 2. hooks——处理器挂死时 execute 在 AGENT_HOOK_TIMEOUT_MS 内返回并告警；抛错必留痕。
 * 3. multi-key——错误文案中的裸数字（如 "took 4013ms"）不再被误判为 401 冷却健康 Key；
 *    真实 401（结构化/锚定文案）仍立即冷却。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ---------------------------------------------------------------------------
// 1. db-adapter：Turso 降级路径
// ---------------------------------------------------------------------------

test('db-adapter：turso + 非法 TURSO_URL 降级到本地 localFile，且不同 file 实例独立', () => {
  const oldBackend = process.env.DB_BACKEND;
  const oldUrl = process.env.TURSO_URL;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-dbadapter-'));
  try {
    process.env.DB_BACKEND = 'turso';
    // 非法协议 → createClient 构造期抛错 → 触发降级路径（复现线上「缺依赖/坏配置」场景）
    process.env.TURSO_URL = 'notaurl://invalid.example';
    const { getDbAdapter, resetDbAdaptersForTest } = require('../dist/db-adapter.js');
    resetDbAdaptersForTest();

    const fileA = path.join(dir, 'a.db');
    const fileB = path.join(dir, 'b.db');
    const a = getDbAdapter({ file: fileA });
    const b = getDbAdapter({ file: fileB });

    // 两个不同逻辑文件必须是两个独立实例（旧实现共享 turso:<url> 键 → 串库）
    assert.notStrictEqual(a, b, '不同 file 的降级实例必须独立');
    // 各自可正常读写（落在各自 localFile 上，而不是名为 URL 的垃圾文件）
    a.exec('CREATE TABLE IF NOT EXISTS ta (x TEXT)');
    a.prepare('INSERT INTO ta (x) VALUES (?)').run('from-a');
    const ra = a.prepare('SELECT x FROM ta').all();
    assert.strictEqual(ra.length, 1);

    b.exec('CREATE TABLE IF NOT EXISTS tb (x TEXT)');
    const rb = b.prepare('SELECT x FROM tb').all();
    assert.strictEqual(rb.length, 0, 'b 库不应看到 a 的数据（此前串库）');

    // 降级后不应产生以远程 URL 命名的垃圾本地文件
    const created = fs.readdirSync(dir);
    assert.ok(created.includes('a.db') && created.includes('b.db'));
    assert.ok(!created.some((f) => f.includes('notaurl')), '不得产生以 URL 命名的垃圾文件');
  } finally {
    if (oldBackend === undefined) delete process.env.DB_BACKEND;
    else process.env.DB_BACKEND = oldBackend;
    if (oldUrl === undefined) delete process.env.TURSO_URL;
    else process.env.TURSO_URL = oldUrl;
    const { resetDbAdaptersForTest } = require('../dist/db-adapter.js');
    resetDbAdaptersForTest();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2. hooks：超时保护 + 异常留痕
// ---------------------------------------------------------------------------

function captureConsole(fn) {
  const lines = [];
  const origLog = console.log;
  const origWarn = console.warn;
  console.log = (...a) => lines.push(a.join(' '));
  console.warn = (...a) => lines.push(a.join(' '));
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      console.log = origLog;
      console.warn = origWarn;
    })
    .then(() => lines);
}

test('hooks：挂死的处理器在超时后放弃等待并告警，execute 正常返回', async () => {
  const { hooks } = require('../dist/hooks.js');
  const oldT = process.env.AGENT_HOOK_TIMEOUT_MS;
  process.env.AGENT_HOOK_TIMEOUT_MS = '60';
  // 源码中超时定时器是 unref 的（不阻碍进程自然退出）；测试里事件循环若无其它
  // ref 句柄会在定时器触发前排空（「event loop resolved」取消用例），需受控保活。
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const off = hooks.register('agent.pre_run', () => new Promise(() => {})); // 永不返回
    const lines = await captureConsole(async () => {
      const t0 = Date.now();
      await hooks.execute('agent.pre_run', { runId: 'r-timeout' });
      const elapsed = Date.now() - t0;
      assert.ok(elapsed < 5000, `execute 应在超时后返回，实际 ${elapsed}ms`);
    });
    off();
    const warns = lines.filter((l) => l.includes('hook handler failed'));
    assert.ok(warns.length >= 1, '应有超时告警');
    assert.ok(warns.some((l) => l.includes('timeout')), '告警应含 timeout 字样');
  } finally {
    clearInterval(keepAlive);
    if (oldT === undefined) delete process.env.AGENT_HOOK_TIMEOUT_MS;
    else process.env.AGENT_HOOK_TIMEOUT_MS = oldT;
  }
});

test('hooks：处理器抛错必留痕（不再零日志静默吞掉）', async () => {
  const { hooks } = require('../dist/hooks.js');
  const off = hooks.register('agent.post_tool', async () => {
    throw new Error('boom-from-hook');
  });
  const lines = await captureConsole(() =>
    hooks.execute('agent.post_tool', { runId: 'r-err', toolResult: { output: 1, errored: false } })
  );
  off();
  const warns = lines.filter((l) => l.includes('hook handler failed'));
  assert.ok(warns.length >= 1, '应留 warn 日志');
  assert.ok(warns.some((l) => l.includes('boom-from-hook')), '日志应含原始错误信息');
});

// ---------------------------------------------------------------------------
// 3. multi-key：裸数字误判修复 + 真实 401 冷却保留
// ---------------------------------------------------------------------------

function okResp() {
  return {
    ok: true,
    status: 200,
    text: async () => '',
    json: async () => ({ choices: [{ message: { content: 'ok', tool_calls: [] } }] }),
  };
}

function headerOf(init) {
  const h = init?.headers ?? {};
  for (const [k, v] of Object.entries(h)) {
    if (k.toLowerCase() === 'authorization') return String(v);
  }
  return '';
}

test('multi-key：错误文案中的裸数字（4013ms）不再误判为 401 冷却健康 Key', async () => {
  const { createMultiKeyLLM } = require('../dist/llm/multi-key.js');
  const seen = [];
  let phase = 0;
  // phase 0：k0 抛「耗时 4013ms」的普通错误（旧实现会截出 401 → 误杀 k0）；
  //          k1 正常返回。phase 1：k0 正常返回。
  const fetchImpl = async (_url, init) => {
    const h = headerOf(init);
    seen.push(h);
    if (h.includes('sk-a') && phase === 0) {
      throw new Error('upstream took 4013ms to respond, try later');
    }
    return okResp();
  };
  const llm = createMultiKeyLLM(['sk-a', 'sk-b'], { fetchImpl, retries: 0 });
  const msgs = [{ role: 'user', content: 'hi' }];
  // 第 1 次调用：k0 失败（非限流/鉴权错误）→ failover 到 k1 成功
  await llm(msgs, []);
  assert.strictEqual(seen.length, 2, 'k0 失败后应尝试 k1');

  // 第 2 次调用：round-robin 从 k0 起——k0 仍健康（未被 4013ms 误杀）应直接成功
  phase = 1;
  const r2 = await llm(msgs, []);
  assert.strictEqual(r2.content, 'ok');
  assert.strictEqual(seen[seen.length - 1].includes('sk-a'), true, '第 2 次应命中 k0（健康）');
});

test('multi-key：真实 401（LLM API error 锚定文案）仍立即冷却该 Key', async () => {
  const { createMultiKeyLLM } = require('../dist/llm/multi-key.js');
  const seen = [];
  const fetchImpl = async (_url, init) => {
    const h = headerOf(init);
    seen.push(h);
    if (h.includes('sk-a')) {
      throw new Error('LLM API error 401 (model=m): invalid api key');
    }
    return okResp();
  };
  const llm = createMultiKeyLLM(['sk-a', 'sk-b'], { fetchImpl, retries: 0 });
  const msgs = [{ role: 'user', content: 'hi' }];
  await llm(msgs, []); // k0 401 → 立即冷却 → k1 成功
  await llm(msgs, []); // k0 已冷却，不应再被联系
  const aHits = seen.filter((h) => h.includes('sk-a')).length;
  assert.strictEqual(aHits, 1, 'k0 冷却后不得再被调用');
});

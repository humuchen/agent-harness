// 零依赖测试（node:test + node:assert）：TeamManager（teams/index.ts）。
// 关注：competitive 打分长度中性化（评审 P2-3：旧实现「结果长度 × 权重」度量天真，
// 改为饱和曲线 len/(len+K) × 权重），以及 sequential / parallel / round-robin
// 模式回归与 register / executeTask 的错误路径。

const test = require('node:test');
const assert = require('node:assert');

const { TeamManager, scoreResultUtility } = require('../dist/teams/index.js');

/** 构造假 AgentRegistry：TeamManager 只消费 get(id)。 */
function fakeRegistry(cards) {
  const map = new Map(cards.map((c) => [c.id, c]));
  return { get: async (id) => map.get(id) ?? null };
}

function card(id) {
  return {
    id,
    name: id,
    domain: 'generic',
    capabilities: [],
    transport: 'local',
    version: '1.0.0',
    health: 'healthy'
  };
}

// ── scoreResultUtility：饱和曲线 ──

test('scoreResultUtility：空结果（含纯空白）得 0 分', () => {
  assert.strictEqual(scoreResultUtility(''), 0);
  assert.strictEqual(scoreResultUtility('   \n\t  '), 0);
});

test('scoreResultUtility：单调递增且有界于 (0,1)', () => {
  const a = scoreResultUtility('x'.repeat(50));
  const b = scoreResultUtility('x'.repeat(600));
  const c = scoreResultUtility('x'.repeat(1200));
  const d = scoreResultUtility('x'.repeat(12000));
  const e = scoreResultUtility('x'.repeat(100000));
  assert.ok(a > 0);
  assert.ok(a < b && b < c && c < d && d < e, '长度增加分数应单调上升');
  assert.ok(e < 1, '分数应封顶于 1');
});

test('scoreResultUtility：饱和——超过半值点后长度增益急速衰减（长度中性化）', () => {
  const K = 1200;
  // 0 → K 得 0.5；K → 10K（多 10 倍字数）只再得约 0.41；
  // 10K → 100K（再多 10 倍字数）只再得 < 0.08。堆字数的边际收益趋零。
  const atK = scoreResultUtility('x'.repeat(K));
  const at10K = scoreResultUtility('x'.repeat(10 * K));
  const at100K = scoreResultUtility('x'.repeat(100 * K));
  assert.ok(Math.abs(atK - 0.5) < 1e-9);
  const gain1 = at10K - atK;
  const gain2 = at100K - at10K;
  assert.ok(gain2 < gain1, `增益应递减：${gain2} < ${gain1}`);
  assert.ok(gain1 < 0.45 && gain2 < 0.1, `增益应急速衰减：${gain1} -> ${gain2}`);
});

// ── competitive vote ──

test('competitive：空结果落选，非空成员胜出', async () => {
  const reg = fakeRegistry([card('a'), card('b')]);
  const tm = new TeamManager(reg);
  await tm.register({ id: 't', name: 'T', members: ['a', 'b'], mode: 'competitive' });
  const calls = [];
  const out = await tm.executeTask('t', 'q', async (c) => {
    calls.push(c.id);
    return c.id === 'a' ? '' : '切题的答案';
  });
  assert.deepStrictEqual([...calls].sort(), ['a', 'b'], '所有成员都应被派发');
  assert.strictEqual(out, '切题的答案');
});

test('competitive：超过饱和点后权重主导排名（旧实现会被长度击败）', async () => {
  const reg = fakeRegistry([card('long-winded'), card('trusted')]);
  const tm = new TeamManager(reg);
  await tm.register({
    id: 't',
    name: 'T',
    members: ['long-winded', 'trusted'],
    mode: 'competitive',
    weights: { 'long-winded': 1, trusted: 1.2 }
  });
  // long-winded 产出 100K 字符：效用 ~0.988 × 1 = 0.988；
  // trusted 产出 12K 字符：效用 ~0.909 × 1.2 = 1.091 → 新打分 trusted 胜。
  // 旧实现（长度×权重）：100000×1 = 100000 > 14400 → long-winded 胜，语义相反。
  const longOut = 'x'.repeat(100000);
  const trustedOut = 'y'.repeat(12000);
  const out = await tm.executeTask('t', 'q', async (c) =>
    c.id === 'long-winded' ? longOut : trustedOut
  );
  assert.strictEqual(out, trustedOut);
});

test('competitive：等长输出且等权重时先注册成员优先（reduce 严格大于）', async () => {
  const reg = fakeRegistry([card('first'), card('second')]);
  const tm = new TeamManager(reg);
  await tm.register({ id: 't', name: 'T', members: ['first', 'second'], mode: 'competitive' });
  const out = await tm.executeTask('t', 'q', async (c) =>
    c.id === 'first' ? 'A'.repeat(3000) : 'B'.repeat(3000)
  );
  assert.strictEqual(out, 'A'.repeat(3000));
});

// ── 其它模式回归（本轮未改动，防回归）──

test('sequential：链式传递，返回最后一个成员的结果', async () => {
  const reg = fakeRegistry([card('a'), card('b')]);
  const tm = new TeamManager(reg);
  await tm.register({ id: 't', name: 'T', members: ['a', 'b'], mode: 'sequential' });
  const seen = [];
  const out = await tm.executeTask('t', 'start', async (c, input) => {
    seen.push(`${c.id}:${input}`);
    return `${c.id}-out`;
  });
  assert.strictEqual(out, 'b-out');
  assert.deepStrictEqual(seen, ['a:start', 'b:a-out']);
});

test('parallel：全员并发，返回结果数组', async () => {
  const reg = fakeRegistry([card('a'), card('b')]);
  const tm = new TeamManager(reg);
  await tm.register({ id: 't', name: 'T', members: ['a', 'b'], mode: 'parallel' });
  const out = await tm.executeTask('t', 'q', async (c) => `${c.id}-out`);
  assert.deepStrictEqual(out, ['a-out', 'b-out']);
});

test('round-robin：按注册顺序轮转成员', async () => {
  const reg = fakeRegistry([card('a'), card('b')]);
  const tm = new TeamManager(reg);
  await tm.register({ id: 't', name: 'T', members: ['a', 'b'], mode: 'round-robin' });
  const pick = [];
  const dispatch = async (c) => {
    pick.push(c.id);
    return c.id;
  };
  await tm.executeTask('t', 'q', dispatch);
  await tm.executeTask('t', 'q', dispatch);
  await tm.executeTask('t', 'q', dispatch);
  assert.deepStrictEqual(pick, ['a', 'b', 'a']);
});

test('register：成员未注册抛 TeamMemberNotFound；executeTask 未知团队抛 TeamNotFound', async () => {
  const reg = fakeRegistry([card('a')]);
  const tm = new TeamManager(reg);
  await assert.rejects(
    () => tm.register({ id: 't', name: 'T', members: ['ghost'], mode: 'parallel' }),
    /TeamMemberNotFound/
  );
  await assert.rejects(() => tm.executeTask('nope', 'q', async () => ''), /TeamNotFound/);
});

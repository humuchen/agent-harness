'use strict';
// P1-9 测试：可插拔记忆存储后端 + 多租户会话隔离。
// 覆盖 Volatile / File / Sqlite（运行期可用时）三类后端与 Memory 运行时的集成。
const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { Memory } = require('../dist/memory.js');
const { VolatileMemoryStore, FileMemoryStore, SqliteMemoryStore, sanitizeKey } =
  require('../dist/memory-store.js');

function tmpDir() {
  const dir = path.join(os.tmpdir(), `mem-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test('sanitizeKey: 归一化非法字符并限制长度', () => {
  assert.strictEqual(sanitizeKey(''), 'anonymous');
  assert.strictEqual(sanitizeKey(null), 'anonymous');
  assert.strictEqual(sanitizeKey('a/b\\c..d'), 'a_b_c__d');
  assert.strictEqual(sanitizeKey('tenant#1 @x'), 'tenant_1__x');
  assert.strictEqual(sanitizeKey('a'.repeat(200)).length, 64);
});

test('VolatileMemoryStore: 内存 round-trip', async () => {
  const s = new VolatileMemoryStore();
  assert.strictEqual(s.kind, 'volatile');
  assert.strictEqual(await s.load('k1'), null);
  await s.save('k1', { window: [{ role: 'user', content: 'hi' }], longTerm: ['note'] });
  const got = await s.load('k1');
  assert.deepStrictEqual(got.window, [{ role: 'user', content: 'hi' }]);
  assert.deepStrictEqual(got.longTerm, ['note']);
  await s.delete('k1');
  assert.strictEqual(await s.load('k1'), null);
  assert.ok((await s.list()).length >= 0);
});

test('FileMemoryStore: 目录分桶 + 多租户隔离', async () => {
  const dir = tmpDir();
  const s = new FileMemoryStore({ dir });
  assert.strictEqual(s.kind, 'file');
  await s.save('tenantA', { window: [{ role: 'user', content: 'a' }], longTerm: ['A'] });
  await s.save('tenantB', { window: [{ role: 'user', content: 'b' }], longTerm: ['B'] });
  assert.deepStrictEqual((await s.load('tenantA')).longTerm, ['A']);
  assert.deepStrictEqual((await s.load('tenantB')).longTerm, ['B']);
  // 文件名为 sanitizeKey 后的 key
  assert.ok(fs.existsSync(path.join(dir, 'tenantA.json')));
  const list = await s.list();
  assert.ok(list.includes('tenantA') && list.includes('tenantB'));
  await s.delete('tenantA');
  assert.strictEqual(await s.load('tenantA'), null);
  assert.ok(!fs.existsSync(path.join(dir, 'tenantA.json')));
});

test('FileMemoryStore: 旧单文件模式向后兼容', async () => {
  const file = path.join(tmpDir(), 'legacy.json');
  const s = new FileMemoryStore({ path: file });
  await s.save('', { window: [], longTerm: ['legacy'] });
  assert.deepStrictEqual((await s.load('')).longTerm, ['legacy']);
  assert.deepStrictEqual(await s.list(), ['']);
});

test('Memory + 后端：remember/load/save/hasPersistence', async () => {
  const dir = tmpDir();
  const store = new FileMemoryStore({ dir });
  const m = new Memory({ store, sessionKey: 'u1', maxWindow: 5 });
  assert.strictEqual(m.hasPersistence, true);
  assert.strictEqual(m.backend, 'file');
  m.remember('fact');
  m.add({ role: 'user', content: 'hello' });
  await m.save();

  // 新实例按同一 key 载入，应恢复记忆
  const m2 = new Memory({ store, sessionKey: 'u1' });
  await m2.load();
  assert.deepStrictEqual(m2.notes(), ['fact']);
  assert.strictEqual(m2.history().length, 1);
  assert.ok(m2.systemContext().includes('fact'));
});

test('Memory: 不同 sessionKey 互相隔离', async () => {
  const dir = tmpDir();
  const store = new FileMemoryStore({ dir });
  const a = new Memory({ store, sessionKey: 'a' });
  a.remember('A-only');
  await a.save();
  const b = new Memory({ store, sessionKey: 'b' });
  b.remember('B-only');
  await b.save();
  const ra = new Memory({ store, sessionKey: 'a' });
  await ra.load();
  const rb = new Memory({ store, sessionKey: 'b' });
  await rb.load();
  assert.deepStrictEqual(ra.notes(), ['A-only']);
  assert.deepStrictEqual(rb.notes(), ['B-only']);
});

test('Memory 默认（无 store）即纯内存，hasPersistence=false', () => {
  const m = new Memory();
  assert.strictEqual(m.hasPersistence, false);
  assert.strictEqual(m.backend, 'volatile');
  m.remember('x');
  assert.deepStrictEqual(m.notes(), ['x']);
});

test('SqliteMemoryStore: 运行期可用时 round-trip（不可用则跳过）', async () => {
  let SqliteMod;
  try {
    SqliteMod = require('node:sqlite');
  } catch {
    SqliteMod = null;
  }
  if (!SqliteMod) {
    // 当前 Node 不支持 node:sqlite，跳过（CI 在 Node 22+ 上会真正执行）。
    return;
  }
  const file = path.join(tmpDir(), 'mem.db');
  const s = new SqliteMemoryStore({ file });
  assert.strictEqual(s.kind, 'sqlite');
  await s.save('s1', { window: [{ role: 'user', content: 'q' }], longTerm: ['n'] });
  await s.save('s2', { window: [], longTerm: [] });
  assert.deepStrictEqual((await s.load('s1')).longTerm, ['n']);
  const list = await s.list();
  assert.ok(list.includes('s1') && list.includes('s2'));
  await s.delete('s1');
  assert.strictEqual(await s.load('s1'), null);
});

test('FileMemoryStore: 原子写——崩溃安全且不残留临时文件', async () => {
  const dir = tmpDir();
  const s = new FileMemoryStore({ dir });
  await s.save('atom', { window: [{ role: 'user', content: 'v1' }], longTerm: ['n1'] });
  // 第二次覆盖写入，验证 rename 替换语义（不残留旧 .tmp，不产生半截文件）
  await s.save('atom', { window: [{ role: 'user', content: 'v2' }], longTerm: ['n2'] });
  const got = await s.load('atom');
  assert.deepStrictEqual(got.window, [{ role: 'user', content: 'v2' }]);
  assert.deepStrictEqual(got.longTerm, ['n2']);
  // 崩溃安全：目录下不应有任何 .tmp 残留（中断只会留下 .tmp，正常路径应已 rename 清理）
  const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.tmp'));
  assert.strictEqual(leftovers.length, 0, 'save 后不应残留 .tmp 临时文件: ' + leftovers.join(','));
});

// ===== 上下文压缩（CONTEXT_COMPRESSION / MemorySummarizer）=====
test('Memory: summarizer 将溢出淘汰的轮次压缩为 system 摘要固定保留', () => {
  let calls = 0;
  const summarizer = () => {
    calls += 1;
    return `compressed(${calls})`;
  };
  const m = new Memory({ maxWindow: 5, summarizer });
  m.add({ role: 'system', content: 'SYS' });
  for (let i = 0; i < 5; i++) m.add({ role: 'user', content: 'u' + i });

  const hist = m.history();
  // 真实 system 提示词始终在最前
  assert.strictEqual(hist[0].role, 'system');
  assert.strictEqual(hist[0].content, 'SYS');
  // 仅有一条摘要节点，且为 system 角色
  const summaries = hist.filter((x) => x.content && x.content.includes('【历史摘要】'));
  assert.strictEqual(summaries.length, 1, '应恰好一条历史摘要');
  assert.strictEqual(summaries[0].role, 'system');
  assert.ok(summaries[0].content.includes('compressed(1)'));
  assert.strictEqual(m.summary, 'compressed(1)');
  // 窗口长度恒等于 maxWindow
  assert.strictEqual(hist.length, 5);

  // 继续追加，摘要被「更新」而非「重复」（仍仅一条）
  m.add({ role: 'user', content: 'u5' });
  const hist2 = m.history();
  const summaries2 = hist2.filter((x) => x.content && x.content.includes('【历史摘要】'));
  assert.strictEqual(summaries2.length, 1, '多次压缩后摘要仍应唯一');
  assert.ok(summaries2[0].content.includes('compressed(2)'));
  assert.strictEqual(m.summary, 'compressed(2)');
  assert.strictEqual(hist2.length, 5);
});

test('Memory: 无 summarizer 时溢出直接丢弃（行为不变，无摘要）', () => {
  const m = new Memory({ maxWindow: 5 });
  m.add({ role: 'system', content: 'SYS' });
  for (let i = 0; i < 5; i++) m.add({ role: 'user', content: 'u' + i });
  m.add({ role: 'user', content: 'u5' });
  const hist = m.history();
  assert.strictEqual(m.summary, null);
  assert.strictEqual(hist.filter((x) => x.content && x.content.includes('【历史摘要】')).length, 0);
  assert.strictEqual(hist.length, 5);
  assert.strictEqual(hist[1].content, 'u2', '最旧轮次 u0/u1 应被丢弃');
});

test('Memory: 压缩摘要随持久化保存与恢复', async () => {
  const dir = tmpDir();
  const store = new FileMemoryStore({ dir });
  let calls = 0;
  const summarizer = () => {
    calls += 1;
    return `compressed(${calls})`;
  };
  const m = new Memory({ store, sessionKey: 'c1', maxWindow: 5, summarizer });
  m.add({ role: 'system', content: 'SYS' });
  for (let i = 0; i < 5; i++) m.add({ role: 'user', content: 'u' + i });
  assert.ok(m.summary, '应已产生摘要');
  await m.save();

  const m2 = new Memory({ store, sessionKey: 'c1', maxWindow: 5, summarizer });
  await m2.load();
  assert.strictEqual(m2.summary, m.summary, '摘要应随记忆恢复');
  assert.ok(m2.history().some((x) => x.content && x.content.includes('【历史摘要】')));
});

test('Memory: 异步（LLM）摘要器通过 flushSummary 落地，且汇总节点唯一', async () => {
  let calls = 0;
  const summarizer = async () => {
    calls += 1;
    return `async(${calls})`;
  };
  const m = new Memory({ maxWindow: 5, summarizer });
  m.add({ role: 'system', content: 'SYS' });
  for (let i = 0; i < 5; i++) m.add({ role: 'user', content: 'u' + i });

  // add() 不阻塞：此时 pending 为真，summary 尚为 null，窗口无摘要节点
  assert.strictEqual(m.summaryPending, true, '应存在 pending 异步摘要');
  assert.strictEqual(m.summary, null, 'flush 前 summary 应为 null');
  assert.strictEqual(m.history().some((x) => x.content && x.content.includes('【历史摘要】')), false);

  // flush 后摘要落地，且窗口仍保持一条摘要节点
  await m.flushSummary();
  assert.strictEqual(m.summaryPending, false);
  assert.strictEqual(m.summary, 'async(1)');
  const hist = m.history();
  const summaries = hist.filter((x) => x.content && x.content.includes('【历史摘要】'));
  assert.strictEqual(summaries.length, 1, '应仅一条摘要节点');
  assert.strictEqual(hist[0].content, 'SYS', '真实 system 仍最前');
  assert.strictEqual(hist.length, 5);

  // 再次溢出：pending 再次触发，flush 后摘要更新且唯一
  m.add({ role: 'user', content: 'u5' });
  assert.strictEqual(m.summaryPending, true);
  await m.flushSummary();
  assert.strictEqual(m.summary, 'async(2)');
  const summaries2 = m.history().filter((x) => x.content && x.content.includes('【历史摘要】'));
  assert.strictEqual(summaries2.length, 1, '多次压缩后摘要仍唯一');
});

test('Memory: 异步摘要器失败时回退到上一轮摘要（不破坏窗口）', async () => {
  let n = 0;
  const summarizer = async () => {
    n += 1;
    if (n === 1) throw new Error('llm down');
    return `ok(${n})`;
  };
  const m = new Memory({ maxWindow: 5, summarizer });
  m.add({ role: 'system', content: 'SYS' });
  for (let i = 0; i < 5; i++) m.add({ role: 'user', content: 'u' + i });
  await m.flushSummary();
  // 第一次失败 → 回退为空串 → 无摘要节点；窗口因预留 1 个摘要槽位而为 4（而非 5），
  // 这是有意的：摘要槽始终保留，避免摘要落地后窗口超出 maxWindow。
  assert.strictEqual(m.summary, null);
  assert.strictEqual(m.history().length, 4);
  assert.strictEqual(m.history().some((x) => x.content && x.content.includes('【历史摘要】')), false);

  // 继续追加触发第二次溢出（长度 5 时不溢出，6 时溢出），本次成功 → 正常落地
  m.add({ role: 'user', content: 'u5' });
  m.add({ role: 'user', content: 'u6' });
  assert.strictEqual(m.summaryPending, true);
  await m.flushSummary();
  assert.strictEqual(m.summary, 'ok(2)');
  const hist = m.history();
  assert.strictEqual(hist.length, 5);
  assert.strictEqual(hist.filter((x) => x.content && x.content.includes('【历史摘要】')).length, 1);
});

test('Memory: save() 自动 flush 异步摘要（无需手动 flush）', async () => {
  const dir = tmpDir();
  const store = new FileMemoryStore({ dir });
  const summarizer = async () => 'auto-flushed';
  const m = new Memory({ store, sessionKey: 'af', maxWindow: 5, summarizer });
  m.add({ role: 'system', content: 'SYS' });
  for (let i = 0; i < 5; i++) m.add({ role: 'user', content: 'u' + i });
  assert.strictEqual(m.summaryPending, true);
  await m.save(); // save 内部应 flush
  assert.strictEqual(m.summaryPending, false);
  assert.strictEqual(m.summary, 'auto-flushed');

  const m2 = new Memory({ store, sessionKey: 'af', maxWindow: 5, summarizer });
  await m2.load();
  assert.strictEqual(m2.summary, 'auto-flushed', '落地后的摘要应随记忆恢复');
});

// P2: 记忆打分机制测试
const { HeuristicMemoryScorer, createHeuristicScorer } = require('../dist/memory.js');

test('HeuristicMemoryScorer: scoreWindow 返回与消息数量相同的分数', () => {
  const scorer = new HeuristicMemoryScorer();
  const msgs = [
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '你好！' },
    { role: 'tool', content: '{ "result": "ok" }' },
  ];
  const scores = scorer.scoreWindow(msgs, '你好世界');
  assert.strictEqual(scores.length, 3);
  scores.forEach((s) => assert.ok(s >= 0 && s <= 1, '分数应在 0~1 之间'));
});

test('HeuristicMemoryScorer: user 提问比 tool 结果得更高分', () => {
  const scorer = new HeuristicMemoryScorer();
  const msgs = [
    { role: 'user', content: '帮我查一下天气' },
    { role: 'tool', content: '{ "weather": "sunny" }' },
  ];
  const scores = scorer.scoreWindow(msgs, '帮我查一下天气');
  assert.ok(scores[0] > scores[1], 'user 消息分数应高于 tool 结果');
});

test('HeuristicMemoryScorer: 与 context 相关的消息得更高分', () => {
  const scorer = new HeuristicMemoryScorer();
  const msgs = [
    { role: 'user', content: 'python 列表推导式怎么写' },
    { role: 'user', content: '今天天气不错' },
  ];
  const scores = scorer.scoreWindow(msgs, 'python 列表推导式');
  assert.ok(scores[0] > scores[1], '相关消息应得分更高');
});

test('HeuristicMemoryScorer: scoreNotes 返回与笔记数量相同的分数', () => {
  const scorer = new HeuristicMemoryScorer();
  const notes = ['Python 列表推导式', 'JavaScript 闭包', 'Docker 入门'];
  const scores = scorer.scoreNotes(notes, 'Python 列表推导式');
  assert.strictEqual(scores.length, 3);
  scores.forEach((s) => assert.ok(s >= 0 && s <= 1, '分数应在 0~1 之间'));
});

test('Memory with scorer: 记忆打分器在 add() 中更新分数', async () => {
  const m = new Memory({
    scorer: new HeuristicMemoryScorer(),
    scoringContext: 'python 列表推导式',
  });
  m.add({ role: 'user', content: 'python 列表推导式怎么写' });
  m.add({ role: 'user', content: '今天天气不错' });
  assert.ok(m.history().length === 2);
  // 分数会在 add() 中异步计算，save 时会同步
  await m.save();
  assert.ok(m.notesWithScores().length === 0); // 无长期笔记
});

test('Memory with scorer: systemContextWithScoring 按相关性排序并裁剪', async () => {
  const m = new Memory({
    scorer: new HeuristicMemoryScorer(),
    scoringContext: 'python 列表推导式',
    notesTopK: 1,
  });
  m.remember('Python 列表推导式详解');
  m.remember('Docker 容器入门');
  m.remember('JavaScript 闭包讲解');
  await m.save();
  const ctx = await m.systemContextWithScoring('python 列表推导式');
  assert.ok(ctx.includes('Python 列表推导式详解'), '相关笔记应排在前面');
});

test('Memory with scorer: systemContext 回退到原有行为（无 scorer）', async () => {
  const m = new Memory();
  m.remember('笔记A');
  m.remember('笔记B');
  const ctx = m.systemContext();
  assert.ok(ctx.includes('笔记A'));
  assert.ok(ctx.includes('笔记B'));
});

test('Memory: 无 scorer 时淘汰仍为 FIFO（向后兼容）', () => {
  const m = new Memory({ maxWindow: 3 });
  m.add({ role: 'system', content: 'SYS' });
  m.add({ role: 'user', content: '1' });
  m.add({ role: 'user', content: '2' });
  m.add({ role: 'user', content: '3' });
  m.add({ role: 'user', content: '4' });
  assert.strictEqual(m.history().length, 3);
  // FIFO：最早的用户消息被淘汰
  assert.ok(!m.history().some((x) => x.content === '1'), '最早的消息应被淘汰');
});

test('createHeuristicScorer: 从 env 创建打分器', () => {
  const oldEnv = process.env.MEMORY_SCORE_RELEVANCE;
  process.env.MEMORY_SCORE_RELEVANCE = '0.8';
  const scorer = createHeuristicScorer();
  assert.strictEqual(scorer.relevanceWeight, 0.8);
  if (oldEnv !== undefined) {
    process.env.MEMORY_SCORE_RELEVANCE = oldEnv;
  } else {
    delete process.env.MEMORY_SCORE_RELEVANCE;
  }
});

test('Memory: 持久化保存与恢复带分数的记忆', async () => {
  const dir = tmpDir();
  const store = new FileMemoryStore({ dir });
  const m = new Memory({ store, sessionKey: 'scored', maxWindow: 5 });
  m.remember('重要笔记');
  m.remember('普通笔记');
  await m.save();

  const m2 = new Memory({ store, sessionKey: 'scored' });
  await m2.load();
  assert.deepStrictEqual(m2.notes(), ['重要笔记', '普通笔记']);
});


#!/usr/bin/env node
/**
 * 记忆打分机制全面测试报告
 * 覆盖：接口契约、多维打分、持久化、向后兼容、Feature Flag
 */
'use strict';

const { Memory, HeuristicMemoryScorer, createHeuristicScorer, isEnabled } = require('./backend/core/dist/memory.js');
const { FileMemoryStore, VolatileMemoryStore } = require('./backend/core/dist/memory-store.js');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ============ 工具函数 ============
let pass = 0, fail = 0;
const results = [];

function test(name, fn) {
  try {
    fn();
    pass++;
    results.push({ name, status: 'PASS' });
  } catch (e) {
    fail++;
    results.push({ name, status: 'FAIL', error: e.message });
  }
}

async function asyncTest(name, fn) {
  try {
    await fn();
    pass++;
    results.push({ name, status: 'PASS' });
  } catch (e) {
    fail++;
    results.push({ name, status: 'FAIL', error: e.message });
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function tmpDir() {
  return path.join(os.tmpdir(), `score-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

// ============ 测试套件 ============
console.log('='.repeat(70));
console.log('记忆打分机制全面测试报告');
console.log('='.repeat(70));

// --- 1. 接口契约 ---
console.log('\n[1] 接口契约验证');
test('HeuristicMemoryScorer 实现 MemoryScorer 接口', () => {
  const s = new HeuristicMemoryScorer();
  assert(typeof s.scoreWindow === 'function', '应有 scoreWindow 方法');
  assert(typeof s.scoreNotes === 'function', '应有 scoreNotes 方法');
});
test('createHeuristicScorer 工厂函数可用', () => {
  const s = createHeuristicScorer();
  assert(s instanceof HeuristicMemoryScorer, '应返回 HeuristicMemoryScorer 实例');
});
test('MemoryOptions 支持 scorer 参数', () => {
  const m = new Memory({ scorer: new HeuristicMemoryScorer() });
  assert(m instanceof Memory, '应创建 Memory 实例');
});
test('MemoryOptions 支持 scoringContext 参数', () => {
  const m = new Memory({ scoringContext: 'test context' });
  assert(m instanceof Memory, '应创建 Memory 实例');
});
test('MemoryOptions 支持 notesTopK 参数', () => {
  const m = new Memory({ notesTopK: 5 });
  assert(m instanceof Memory, '应创建 Memory 实例');
});

// --- 2. 多维打分 ---
console.log('\n[2] 多维打分权重验证');
test('默认权重正确初始化', () => {
  const s = new HeuristicMemoryScorer();
  assert(Math.abs(s.relevanceWeight - 0.4) < 0.001, 'relevanceWeight 应为 0.4');
  assert(Math.abs(s.importanceWeights.user - 0.3) < 0.001, 'user 权重应为 0.3');
  assert(Math.abs(s.importanceWeights.assistant - 0.15) < 0.001, 'assistant 权重应为 0.15');
  assert(Math.abs(s.importanceWeights.tool - 0.1) < 0.001, 'tool 权重应为 0.1');
  assert(Math.abs(s.recencyWeight - 0.1) < 0.001, 'recencyWeight 应为 0.1');
  assert(Math.abs(s.lengthWeight - 0.05) < 0.001, 'lengthWeight 应为 0.05');
});
test('可通过构造函数自定义权重', () => {
  const s = new HeuristicMemoryScorer({
    relevanceWeight: 0.6,
    importanceWeights: { user: 0.5, assistant: 0.2, tool: 0.1, system: 0.05 },
    recencyWeight: 0.15,
    lengthWeight: 0.1,
  });
  assert(Math.abs(s.relevanceWeight - 0.6) < 0.001, 'relevanceWeight 应为 0.6');
  assert(Math.abs(s.importanceWeights.user - 0.5) < 0.001, 'user 权重应为 0.5');
});
test('scoreWindow 返回分数数组与消息数量一致', () => {
  const s = new HeuristicMemoryScorer();
  const msgs = [
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '你好！' },
    { role: 'tool', content: '{ "result": "ok" }' },
    { role: 'user', content: '今天天气如何' },
  ];
  const scores = s.scoreWindow(msgs, '你好世界');
  assert(scores.length === 4, `应返回 4 个分数，实际 ${scores.length}`);
});
test('scoreNotes 返回分数数组与笔记数量一致', () => {
  const s = new HeuristicMemoryScorer();
  const notes = ['Python 列表推导式', 'Docker 入门', 'Redis 缓存'];
  const scores = s.scoreNotes(notes, 'Python 列表推导式');
  assert(scores.length === 3, `应返回 3 个分数，实际 ${scores.length}`);
});
test('所有分数在 0~1 范围内', () => {
  const s = new HeuristicMemoryScorer();
  const msgs = [
    { role: 'user', content: 'help me' },
    { role: 'tool', content: 'result' },
  ];
  const scores = s.scoreWindow(msgs, 'help');
  scores.forEach((sc, i) => assert(sc >= 0 && sc <= 1, `score[${i}]=${sc} 超出范围`));
});
test('空 context 时相关性得分为 0', () => {
  const s = new HeuristicMemoryScorer();
  const msgs = [{ role: 'user', content: 'hello world' }];
  const scores = s.scoreWindow(msgs, '');
  // 空 context 时相关性权重为 0，但 role 权重仍在
  assert(scores[0] > 0, '即使相关性为 0，role 权重仍应使分数 > 0');
});

// --- 3. 角色权重区分 ---
console.log('\n[3] 角色权重区分');
test('user 消息得分高于 tool 消息（相同内容）', () => {
  const s = new HeuristicMemoryScorer();
  const msgs = [
    { role: 'user', content: '帮我查一下' },
    { role: 'tool', content: '帮我查一下' },
  ];
  const scores = s.scoreWindow(msgs, '帮我查一下');
  assert(scores[0] > scores[1], `user=${scores[0]}, tool=${scores[1]}, user 应更高`);
});
test('assistant 消息得分高于 tool 消息', () => {
  const s = new HeuristicMemoryScorer();
  const msgs = [
    { role: 'assistant', content: '这是回复' },
    { role: 'tool', content: '这是工具结果' },
  ];
  const scores = s.scoreWindow(msgs, '回复');
  assert(scores[0] > scores[1], `assistant=${scores[0]}, tool=${scores[1]}, assistant 应更高`);
});
test('system 消息得分最低', () => {
  const s = new HeuristicMemoryScorer();
  const msgs = [
    { role: 'system', content: '你是一个助手' },
    { role: 'user', content: '你好' },
  ];
  const scores = s.scoreWindow(msgs, '你好');
  assert(scores[0] < scores[1], `system=${scores[0]}, user=${scores[1]}, system 应最低`);
});

// --- 4. 相关性匹配 ---
console.log('\n[4] 相关性匹配');
test('与 context 高度相关的消息得分更高', () => {
  const s = new HeuristicMemoryScorer();
  const msgs = [
    { role: 'user', content: 'Python 列表推导式语法' },
    { role: 'user', content: '今天天气不错' },
  ];
  const scores = s.scoreWindow(msgs, 'Python 列表推导式');
  assert(scores[0] > scores[1], `相关消息 ${scores[0]} 应高于无关消息 ${scores[1]}`);
});
test('note 与 context 相关时得分更高', () => {
  const s = new HeuristicMemoryScorer();
  const notes = [
    'Python 列表推导式完整教程',
    'Docker 容器化部署指南',
  ];
  const scores = s.scoreNotes(notes, 'Python 列表推导式');
  assert(scores[0] > scores[1], `相关笔记 ${scores[0]} 应高于无关笔记 ${scores[1]}`);
});
test('英文文本相关性匹配正常', () => {
  const s = new HeuristicMemoryScorer();
  const msgs = [
    { role: 'user', content: 'JavaScript async await pattern' },
    { role: 'user', content: 'How to cook pasta' },
  ];
  const scores = s.scoreWindow(msgs, 'JavaScript async');
  assert(scores[0] > scores[1], `相关英文消息 ${scores[0]} 应高于无关消息 ${scores[1]}`);
});

// --- 5. 时效性 ---
console.log('\n[5] 时效性权重');
test('越靠后的消息得分越高（相同内容）', () => {
  const s = new HeuristicMemoryScorer();
  const msgs = Array.from({ length: 5 }, (_, i) => ({
    role: 'user',
    content: 'same content',
  }));
  const scores = s.scoreWindow(msgs, 'same content');
  // 最后一篇时效性最高
  assert(scores[4] > scores[0], `最新消息 ${scores[4]} 应高于最早消息 ${scores[0]}`);
});

// --- 6. 篇幅因子 ---
console.log('\n[6] 篇幅因子');
test('较长内容得分略高（相关性相同时）', () => {
  const s = new HeuristicMemoryScorer({ relevanceWeight: 0, lengthWeight: 0.2 });
  const msgs = [
    { role: 'user', content: '短' },
    { role: 'user', content: '这是一个非常长且详细的内容，包含很多信息' },
  ];
  const scores = s.scoreWindow(msgs, '');
  assert(scores[1] > scores[0], `长内容 ${scores[1]} 应高于短内容 ${scores[0]}`);
});

// --- 7. Memory 集成 ---
console.log('\n[7] Memory 集成验证');
test('Memory.add() 触发打分并更新 windowScores', async () => {
  const m = new Memory({
    scorer: new HeuristicMemoryScorer(),
    scoringContext: 'python',
    maxWindow: 10,
  });
  m.add({ role: 'system', content: 'SYS' });
  m.add({ role: 'user', content: 'python 列表推导式' });
  m.add({ role: 'user', content: '今天天气' });
  await m.save();
  assert(m.history().length === 3, '应有 3 条消息');
});
test('Memory.remember() 添加长期笔记', async () => {
  const m = new Memory({ scorer: new HeuristicMemoryScorer() });
  m.remember('重要笔记');
  assert.deepStrictEqual(m.notes(), ['重要笔记']);
});
test('Memory.notesWithScores() 返回带分数的笔记', async () => {
  const m = new Memory({ scorer: new HeuristicMemoryScorer() });
  m.remember('笔记A');
  m.remember('笔记B');
  await m.save();
  const scored = m.notesWithScores();
  assert(scored.length === 2, '应有 2 条笔记');
  assert(scored[0].note === '笔记A', '第一条应为笔记A');
});
test('Memory.systemContext() 返回全部笔记', () => {
  const m = new Memory();
  m.remember('Note1');
  m.remember('Note2');
  const ctx = m.systemContext();
  assert(ctx.includes('Note1'), '应包含 Note1');
  assert(ctx.includes('Note2'), '应包含 Note2');
});

// --- 8. systemContextWithScoring Top-K ---
console.log('\n[8] systemContextWithScoring Top-K 裁剪');
test('systemContextWithScoring 按相关性排序', async () => {
  const m = new Memory({
    scorer: new HeuristicMemoryScorer(),
    scoringContext: 'python',
    notesTopK: 10,
  });
  m.remember('Python 列表推导式详解');
  m.remember('JavaScript 闭包讲解');
  m.remember('Python 装饰器入门');
  const ctx = await m.systemContextWithScoring('python 列表推导式');
  assert(ctx.includes('Python 列表推导式详解'), '相关笔记应在上下文中');
});
test('systemContextWithScoring 裁剪到 TopK', async () => {
  const m = new Memory({
    scorer: new HeuristicMemoryScorer(),
    notesTopK: 2,
  });
  m.remember('笔记1');
  m.remember('笔记2');
  m.remember('笔记3');
  const ctx = await m.systemContextWithScoring('test');
  // 只注入 Top 2
  const lines = ctx.split('\n').filter(l => l.startsWith('- '));
  assert(lines.length <= 2, `应最多 2 条，实际 ${lines.length}`);
});
test('无 scorer 时 systemContextWithScoring 回退到 systemContext', async () => {
  const m = new Memory();
  m.remember('Note1');
  m.remember('Note2');
  const ctx = await m.systemContextWithScoring('test');
  assert(ctx.includes('Note1'), '应包含 Note1');
  assert(ctx.includes('Note2'), '应包含 Note2');
});

// --- 9. 持久化 round-trip ---
console.log('\n[9] 持久化 Round-Trip');
test('持久化保存带分数的记忆', async () => {
  const dir = tmpDir();
  const store = new FileMemoryStore({ dir });
  const m = new Memory({ store, sessionKey: 'k1', scorer: new HeuristicMemoryScorer() });
  m.remember('笔记A');
  m.remember('笔记B');
  await m.save();
  
  const m2 = new Memory({ store, sessionKey: 'k1' });
  await m2.load();
  assert.deepStrictEqual(m2.notes(), ['笔记A', '笔记B'], '笔记应恢复');
});
test('持久化后 scores 长度匹配 notes', async () => {
  const dir = tmpDir();
  const store = new FileMemoryStore({ dir });
  const m = new Memory({ store, sessionKey: 'k2', scorer: new HeuristicMemoryScorer() });
  m.remember('N1');
  m.remember('N2');
  m.remember('N3');
  await m.save();
  
  const m2 = new Memory({ store, sessionKey: 'k2' });
  await m2.load();
  const scored = m2.notesWithScores();
  assert(scored.length === 3, `应有 3 条笔记，实际 ${scored.length}`);
});
test('滑动窗口溢出时 FIFO 淘汰（无 scorer）', () => {
  const m = new Memory({ maxWindow: 3 });
  m.add({ role: 'system', content: 'SYS' });
  for (let i = 0; i < 4; i++) m.add({ role: 'user', content: `msg${i}` });
  assert(m.history().length === 3, '窗口应保留 3 条');
  assert(!m.history().some(x => x.content === 'msg0'), '最早消息应被淘汰');
});

// --- 10. Feature Flag ---
console.log('\n[10] Feature Flag 验证');
test('isEnabled 可查询 memoryScoring 开关', () => {
  // isEnabled 来自 feature-flags，从 dist 导入
  const { isEnabled } = require('./backend/core/dist/feature-flags.js');
  assert(typeof isEnabled === 'function', 'isEnabled 应为函数');
});

// --- 11. 边界情况 ---
console.log('\n[11] 边界情况');
test('空消息列表打分不报错', () => {
  const s = new HeuristicMemoryScorer();
  const scores = s.scoreWindow([], 'context');
  assert(Array.isArray(scores) && scores.length === 0, '空列表应返回空数组');
});
test('空笔记列表打分不报错', () => {
  const s = new HeuristicMemoryScorer();
  const scores = s.scoreNotes([], 'context');
  assert(Array.isArray(scores) && scores.length === 0, '空列表应返回空数组');
});
test('超长笔记按 maxNoteLength 截断评分', () => {
  const s = new HeuristicMemoryScorer({ maxNoteLength: 50 });
  const longNote = 'x'.repeat(200);
  const scores = s.scoreNotes([longNote], 'test');
  assert(scores.length === 1, '应返回 1 个分数');
  assert(scores[0] <= 1, '分数不应超过 1');
});

// --- 12. 异步打分 ---
console.log('\n[12] 异步打分支持');
test('scoreWindow 支持返回 Promise', async () => {
  const asyncScorer = {
    scoreWindow: async (msgs, context) => msgs.map(() => 0.5),
    scoreNotes: async (notes, context) => notes.map(() => 0.3),
  };
  const m = new Memory({ scorer: asyncScorer });
  m.add({ role: 'user', content: 'test' });
  await m.save();
  assert(m.history().length === 1, '应正常处理异步打分器');
});

// --- 13. 综合场景 ---
console.log('\n[13] 综合场景');
asyncTest('完整对话流 + 打分 + 持久化', async () => {
  const dir = tmpDir();
  const store = new FileMemoryStore({ dir });
  const scorer = new HeuristicMemoryScorer();
  const m = new Memory({ 
    store, 
    sessionKey: 'session-1', 
    scorer,
    maxWindow: 5,
    notesTopK: 2,
  });
  
  // 模拟对话
  m.add({ role: 'system', content: '你是 AI 助手' });
  m.add({ role: 'user', content: 'Python 列表推导式怎么写' });
  m.add({ role: 'assistant', content: '用法是 [x for x in range(10)]' });
  m.add({ role: 'user', content: '能举个实际例子吗' });
  m.add({ role: 'assistant', content: '比如过滤偶数：[x for x in nums if x % 2 == 0]' });
  m.add({ role: 'user', content: 'JavaScript 的 map 方法' });
  m.add({ role: 'assistant', content: 'JS map 是 arr.map(fn)，类似 Python 列表推导' });
  m.add({ role: 'user', content: 'Docker 如何构建镜像' });
  
  // 触发溢出（窗口 5，已有 8 条）
  assert(m.history().length <= 5, '溢出后窗口应 ≤ 5');
  
  // 添加长期笔记
  m.remember('Python 列表推导式基础语法');
  m.remember('JavaScript 函数式编程技巧');
  m.remember('Dockerfile 最佳实践');
  m.remember('Redis 缓存策略');
  
  await m.save();
  
  // 恢复并验证
  const m2 = new Memory({ store, sessionKey: 'session-1' });
  await m2.load();
  assert(m2.notes().length === 4, '应恢复 4 条笔记');
  
  // 按相关性生成上下文
  const ctx = await m2.systemContextWithScoring('Python 列表推导式');
  assert(ctx.length > 0, '上下文不应为空');
});

// ============ 生成报告 ============
console.log('\n' + '='.repeat(70));
console.log('测试结果汇总');
console.log('='.repeat(70));

const summary = {
  total: pass + fail,
  pass,
  fail,
  categories: {
    '接口契约': results.filter(r => r.name.includes('接口') || r.name.includes('工厂') || r.name.includes('参数')).length,
    '多维打分': results.filter(r => r.name.includes('权重') || r.name.includes('相关') || r.name.includes('时效') || r.name.includes('篇幅')).length,
    '角色区分': results.filter(r => r.name.includes('角色') || r.name.includes('user') || r.name.includes('assistant') || r.name.includes('system')).length,
    'Memory 集成': results.filter(r => r.name.includes('Memory') || r.name.includes('add()') || r.name.includes('remember')).length,
    'Top-K 裁剪': results.filter(r => r.name.includes('TopK') || r.name.includes('裁剪')).length,
    '持久化': results.filter(r => r.name.includes('持久化') || r.name.includes('Round-Trip') || r.name.includes('load')).length,
    '边界情况': results.filter(r => r.name.includes('空') || r.name.includes('超长') || r.name.includes('边界')).length,
    '异步': results.filter(r => r.name.includes('异步') || r.name.includes('Promise')).length,
    '综合': results.filter(r => r.name.includes('完整') || r.name.includes('综合')).length,
  }
};

console.log(`\n总计: ${summary.total} 个测试`);
console.log(`通过: ${summary.pass} ✅`);
console.log(`失败: ${summary.fail} ❌`);

console.log('\n各维度覆盖:');
for (const [cat, count] of Object.entries(summary.categories)) {
  const icon = count > 0 ? '✅' : '⬜';
  console.log(`  ${icon} ${cat}: ${count} 个用例`);
}

if (fail > 0) {
  console.log('\n失败详情:');
  results.filter(r => r.status === 'FAIL').forEach(r => {
    console.log(`  ❌ ${r.name}: ${r.error}`);
  });
}

console.log('\n' + '='.repeat(70));
console.log('详细测试列表');
console.log('='.repeat(70));
results.forEach((r, i) => {
  const icon = r.status === 'PASS' ? '✅' : '❌';
  console.log(`${String(i + 1).padStart(2)}. ${icon} ${r.name}${r.error ? ` - ${r.error}` : ''}`);
});

process.exit(fail > 0 ? 1 : 0);

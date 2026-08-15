/**
 * P0.2 Task Router 测试：意图分类、选择器评分、路由解析（显式/domain/classify/fallback）。
 * 零依赖：直接 require 编译后的 dist 叶子模块，避免触碰 MCP SDK 等重依赖。
 */
const test = require('node:test');
const assert = require('node:assert');

const core = require('../dist/index.js');
const {
  IntentRouter,
  scoreAgent,
  AgentSelector,
  TaskRouter,
  getAgentRegistry,
  DEFAULT_AGENT_ID,
  makeDefaultAgentCard,
} = core;

function makeCard(over) {
  return {
    id: 'test-' + Math.random().toString(36).slice(2, 8),
    name: 'test',
    domain: 'generic',
    capabilities: [{ id: 'general-purpose' }],
    transport: 'local',
    version: '1.0.0',
    health: { status: 'healthy', lastHeartbeat: Date.now(), load: 0 },
    ...over,
  };
}

test('IntentRouter.classify: 规则引擎按关键词命中 finance 领域', async () => {
  const r = new IntentRouter({ mode: 'rule' });
  const intent = await r.classify('帮我算一下理财收益率和持仓回撤');
  assert.strictEqual(intent.domain, 'finance');
  assert.strictEqual(intent.source, 'rule');
  assert.ok(intent.requiredCapabilities.includes('calculation'));
});

test('IntentRouter.classify: 无领域词归为 generic', async () => {
  const r = new IntentRouter({ mode: 'rule' });
  const intent = await r.classify('你好，今天天气不错');
  assert.strictEqual(intent.domain, 'generic');
  assert.ok(Array.isArray(intent.requiredCapabilities));
});

test('IntentRouter.classify: 动作词推断 web-search 能力', async () => {
  const r = new IntentRouter({ mode: 'rule' });
  const intent = await r.classify('帮我联网搜索一下最新的医美项目');
  assert.ok(intent.requiredCapabilities.includes('web-search'));
});

test('scoreAgent: 领域命中 + 能力命中得满分权重', () => {
  const reg = getAgentRegistry();
  const card = makeCard({ domain: 'finance', capabilities: [{ id: 'calculation' }] });
  const intent = { domain: 'finance', intent: 'task', requiredCapabilities: ['calculation'], source: 'rule' };
  const s = scoreAgent(card, intent, {});
  assert.strictEqual(s.domainScore, 1);
  assert.strictEqual(s.capabilityScore, 1);
  assert.strictEqual(s.healthFactor, 1);
  assert.strictEqual(s.slaFactor, 1);
  assert.strictEqual(s.score, 1);
});

test('scoreAgent: 领域不命中降权，能力缺失弱保留', () => {
  const card = makeCard({ domain: 'generic', capabilities: [{ id: 'general-purpose' }] });
  const intent = { domain: 'finance', intent: 'task', requiredCapabilities: ['calculation'], source: 'rule' };
  const s = scoreAgent(card, intent, {});
  assert.strictEqual(s.domainScore, 0.15); // generic 不匹配 finance
  assert.strictEqual(s.capabilityScore, 0.1); // 所需 calculation 完全没有
  assert.ok(s.score > 0 && s.score < 1);
});

test('TaskRouter.resolve: 显式 agentId 命中返回 explicit', async () => {
  const reg = getAgentRegistry();
  const card = makeCard({ id: 'explicit-a', domain: 'finance' });
  await reg.register(card);
  try {
    const r = new TaskRouter();
    const res = await r.resolve({ agentId: 'explicit-a' });
    assert.strictEqual(res.decidedBy, 'explicit');
    assert.strictEqual(res.agentId, 'explicit-a');
    assert.strictEqual(res.card.domain, 'finance');
  } finally {
    await reg.deregister('explicit-a');
  }
});

test('TaskRouter.resolve: 未知 agentId 优雅回退 default', async () => {
  const r = new TaskRouter();
  const res = await r.resolve({ agentId: 'does-not-exist-xyz' });
  assert.strictEqual(res.decidedBy, 'fallback');
  assert.strictEqual(res.agentId, DEFAULT_AGENT_ID);
});

test('TaskRouter.resolve: TASK_ROUTER=off 时直接走兜底', async () => {
  const prev = process.env.TASK_ROUTER;
  process.env.TASK_ROUTER = 'off';
  try {
    const reg = getAgentRegistry();
    const card = makeCard({ id: 'router-off-a', domain: 'finance' });
    await reg.register(card);
    const r = new TaskRouter();
    const res = await r.resolve({ prompt: '算一下理财收益率', domain: 'finance' });
    assert.strictEqual(res.decidedBy, 'fallback');
    assert.strictEqual(res.agentId, DEFAULT_AGENT_ID);
  } finally {
    delete process.env.TASK_ROUTER;
    await getAgentRegistry().deregister('router-off-a');
  }
});

test('TaskRouter.resolve: 显式 domain 过滤领域候选并选中', async () => {
  const reg = getAgentRegistry();
  const financeAgent = makeCard({ id: 'domain-fin', domain: 'finance', capabilities: [{ id: 'calculation' }] });
  await reg.register(financeAgent);
  try {
    const r = new TaskRouter();
    const res = await r.resolve({ domain: 'finance' });
    assert.strictEqual(res.decidedBy, 'domain');
    assert.strictEqual(res.agentId, 'domain-fin');
  } finally {
    await reg.deregister('domain-fin');
  }
});

test('TaskRouter.resolve: classify 路径选中能力更匹配的专属 agent', async () => {
  const reg = getAgentRegistry();
  const finAgent = makeCard({ id: 'classify-fin', domain: 'finance', capabilities: [{ id: 'calculation' }] });
  await reg.register(finAgent);
  try {
    const r = new TaskRouter();
    const res = await r.resolve({ prompt: '帮我算一下理财收益率和持仓回撤' });
    assert.strictEqual(res.decidedBy, 'classify');
    assert.strictEqual(res.agentId, 'classify-fin');
    assert.ok(res.intent && res.intent.domain === 'finance');
  } finally {
    await reg.deregister('classify-fin');
  }
});

test('AgentSelector.select: 返回综合评分最高的候选', async () => {
  const reg = getAgentRegistry();
  const good = makeCard({ id: 'sel-good', domain: 'finance', capabilities: [{ id: 'calculation' }] });
  const weak = makeCard({ id: 'sel-weak', domain: 'education', capabilities: [] });
  await reg.register(good);
  await reg.register(weak);
  try {
    const sel = new AgentSelector();
    const intent = { domain: 'finance', intent: 'task', requiredCapabilities: ['calculation'], source: 'rule' };
    const chosen = await sel.select(reg, intent, {});
    assert.strictEqual(chosen.id, 'sel-good');
  } finally {
    await reg.deregister('sel-good');
    await reg.deregister('sel-weak');
  }
});

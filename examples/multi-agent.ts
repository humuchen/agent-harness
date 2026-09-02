/**
 * 多 agent 协同集成冒烟（P0.1 + P0.2 + P0.3 串联）。
 *
 * 演示「把通用 harness 收敛为可路由的领域 agent」的完整闭环：
 *   1. 注册「金融」「医美」两个本地 agent（AgentCard，能力声明 + domain 标签）；
 *   2. 经 TaskRouter（resolveTask）按 domain / prompt 把任务分发到正确 agent；
 *   3. 验证租户隔离：不同 tenant 的记忆 key（tenantSessionKey）与护栏策略
 *      （PolicyEngine.getPolicy）物理隔离，金融与医美拿到不同的出网画像。
 *   4. 用 mock LLM 实际跑一轮，证明领域 harness 真的能执行（离线、无需密钥）。
 *
 * 运行：pnpm --filter @agent-harness/examples run multi-agent
 */
import {
  AgentHarness,
  ToolRegistry,
  getAgentRegistry,
  makeDefaultAgentCard,
  resolveTask,
  policyEngine,
  tenantSessionKey,
  type AgentCard,
  type LLM,
  type Message,
} from '@agent-harness/core';
import { loadEnv } from '@agent-harness/core';

loadEnv();

/** 离线 mock LLM：恒定返回完成文本，无需任何密钥即可驱动 harness 闭环。 */
const mockLLM: LLM = async (_messages: Message[]) => ({ content: '领域 agent 已处理该任务。', tool_calls: [] });

function financeAgent(): AgentCard {
  const base = makeDefaultAgentCard();
  return {
    ...base,
    id: 'finance-agent',
    name: '金融合规 Agent',
    domain: 'finance',
    description: '处理金融数据查询与合规校验。',
    capabilities: [{ id: 'finance-lookup' }, { id: 'compliance-check' }],
  };
}

function aestheticsAgent(): AgentCard {
  const base = makeDefaultAgentCard();
  return {
    ...base,
    id: 'aesthetics-agent',
    name: '医美顾问 Agent',
    domain: 'medical-aesthetics',
    description: '医美方案咨询与预约。',
    capabilities: [{ id: 'aesthetics-consult' }, { id: 'appointment-book' }],
  };
}

async function main(): Promise<void> {
  const registry = getAgentRegistry();
  await registry.register(financeAgent());
  await registry.register(aestheticsAgent());
  console.log('[multi-agent] 已注册 agent：', (await registry.list()).map((c) => `${c.id}@${c.domain}`).join(', '));

  // 1) 路由分发：金融诉求 → finance-agent；医美诉求 → aesthetics-agent。
  const r1 = await resolveTask({ domain: 'finance', prompt: '帮我查一下这只基金的净值' });
  const r2 = await resolveTask({ domain: 'medical-aesthetics', prompt: '我想咨询一下热玛吉方案' });
  console.log('[multi-agent] 金融 prompt 路由到：', r1?.agentId, `(decidedBy=${r1?.decidedBy})`);
  console.log('[multi-agent] 医美 prompt 路由到：', r2?.agentId, `(decidedBy=${r2?.decidedBy})`);
  if (r1?.agentId !== 'finance-agent' || r2?.agentId !== 'aesthetics-agent') {
    throw new Error('路由未按 domain 分发到正确的领域 agent');
  }

  // 2) 租户隔离：同一会话 key 在 tenantA / tenantB 下得到不同复合 key（记忆物理隔离）。
  const keyNoTenant = tenantSessionKey(null, 'sess-1');
  const keyA = tenantSessionKey({ id: 'tenantA' }, 'sess-1');
  const keyB = tenantSessionKey({ id: 'tenantB' }, 'sess-1');
  console.log('[multi-agent] 记忆 key：', JSON.stringify({ keyNoTenant, keyA, keyB }));
  if (keyA === keyB || keyA === keyNoTenant) {
    throw new Error('租户记忆 key 未隔离');
  }

  // 3) 护栏分区：先按行业域给两租户套用画像，再读取各自的出网/脱敏画像。
  policyEngine.applyIndustryProfile('finance-tenant', 'finance');
  policyEngine.applyIndustryProfile('aesthetics-tenant', 'medical-aesthetics');
  const polFinance = policyEngine.getPolicy('finance-tenant');
  const polAesthetic = policyEngine.getPolicy('aesthetics-tenant');
  console.log('[multi-agent] 金融 tenant 出网画像：', JSON.stringify(polFinance.network));
  console.log('[multi-agent] 医美 tenant 出网画像：', JSON.stringify(polAesthetic.network));
  if (JSON.stringify(polFinance.network) === JSON.stringify(polAesthetic.network)) {
    throw new Error('金融与医美 tenant 护栏画像未隔离');
  }

  // 4) 实际跑一轮：金融 agent 用 mock LLM 执行，证明领域 harness 可用（agentId 经构造器注入 run:meta）。
  const tools = new ToolRegistry();
  const harness = new AgentHarness({ llm: mockLLM, tools, agentId: 'finance-agent' });
  const final = await harness.run('查询基金净值');
  console.log('[multi-agent] finance-agent 实际执行结果：', final);
  console.log('[multi-agent] ✅ 多 agent 协同闭环验证通过');
}

main().catch((e) => {
  console.error('[multi-agent] 失败：', e);
  process.exit(1);
});

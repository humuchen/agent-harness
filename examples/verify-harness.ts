/**
 * 自包含验证 #2：Harness 客户端轮询逻辑。
 *
 * 不依赖任何真实 Harness 账户 —— 我们注入一个模拟的 `fetchImpl`，
 * 它扮演一个 Harness NG 后端：先返回 executionId，再在几次轮询后
 * 把状态从 RUNNING 切到 SUCCESS（或 FAILED），从而证明
 * 触发→抓取 executionId→状态轮询→终态判定 全链路正确。
 */
import { HarnessClient } from '@agent-harness/core';
import type { EphemeralEnvInput } from '@agent-harness/core';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// 模拟一个会随时间推进状态的 Harness 后端。
function fakeHarnessBackend(finalStatus: string) {
  let poll = 0;
  const statusSequence = ['RUNNING', 'RUNNING', finalStatus]; // 前两次 RUNNING，之后终态
  return (async (input: any, _init?: any): Promise<Response> => {
    const url = String(input);
    if (url.includes('/execute/')) {
      // 触发流水线 → 返回 executionId
      return jsonResponse({ pipelineExecutionId: 'exec-XYZ-789' });
    }
    if (url.includes('/executions/')) {
      const st = statusSequence[Math.min(poll++, statusSequence.length - 1)];
      // 模拟 Harness NG v2 的响应结构（statusPath 默认指向这里）
      return jsonResponse({ pipelineExecution: { summary: { status: st } } });
    }
    return jsonResponse({}, 404);
  }) as unknown as typeof fetch;
}

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error('❌ FAIL:', msg);
    process.exit(1);
  }
  console.log('✅', msg);
}

async function main() {
  console.log('\n=== 验证 #2: Harness 状态轮询 (SUCCESS 路径) ===');
  const client = new HarnessClient({
    apiKey: 'test-key',
    apiBase: 'https://harness.local',
    pollIntervalMs: 2,
    maxPolls: 20,
    dryRun: false,
    fetchImpl: fakeHarnessBackend('SUCCESS'),
  });

  const input: EphemeralEnvInput = { envType: 'ephemeral', branch: 'feature/login', ttlHours: 4 };
  const handle = await client.createEphemeralEnvironment(input);
  assert(handle.executionId === 'exec-XYZ-789', '触发后正确捕获 executionId');
  assert(handle.status === 'ready', `终态 SUCCESS 被正确映射为 ready (实际: ${handle.status})`);

  // getStatus 也应能独立读取状态
  const live = await client.getStatus('exec-XYZ-789');
  assert(live === 'SUCCESS', `getStatus 返回 ${live}`);

  // destroy 路径
  const destroyed = await client.destroyEnvironment({ envId: handle.envId });
  assert(destroyed.status === 'destroyed', `销毁后状态为 destroyed (实际: ${destroyed.status})`);

  console.log('\n=== 验证 #2: FAILED 路径 + 自定义 statusPath ===');
  // 用扁平 statusPath 模拟另一种 Harness 响应结构
  const client2 = new HarnessClient({
    apiKey: 'test-key',
    apiBase: 'https://harness.local',
    pollIntervalMs: 2,
    maxPolls: 20,
    dryRun: false,
    statusPath: 'status',
    doneStatuses: ['SUCCESS', 'FAILED'],
    fetchImpl: (async (input: any, _init?: any): Promise<Response> => {
      const url = String(input);
      if (url.includes('/execute/')) return jsonResponse({ executionId: 'exec-FAIL-1' });
      if (url.includes('/executions/')) return jsonResponse({ status: 'FAILED' });
      return jsonResponse({}, 404);
    }) as unknown as typeof fetch,
  });
  const failHandle = await client2.createEphemeralEnvironment(input);
  assert(failHandle.status === 'failed', `FAILED 被正确映射为 failed 且自定义 statusPath 生效 (实际: ${failHandle.status})`);

  console.log('\n🎉 #2 验证全部通过：触发→轮询→终态映射→自定义 statusPath 均正确。');
}

main().catch((e) => {
  console.error('验证异常:', e);
  process.exit(1);
});

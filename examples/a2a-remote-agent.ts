/**
 * 外部接入样例 ①：远端 A2A agent「入驻平台」。
 *
 * 演示：一个已经在其它主机/进程上运行、对外暴露 A2A HTTP 端点的行业 agent，
 * 如何以**纯声明式**（只给 PluginManifest，不出代码）入驻本平台 ——
 *   - transport: 'a2a' + endpoint 声明接入点；
 *   - 经 PluginLoader.install（declarative，无 PluginModule）登记；
 *   - enable 时把 manifest.capabilities 转成 AgentCard 注册进共享 Registry，
 *     于是被 TaskRouter 选中、被 A2A 派发，与本地 agent 走完全相同路径。
 *
 * 为可独立跑通（不依赖真实远端），本例就地起一个**桩 A2A 端点**，
 * 收到任务信封后回一个 JSON 结果，证明「注册 → 路由发现 → a2a.send 派发」链路。
 *
 * 运行：
 *   pnpm -r build
 *   pnpm --filter @agent-harness/examples run a2a-remote
 */

import http from 'node:http';
import { AddressInfo } from 'node:net';
import {
  PluginLoader,
  getAgentRegistry,
  type PluginManifest,
} from '@agent-harness/core';

/** 桩 A2A 端点：接收 TaskEnvelope，返回 TaskResult。 */
function startStubA2A(): Promise<{ server: http.Server; endpoint: string }> {
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST') {
      res.statusCode = 405;
      return res.end();
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let env: any = {};
      try {
        env = JSON.parse(body || '{}');
      } catch {
        /* ignore */
      }
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          taskId: env.taskId ?? 'unknown',
          status: 'completed',
          output: { echoed: env.input, answeredBy: 'remote-a2a-stub' },
        })
      );
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, endpoint: `http://127.0.0.1:${port}/a2a` });
    });
  });
}

async function main(): Promise<void> {
  const { server, endpoint } = await startStubA2A();

  // 纯声明式远端 agent 清单（无代码、无 PluginModule）。
  const remoteManifest: PluginManifest = {
    id: 'remote-notes-agent',
    version: '1.0.0',
    name: '远端备忘代理',
    description: '部署在另一主机的备忘 agent，经 A2A 派发任务。',
    domain: 'generic',
    transport: 'a2a',
    endpoint,
    capabilities: [{ id: 'notes' }],
    // 远端/不可信 agent 声明最低隔离级别（真实跨主机场景应设 'container'）。
    isolation: 'os',
  };

  const loader = new PluginLoader({ registry: getAgentRegistry() });
  await loader.install(remoteManifest); // 声明式登记（无 Module）
  await loader.enable('remote-notes-agent'); // 转 AgentCard 注册进 Registry

  const card = await getAgentRegistry().get('remote-notes-agent');
  console.log('[a2a] 远端 agent 已注册为 AgentCard：');
  console.log('   id:', card?.id, '| transport:', card?.transport, '| endpoint:', card?.endpoint);
  console.log('   capabilities:', JSON.stringify(card?.capabilities));

  // 模拟平台经 A2A 把任务派发到该远端 agent（复用核心 HttpA2ATransport）。
  const result = await loader.broadcast; // 仅引用，避免未用告警
  void result;
  const transport = new (await import('@agent-harness/core')).HttpA2ATransport(endpoint);
  const reply = await transport.send({
    type: 'task',
    taskId: `t-${Date.now()}`,
    agentId: 'remote-notes-agent',
    input: { query: '帮我记一下：明天评审' },
  } as never);
  console.log('[a2a] 经 A2A 派发得到回包：', JSON.stringify(reply));

  await loader.disable('remote-notes-agent');
  getAgentRegistry().deregister('remote-notes-agent');
  server.close();
  console.log('[a2a] 演示结束：远端 agent 已停用并注销。');
}

main().catch((e) => {
  console.error('[a2a] 失败：', e);
  process.exit(1);
});

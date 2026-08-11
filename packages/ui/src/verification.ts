import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  AgentHarness,
  ToolRegistry,
  Memory,
  HarnessClient,
  registerHarnessTools,
  registerMcpTools,
  loadEnv,
  type EphemeralEnvInput,
  type HarnessEvent,
} from '@agent-harness/core';
import { makeMockEnvLLM } from './runner';

loadEnv();

/** 验证事件：UI 据此渲染三个检查的状态。 */
export type VerifyEvent =
  | { type: 'verify:start'; id: string; title: string }
  | { type: 'verify:check'; id: string; ok: boolean; msg: string }
  | { type: 'verify:done'; id: string; pass: boolean; summary: string }
  | { type: 'verify:error'; id: string; message: string };

export async function runVerification(onEvent: (e: VerifyEvent) => void): Promise<void> {
  // #1 Agent 闭环（LLM ↔ 工具 ↔ 记忆）
  await runCheck('1', 'Agent 闭环（LLM ↔ 工具 ↔ 记忆）', onEvent, async (check) => {
    const tools = new ToolRegistry();
    const client = new HarnessClient({ dryRun: true });
    registerHarnessTools(tools, client);
    const memory = new Memory();
    const harness = new AgentHarness({
      llm: makeMockEnvLLM(),
      tools,
      memory,
      systemPrompt: '基础设施助手',
    });
    const final = await harness.run(
      '帮我在测试环境基于 feature/login 分支拉起一个临时环境，跑完回归后帮我销毁'
    );
    check(
      final.includes('销毁') || final.includes('destroyed'),
      `闭环最终回复包含销毁确认（实际：${final.slice(0, 60)}…）`
    );
    check(tools.has('create_ephemeral_environment'), '工具 create_ephemeral_environment 已注册');
    check(tools.has('destroy_environment'), '工具 destroy_environment 已注册');
  });

  // #2 Harness 状态轮询（触发 → 抓 executionId → 轮询 → 终态映射 → 自定义 statusPath）
  await runCheck('2', 'Harness 状态轮询（触发 → 轮询 → 终态）', onEvent, async (check) => {
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
    check(handle.executionId === 'exec-XYZ-789', '触发后正确捕获 executionId');
    check(handle.status === 'ready', `SUCCESS 映射为 ready（实际：${handle.status}）`);
    const live = await client.getStatus('exec-XYZ-789');
    check(live === 'SUCCESS', `getStatus 返回 ${live}`);

    const client2 = new HarnessClient({
      apiKey: 'test-key',
      apiBase: 'https://harness.local',
      pollIntervalMs: 2,
      maxPolls: 20,
      dryRun: false,
      statusPath: 'status',
      doneStatuses: ['SUCCESS', 'FAILED'],
      fetchImpl: (async (input: any, _init?: any) => {
        const url = String(input);
        if (url.includes('/execute/')) return jsonResponse({ executionId: 'exec-FAIL-1' });
        if (url.includes('/executions/')) return jsonResponse({ status: 'FAILED' });
        return jsonResponse({}, 404);
      }) as unknown as typeof fetch,
    });
    const failHandle = await client2.createEphemeralEnvironment(input);
    check(
      failHandle.status === 'failed',
      `自定义 statusPath + FAILED 映射为 failed（实际：${failHandle.status}）`
    );
  });

  // #3 MCP 接入（进程内真实 MCP Server → list → 注册 → 调用）
  await runCheck('3', 'MCP 工具接入（连接 → list → 注册 → 调用）', onEvent, async (check) => {
    const server = new Server(
      { name: 'demo-mcp-server', version: '1.0.0' },
      { capabilities: { tools: {} } }
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'echo_tool',
          description: '回显传入的消息',
          inputSchema: {
            type: 'object',
            properties: { message: { type: 'string' } },
            required: ['message'],
          },
        },
      ],
    }));
    server.setRequestHandler(CallToolRequestSchema, async (req: any) => {
      const args = (req.params.arguments ?? {}) as { message?: string };
      return { content: [{ type: 'text', text: `echo: ${args.message ?? ''}` }] };
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const registry = new ToolRegistry();
    await registerMcpTools(registry, { transport: clientTransport });

    check(registry.has('echo_tool'), 'echo_tool 已注册进 ToolRegistry');
    check(registry.schemas().length === 1, `ToolRegistry 含 ${registry.schemas().length} 个工具`);
    const out = (await registry.call('echo_tool', { message: 'hello-mcp' })) as string;
    check(
      typeof out === 'string' && out.includes('hello-mcp'),
      `调用 MCP 工具返回预期结果（实际：${out}）`
    );
  });
}

async function runCheck(
  id: string,
  title: string,
  onEvent: (e: VerifyEvent) => void,
  fn: (check: (ok: boolean, msg: string) => void) => Promise<void>
): Promise<void> {
  onEvent({ type: 'verify:start', id, title });
  const checks: { ok: boolean; msg: string }[] = [];
  const check = (ok: boolean, msg: string) => {
    checks.push({ ok, msg });
    onEvent({ type: 'verify:check', id, ok, msg });
  };
  try {
    await fn(check);
    const pass = checks.every((c) => c.ok);
    const summary = pass
      ? `全部 ${checks.length} 项通过`
      : `${checks.filter((c) => !c.ok).length}/${checks.length} 项失败`;
    onEvent({ type: 'verify:done', id, pass, summary });
  } catch (e) {
    onEvent({ type: 'verify:error', id, message: (e as Error).message });
    onEvent({ type: 'verify:done', id, pass: false, summary: `异常：${(e as Error).message}` });
  }
}

// --- 模拟 Harness NG 后端（与 examples/verify-harness.ts 一致）---
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function fakeHarnessBackend(finalStatus: string) {
  let poll = 0;
  const statusSequence = ['RUNNING', 'RUNNING', finalStatus];
  return (async (input: any, _init?: any): Promise<Response> => {
    const url = String(input);
    if (url.includes('/execute/')) {
      return jsonResponse({ pipelineExecutionId: 'exec-XYZ-789' });
    }
    if (url.includes('/executions/')) {
      const st = statusSequence[Math.min(poll++, statusSequence.length - 1)];
      return jsonResponse({ pipelineExecution: { summary: { status: st } } });
    }
    return jsonResponse({}, 404);
  }) as unknown as typeof fetch;
}

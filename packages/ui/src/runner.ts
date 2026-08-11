import {
  AgentHarness,
  ToolRegistry,
  Memory,
  createOpenRouterLLM,
  HarnessClient,
  registerHarnessTools,
  loadEnv,
  type LLM,
  type HarnessEvent,
  type ToolCall,
} from '@agent-harness/core';
import { mcpManager } from './mcp-manager';

loadEnv(); // 加载 git-ignored 的 .env；显式环境变量优先

export type RunMode = 'mock' | 'real' | 'real-mcp';

export interface AssembledAgent {
  harness: AgentHarness;
  tools: ToolRegistry;
  memory: Memory;
  llmKind: 'mock' | 'openrouter';
  dryRun: boolean;
  mcpConnected: boolean;
  notes: string[];
}

const SYSTEM_PROMPT =
  '你是基础设施助手。用户需要临时/预览环境时，调用 create_ephemeral_environment；' +
  '用户确认回归/验证完成后，务必调用 destroy_environment 清理，避免资源浪费。';

/** 根据运行模式组装一个带事件回调的 Agent。 */
export async function assembleAgent(
  mode: RunMode,
  onEvent?: (e: HarnessEvent) => void,
  systemPrompt: string = SYSTEM_PROMPT,
  modelOverride?: string
): Promise<AssembledAgent> {
  const tools = new ToolRegistry();
  const harnessClient = new HarnessClient(); // 未设置 HARNESS_API_KEY 时自动 dry-run
  const dryRun = !process.env.HARNESS_API_KEY;
  registerHarnessTools(tools, harnessClient);

  // 合并运行时已接入的 MCP 工具（共享注册表）。
  tools.mergeFrom(mcpManager.liveRegistry());

  const notes: string[] = [];
  let llm: LLM;
  let llmKind: 'mock' | 'openrouter' = 'mock';
  const mcpConnected = mcpManager.list().some((s) => s.status === 'connected');

  if (mode === 'mock') {
    llm = makeMockEnvLLM();
    llmKind = 'mock';
    notes.push('内置 Mock LLM（无需密钥），离线即可跑通 创建 → 销毁 闭环。');
  } else {
    // real / real-mcp 都依赖真实 OpenRouter
    if (!process.env.OPENROUTER_API_KEY) {
      throw new Error(
        '真实模式需要 OPENROUTER_API_KEY（在 .env 中配置）。可切换到 Mock 模式离线验证。'
      );
    }
    const model =
      (modelOverride && modelOverride.trim()) ||
      (process.env.OPENROUTER_MODEL && process.env.OPENROUTER_MODEL.trim()) ||
      undefined;
    llm = createOpenRouterLLM(model ? { model } : {});
    llmKind = 'openrouter';
    notes.push(`使用真实 OpenRouter LLM（model=${model ?? '默认'}）。`);
  }

  if (mcpConnected) {
    const total = mcpManager
      .list()
      .filter((s) => s.status === 'connected')
      .reduce((n, s) => n + s.tools.length, 0);
    notes.push(`已接入 MCP 服务 ${mcpManager.list().filter((s) => s.status === 'connected').length} 个，工具 ${total} 个。`);
  } else {
    notes.push('未检测到已连接的 MCP 服务（可在「MCP 服务」面板添加）。');
  }

  const memory = new Memory();
  const harness = new AgentHarness({
    llm,
    tools,
    memory,
    systemPrompt,
    onEvent,
  });

  return { harness, tools, memory, llmKind, dryRun, mcpConnected, notes };
}

/** 各模式对应的默认提示词（用户在 UI 留空时使用）。 */
export function defaultPromptFor(mode: RunMode): string {
  if (mode === 'mock') {
    return '帮我在测试环境基于 feature/login 分支拉起一个临时环境，跑完回归后帮我销毁';
  }
  return '帮我在测试环境基于 feature/login 分支拉起一个临时环境';
}

/** Mock LLM：无需密钥即可驱动 创建 → 销毁 闭环（与 examples/self-serve-env.ts 一致）。 */
export function makeMockEnvLLM(): LLM {
  return async (messages) => {
    const last = messages[messages.length - 1];

    if (last?.role === 'tool' && last.name === 'destroy_environment') {
      const h = safeParse(last.content ?? '');
      return {
        content: `已完成闭环：临时环境 ${h.envId} 已创建并销毁，无残留资源。`,
        tool_calls: [],
      };
    }

    if (last?.role === 'tool' && last.name === 'create_ephemeral_environment') {
      const h = safeParse(last.content ?? '');
      const call: ToolCall = {
        id: 'call_' + Date.now(),
        name: 'destroy_environment',
        arguments: { env_id: h.envId },
      };
      return { content: '', tool_calls: [call] };
    }

    const text = last?.content ?? '';
    const branchMatch = text.match(/基于\s*([^\s,，]+)\s*分支/);
    const branch = branchMatch ? branchMatch[1] : 'main';
    const call: ToolCall = {
      id: 'call_' + Date.now(),
      name: 'create_ephemeral_environment',
      arguments: { env_type: 'ephemeral', branch, ttl_hours: 8 },
    };
    return { content: '', tool_calls: [call] };
  };
}

function safeParse(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s || '{}');
  } catch {
    return {};
  }
}

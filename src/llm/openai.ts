import type { LLM, Message, ToolCall, ToolSchema, LLMResponse } from '../types';

export interface OpenAIConfig {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  // 可注入的 fetch（便于测试或代理）。默认使用全局 fetch。
  fetchImpl?: typeof fetch;
}

/**
 * 面向任意 OpenAI 兼容 Chat Completions 端点的真实 LLM 适配器
 *（OpenAI、Azure OpenAI、本地 llama.cpp / vLLM 等）。
 *
 * 使用内置全局 `fetch` —— 无需 `openai` npm 依赖，
 * 保证 Harness 在运行时零强制依赖。
 *
 * 实现单一的 `LLM` 契约；直接传入 `new AgentHarness({ llm })` 即可使用。
 */
export function createOpenAILLM(config: OpenAIConfig = {}): LLM {
  const apiKey = config.apiKey ?? process.env.OPENAI_API_KEY;
  const model = config.model ?? process.env.OPENAI_MODEL ?? 'gpt-4o-mini';
  const baseUrl =
    config.baseUrl ?? process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1';
  const fetchImpl = config.fetchImpl ?? fetch;

  return async function openaiLLM(
    messages: Message[],
    tools: ToolSchema[]
  ): Promise<LLMResponse> {
    if (!apiKey) {
      throw new Error(
        'OpenAI LLM requires OPENAI_API_KEY (or pass apiKey to createOpenAILLM).'
      );
    }

    const body: Record<string, unknown> = {
      model,
      messages: messages.map(toOpenAIMessage),
    };

    if (tools && tools.length > 0) {
      body.tools = tools.map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
      body.tool_choice = 'auto';
    }

    const resp = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`OpenAI API error ${resp.status}: ${text}`);
    }

    const data: any = await resp.json();
    const msg = data?.choices?.[0]?.message ?? {};
    const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map((c: any) => ({
      id: c.id,
      name: c.function.name,
      arguments: safeParse(c.function.arguments),
    }));

    return { content: msg.content ?? '', tool_calls: toolCalls };
  };
}

function toOpenAIMessage(m: Message): Record<string, unknown> {
  if (m.role === 'tool') {
    return {
      role: 'tool',
      tool_call_id: m.tool_call_id,
      content: m.content ?? '',
    };
  }
  const out: Record<string, unknown> = {
    role: m.role,
    content: m.content ?? '',
  };
  if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length) {
    out.tool_calls = m.tool_calls.map((tc) => ({
      id: tc.id,
      type: 'function',
      function: {
        name: tc.name,
        arguments: JSON.stringify(tc.arguments ?? {}),
      },
    }));
  }
  return out;
}

function safeParse(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s || '{}');
  } catch {
    return {};
  }
}

import type { LLM, Message, ToolSchema, LLMResponse, LLMCallOptions } from '../types';
import { toOpenAIMessage, callOpenAIChat } from './shared';

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
 * 第三个可选参数携带取消信号（超时 / 用户中止），会被透传给 fetch。
 */
export function createOpenAILLM(config: OpenAIConfig = {}): LLM {
  const apiKey = config.apiKey ?? process.env.OPENAI_API_KEY;
  const model =
    (config.model && config.model.trim()) ||
    (process.env.OPENAI_MODEL && process.env.OPENAI_MODEL.trim()) ||
    'gpt-4o-mini';
  const baseUrl =
    (config.baseUrl && config.baseUrl.trim()) ||
    (process.env.OPENAI_BASE_URL && process.env.OPENAI_BASE_URL.trim()) ||
    'https://api.openai.com/v1';
  const fetchImpl = config.fetchImpl ?? fetch;

  return async function openaiLLM(
    messages: Message[],
    tools: ToolSchema[],
    options?: LLMCallOptions
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

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    };

    return callOpenAIChat({
      baseUrl,
      headers,
      body,
      fetchImpl,
      retries: 0,
      modelLabel: model,
      signal: options?.signal,
    });
  };
}

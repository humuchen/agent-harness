import type { LLM, Message, ToolCall, ToolSchema, LLMResponse } from '../types';

export interface OpenRouterConfig {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  // OpenRouter 特有：提供模型列表以实现自动降级
  //（例如 ['openai/gpt-4o-mini', 'anthropic/claude-3.5-sonnet']）。
  // 设置后会作为 `models` 发送，取代单个 `model` 字段。
  models?: string[];
  // OpenRouter 建议附加的归因请求头。
  siteUrl?: string;
  appName?: string;
  // 可注入的 fetch（便于测试或代理）。默认使用全局 fetch。
  fetchImpl?: typeof fetch;
  // 对退化响应（内容为空且没有工具调用）以及限流/瞬时故障（HTTP 429/5xx）
  // 进行重试，某些免费/弱模型会间歇性返回空响应或撞上速率限制。
  // 默认重试 2 次。
  retries?: number;
}

/**
 * 面向 OpenRouter (https://openrouter.ai) 的真实 LLM 适配器。
 *
 * OpenRouter 实现了 OpenAI Chat Completions 协议，因此与 OpenAI 适配器
 * 使用相同的契约，但额外具备：
 *   - 默认 `baseUrl` 为 https://openrouter.ai/api/v1
 *   - 自动附加建议的 HTTP-Referer / X-Title 归因请求头
 *   - 支持 OpenRouter 的 `models` 降级数组
 *   - 使用带提供商前缀的模型标识（例如 `openai/gpt-4o-mini`）
 *
 * 使用内置全局 `fetch` —— 无需 `openai` npm 依赖，
 * 保证 Harness 在运行时零强制依赖。
 *
 * 实现单一的 `LLM` 契约；直接传入 `new AgentHarness({ llm })` 即可使用。
 */
export function createOpenRouterLLM(config: OpenRouterConfig = {}): LLM {
  const apiKey = config.apiKey ?? process.env.OPENROUTER_API_KEY;
  // 注意：用 `||` + trim 而非 `??`，因为环境变量可能被配置成空字符串
  // （例如在 Render 里加了 OPENROUTER_MODEL 但留空），`??` 不会把空串当作
  // "未设置" 而回落到默认值，导致把 model:"" 直接发给 OpenRouter 被拒。
  const model =
    (config.model && config.model.trim()) ||
    (process.env.OPENROUTER_MODEL && process.env.OPENROUTER_MODEL.trim()) ||
    'openai/gpt-4o-mini';
  const baseUrl =
    (config.baseUrl && config.baseUrl.trim()) ||
    (process.env.OPENROUTER_BASE_URL && process.env.OPENROUTER_BASE_URL.trim()) ||
    'https://openrouter.ai/api/v1';
  const siteUrl =
    (config.siteUrl && config.siteUrl.trim()) ||
    (process.env.OPENROUTER_SITE_URL && process.env.OPENROUTER_SITE_URL.trim()) ||
    'https://workbuddy.app';
  const appName =
    (config.appName && config.appName.trim()) ||
    (process.env.OPENROUTER_APP_NAME && process.env.OPENROUTER_APP_NAME.trim()) ||
    'agent-harness';
  const fetchImpl = config.fetchImpl ?? fetch;
  const retries = config.retries ?? 2;

  return async function openRouterLLM(
    messages: Message[],
    tools: ToolSchema[]
  ): Promise<LLMResponse> {
    if (!apiKey) {
      throw new Error(
        'OpenRouter LLM requires OPENROUTER_API_KEY (or pass apiKey to createOpenRouterLLM).'
      );
    }

    const body: Record<string, unknown> = {
      messages: messages.map(toOpenAIMessage),
    };

    // OpenRouter 支持单个 `model` 或 `models` 降级列表。
    if (config.models && config.models.length > 0) {
      body.models = config.models;
    } else {
      body.model = model;
    }

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

    // OpenRouter 归因请求头（建议附加）。
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'HTTP-Referer': siteUrl,
      'X-Title': appName,
    };

    let last: LLMResponse = { content: '', tool_calls: [] };
    // 这些 HTTP 状态视为限流/瞬时故障，可重试（免费档常遇 429）。
    const retryableStatus = new Set([429, 500, 502, 503, 529]);

    for (let attempt = 0; attempt <= retries; attempt++) {
      const resp = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

      if (!resp.ok) {
        const text = await resp.text();
        if (retryableStatus.has(resp.status) && attempt < retries) {
          const waitMs = 800 * (attempt + 1);
          console.warn(
            `[openrouter] ${resp.status} (retryable), retrying in ${waitMs}ms (${attempt + 1}/${retries})`
          );
          await new Promise((r) => setTimeout(r, waitMs));
          continue;
        }
        throw new Error(`OpenRouter API error ${resp.status}: ${text}`);
      }

      const data: any = await resp.json();
      const msg = data?.choices?.[0]?.message ?? {};
      const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map((c: any) => ({
        id: c.id,
        name: c.function.name,
        arguments: safeParse(c.function.arguments),
      }));
      last = { content: msg.content ?? '', tool_calls: toolCalls };

      // 退化响应（无文本、无工具调用）—— 若仍有重试次数则重试。
      const degenerate = last.content.trim() === '' && last.tool_calls.length === 0;
      if (!degenerate || attempt === retries) return last;
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
    return last;
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

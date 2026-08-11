import type { LLMResponse, Message, ToolCall, ToolSchema } from '../types';

/**
 * OpenAI 兼容 Chat Completions 适配器之间共享的纯函数。
 * OpenRouter 与 OpenAI 适配器都实现相同的 `LLM` 契约，仅默认 baseUrl /
 * 额外请求头 / 重试策略不同 —— 这些差异留在各自适配器里，共用的消息转换、
 * 参数解析与 HTTP 调用逻辑集中在此，避免两处复制粘贴后悄悄分叉。
 */

/** 将内部 Message 转换为 OpenAI Chat Completions 的 message 结构。 */
export function toOpenAIMessage(m: Message): Record<string, unknown> {
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

/** 容错解析工具调用参数（模型有时返回残缺 JSON）。 */
export function safeParseArgs(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s || '{}');
  } catch {
    return {};
  }
}

export interface ChatCallOptions {
  baseUrl: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  fetchImpl: typeof fetch;
  // 可选重试次数：对限流/瞬时故障（HTTP 429/5xx）与退化响应进行重试。
  // 设为 0 或省略表示不重试（原生 OpenAI 适配器即如此）。
  retries?: number;
  // 仅用于日志与报错的模型标识。
  modelLabel: string;
  // 取消信号（来自 Harness 的超时或外部 AbortSignal），透传给 fetch。
  signal?: AbortSignal;
}

// 这些 HTTP 状态视为限流 / 瞬时故障，可重试（免费档常遇 429）。
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 529]);

/** 调用任意 OpenAI 兼容 Chat Completions 端点并解析为标准 LLMResponse。 */
export async function callOpenAIChat(opts: ChatCallOptions): Promise<LLMResponse> {
  const { baseUrl, headers, body, fetchImpl, retries = 0, modelLabel, signal } = opts;
  let last: LLMResponse = { content: '', tool_calls: [] };

  for (let attempt = 0; attempt <= retries; attempt++) {
    const resp = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });

    if (!resp.ok) {
      const text = await resp.text();
      if (RETRYABLE_STATUS.has(resp.status) && attempt < retries) {
        const waitMs = 800 * (attempt + 1);
        console.warn(
          `[llm] ${resp.status} (retryable, model=${modelLabel}), retrying in ${waitMs}ms (${attempt + 1}/${retries})`
        );
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      throw new Error(`LLM API error ${resp.status} (model=${modelLabel}): ${text}`);
    }

    const data: any = await resp.json();
    const msg = data?.choices?.[0]?.message ?? {};
    const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map((c: any) => ({
      id: c.id,
      name: c.function.name,
      arguments: safeParseArgs(c.function.arguments),
    }));
    last = { content: msg.content ?? '', tool_calls: toolCalls };

    // 退化响应（无文本且无工具调用）—— 若仍有重试次数则重试。
    const degenerate = last.content.trim() === '' && last.tool_calls.length === 0;
    if (!degenerate || attempt === retries) return last;
    await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
  }
  return last;
}

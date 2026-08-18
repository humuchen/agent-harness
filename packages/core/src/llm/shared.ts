import type { LLMResponse, Message, ToolCall, ToolSchema, TokenUsage } from '../types';
import { recordTokenCacheQuery } from './token-cache-metrics';

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
  // token 级流式回调（可选）：设置后适配器走 stream:true，逐 delta 回调并重建完整响应。
  onToken?: (delta: string) => void;
  // 推理过程流式回调（可选）：捕获 delta.reasoning（部分推理模型），用于「思考」折叠块。
  onReasoning?: (delta: string) => void;
}

// 这些 HTTP 状态视为限流 / 瞬时故障，可重试（免费档常遇 429）。
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 529]);

/** 调用任意 OpenAI 兼容 Chat Completions 端点并解析为标准 LLMResponse。 */
export async function callOpenAIChat(opts: ChatCallOptions): Promise<LLMResponse> {
  const { baseUrl, headers, body, fetchImpl, retries = 0, modelLabel, signal, onToken, onReasoning } = opts;
  // token 级流式：回调存在即走 stream:true，边读边 emit 增量并重建完整响应
  // （含工具调用的增量重组），保证既能在聊天 UI 实现打字机效果，又不丢失 agent 的工具执行能力。
  if (onToken || onReasoning) {
    return streamOpenAIChat({ baseUrl, headers, body, fetchImpl, modelLabel, signal, onToken, onReasoning });
  }
  let last: LLMResponse = { content: '', tool_calls: [] };
  // 跨重试累计 token 用量：每次重试都重发全量 prompt，provider 对每次都计费，
  // 但旧实现只取最后一次响应的 usage → 重试成本被低估。这里把各次 usage 累加。
  const usageAcc = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cached_tokens: 0 };

  // 可选 prompt caching：把系统提示词标记为可缓存（provider 不支持时忽略该字段）。
  // 默认关闭，避免个别严格校验未知字段的 provider 报错；设 PROMPT_CACHE=true 开启。
  // 开启时本次请求即视为一次「缓存查询」，命中与否由响应 cached_tokens 决定。
  const caching = process.env.PROMPT_CACHE === 'true' || process.env.PROMPT_CACHE === '1';
  if (caching) {
    const msgs = (body as any).messages;
    if (Array.isArray(msgs) && msgs.length && msgs[0]?.role === 'system') {
      msgs[0].cache_control = { type: 'ephemeral' };
    }
  }

  // 仅在开启 prompt caching 时记录缓存查询（关闭则 provider 不会缓存，记了会虚低命中率）。
  const reportCache = () => {
    if (!caching) return;
    recordTokenCacheQuery({
      hit: usageAcc.cached_tokens > 0,
      cachedTokens: usageAcc.cached_tokens,
      promptTokens: usageAcc.prompt_tokens,
      model: last.model,
    });
  };

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
    // 提取 token 用量（OpenAI / OpenRouter 均返回 usage 字段），供成本记账与配额使用。
    const u = data?.usage;
    if (u) {
      usageAcc.prompt_tokens += u.prompt_tokens ?? 0;
      usageAcc.completion_tokens += u.completion_tokens ?? 0;
      usageAcc.total_tokens +=
        u.total_tokens ?? (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0);
      // 供应商侧 prompt 缓存命中 token 数（OpenAI / OpenRouter 字段名一致；Anthropic 经 OpenRouter 为 cached_prompt_tokens）。
      usageAcc.cached_tokens +=
        Number(u.prompt_tokens_details?.cached_tokens ?? u.prompt_tokens_details?.cached_prompt_tokens ?? 0) || 0;
    }
    const usage: TokenUsage | undefined = u
      ? {
          prompt_tokens: u.prompt_tokens ?? 0,
          completion_tokens: u.completion_tokens ?? 0,
          total_tokens: u.total_tokens ?? (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0),
          cached_tokens:
            Number(u.prompt_tokens_details?.cached_tokens ?? u.prompt_tokens_details?.cached_prompt_tokens ?? 0) || undefined,
        }
      : undefined;
    // 实际使用的模型（OpenRouter 多模型降级时会与请求模型不同）；用于按模型计价与可观测。
    const usedModel: string | undefined = typeof data?.model === 'string' ? data.model : undefined;
    last = { content: msg.content ?? '', tool_calls: toolCalls, usage, model: usedModel };

    // 退化响应（无文本且无工具调用）—— 若仍有重试次数则重试。
    const degenerate = last.content.trim() === '' && last.tool_calls.length === 0;
    if (!degenerate || attempt === retries) {
      // 返回累加后的用量，避免重试成本被低估。
      reportCache();
      return { ...last, usage: u ? { ...usageAcc } : undefined };
    }
    await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
  }
  reportCache();
  return { ...last, usage: last.usage ? { ...usageAcc } : undefined };
}

/**
 * 流式读取 OpenAI 兼容的 SSE 响应体。
 * - 逐 `data:` 行解析，content delta 经 onToken 回调（打字机）；
 * - 推理模型的 `delta.reasoning` 经 onReasoning 回调（思考折叠块）；
 * - 工具调用在流中以增量 `tool_calls[]` 返回，按 index 重组为完整 ToolCall[]，
 *   保证开启流式后仍可执行 agent 工具（不丢失 tool 能力）；
 * - 用量在末帧（stream_options.include_usage=true）返回时捕获。
 * 返回与一次性调用同形状的 LLMResponse，供 harness 记忆 / 成本记账 / 门禁复用。
 */
async function streamOpenAIChat(opts: ChatCallOptions): Promise<LLMResponse> {
  const { baseUrl, headers, body, fetchImpl, modelLabel, signal, onToken, onReasoning } = opts;
  const streamBody: Record<string, unknown> = {
    ...body,
    stream: true,
    stream_options: { include_usage: true },
  };
  // 与一次性路径一致：开启 PROMPT_CACHE 时给系统提示词打 cache_control，让流式请求也能命中供应商侧 prompt 缓存。
  const caching = process.env.PROMPT_CACHE === 'true' || process.env.PROMPT_CACHE === '1';
  if (caching) {
    const msgs = (streamBody as any).messages;
    if (Array.isArray(msgs) && msgs.length && msgs[0]?.role === 'system') {
      msgs[0].cache_control = { type: 'ephemeral' };
    }
  }
  const resp = await fetchImpl(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(streamBody),
    signal,
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`LLM API error ${resp.status} (model=${modelLabel}): ${text}`);
  }
  if (!resp.body || typeof (resp.body as any).getReader !== 'function') {
    throw new Error(`LLM streaming response has no readable body (model=${modelLabel})`);
  }

  const reader = (resp.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let raw = '';
  let fullContent = '';
  let reasoning = '';
  let usage: TokenUsage | undefined;
  let usedModel: string | undefined;
  // 按 index 重组工具调用增量：{ id?, name?, args }
  const toolAcc: Array<{ id?: string; name?: string; args: string }> = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    raw += decoder.decode(value, { stream: true });
  }

  // 兼容：部分端点（如 agnes）即便请求 stream:true，也可能返回「单条非流式」JSON
  // （object=chat.completion，思考过程在 message.reasoning_content 而非 delta）。
  // 此时没有 SSE 的 `data:` 标记，需按单条响应解析，否则 content 与 reasoning 都会丢失。
  const isSSE = /^data:/.test(raw.trim()) || raw.includes('\n');
  if (!isSSE) {
    try {
      const data = JSON.parse(raw);
      const msg = data?.choices?.[0]?.message ?? {};
      if (typeof msg.content === 'string' && msg.content) {
        fullContent += msg.content;
        onToken?.(msg.content);
      }
      // 思考过程：优先 reasoning_content，回落 reasoning（两种字段名都兼容）。
      const rc =
        typeof msg.reasoning_content === 'string'
          ? msg.reasoning_content
          : typeof msg.reasoning === 'string'
            ? msg.reasoning
            : '';
      if (rc) {
        reasoning += rc;
        onReasoning?.(rc);
      }
      const tcs = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
      for (const c of tcs) {
        toolAcc.push({ id: c.id, name: c.function?.name, args: c.function?.arguments ?? '' });
      }
      if (data?.usage) usage = toUsage(data.usage);
      if (data?.model) usedModel = data.model;
    } catch {
      /* 非预期响应体，忽略 */
    }
  } else {
    let buffer = raw;
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      let json: any;
      try {
        json = JSON.parse(data);
      } catch {
        continue;
      }
      if (json.model) usedModel = json.model;
      if (json.usage) usage = toUsage(json.usage);
      const choice = json.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta ?? {};
      // 部分端点（如 agnes）在流式响应里把思考过程放在「聚合后的 message」而非 delta
      // （常见于最后一个事件），两种位置都兼容捕获。
      const msgReasoning =
        typeof choice.message?.reasoning_content === 'string'
          ? choice.message.reasoning_content
          : typeof choice.message?.reasoning === 'string'
            ? choice.message.reasoning
            : '';
      if (msgReasoning) {
        reasoning += msgReasoning;
        onReasoning?.(msgReasoning);
      }
      if (typeof delta.content === 'string' && delta.content) {
        fullContent += delta.content;
        onToken?.(delta.content);
      }
      if (typeof delta.reasoning === 'string' && delta.reasoning) {
        reasoning += delta.reasoning;
        onReasoning?.(delta.reasoning);
      }
      // 部分端点（如 agnes）以 `reasoning_content` 而非 `reasoning` 返回思考过程，
      // 这里两种字段名都兼容捕获，统一经 onReasoning 回调（驱动「深度思考」打字机）。
      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
        reasoning += delta.reasoning_content;
        onReasoning?.(delta.reasoning_content);
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const i = typeof tc.index === 'number' ? tc.index : 0;
          if (!toolAcc[i]) toolAcc[i] = { args: '' };
          if (tc.id) toolAcc[i].id = tc.id;
          if (tc.function?.name) toolAcc[i].name = tc.function.name;
          if (typeof tc.function?.arguments === 'string') toolAcc[i].args += tc.function.arguments;
        }
      }
    }
  }

  const toolCalls: ToolCall[] = toolAcc
    .filter(Boolean)
    .map((t, i) => ({
      id: t.id ?? `call_${i}`,
      name: t.name ?? 'unknown',
      arguments: safeParseArgs(t.args),
    }));

  // 流式路径同样在开启 PROMPT_CACHE 时记录一次缓存查询与命中情况。
  if (caching) {
    const cached = usage?.cached_tokens ?? 0;
    recordTokenCacheQuery({
      hit: cached > 0,
      cachedTokens: cached,
      promptTokens: usage?.prompt_tokens ?? 0,
      model: usedModel,
    });
  }

  return { content: fullContent, tool_calls: toolCalls, usage, model: usedModel };
}

/** 将 provider 用量对象归一为标准 TokenUsage（缺失字段补 0）。 */
function toUsage(u: any): TokenUsage | undefined {
  if (!u || typeof u !== 'object') return undefined;
  const prompt = Number(u.prompt_tokens) || 0;
  const completion = Number(u.completion_tokens) || 0;
  const total = Number(u.total_tokens) || prompt + completion;
  const cached = Number(u.prompt_tokens_details?.cached_tokens ?? u.prompt_tokens_details?.cached_prompt_tokens ?? 0) || 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total,
    cached_tokens: cached || undefined,
  };
}

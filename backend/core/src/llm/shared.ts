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

/**
 * 工具描述精简：在不改变工具「可执行语义」的前提下，缩短发送给 LLM 的
 * 工具 schema 文本，降低每轮固定的 prompt 开销（尤其对 18+ 工具的 agent）。
 * 仅截断散文 description，保留 `name` 与完整 `parameters` 结构，
 * 工具的本地执行/help 文本不受影响（它们读的是 ToolRegistry 原样 schema）。
 *
 * @param t 原始 ToolSchema
 * @param maxDesc 单段 description 的最大字符数（<=0 表示不截断）
 */
export function compactToolSchema(t: ToolSchema, maxDesc: number): ToolSchema {
  if (!maxDesc || maxDesc <= 0) return t;
  const desc = typeof t.description === 'string' ? truncate(t.description, maxDesc) : t.description;
  const params = t.parameters as Record<string, unknown> | undefined;
  // 仅压缩 properties 内各字段的 description，保持 type / required 等结构不变。
  const compacted =
    params && params.properties
      ? { ...params, properties: compactParameters(params.properties as Record<string, unknown>, maxDesc) }
      : params;
  return { ...t, description: desc, parameters: compacted as ToolSchema['parameters'] };
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  // 保留语义完整性：截断后加省略标记，避免模型误以为描述到此为止。
  return s.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}

/**
 * 递归截断 JSON Schema parameters.properties 里各 property / items 的 description 字段。
 * 直接对「属性名字典」做处理并返回同结构字典（不包裹 {type, properties}），
 * 因此 `properties` 内的嵌套 `properties` 也能被正确递归压缩。
 */
function compactParameters(
  props: Record<string, unknown> | undefined,
  max: number
): Record<string, unknown> | undefined {
  if (!props || typeof props !== 'object') return props;
  const next: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) {
    if (v && typeof v === 'object') {
      const nv: Record<string, unknown> = { ...v };
      if (typeof nv.description === 'string') nv.description = truncate(nv.description, max);
      if (nv.properties) nv.properties = compactParameters(nv.properties as Record<string, unknown>, max);
      if (nv.items && typeof nv.items === 'object') {
        const items = nv.items as Record<string, unknown>;
        if (typeof items.description === 'string') items.description = truncate(items.description, max);
        if (items.properties) items.properties = compactParameters(items.properties as Record<string, unknown>, max);
      }
      next[k] = nv;
    } else {
      next[k] = v;
    }
  }
  return next;
}

/** 容错解析工具调用参数（模型有时返回残缺 JSON）。 */
export function safeParseArgs(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s || '{}');
  } catch {
    return {};
  }
}

/**
 * 归一化 tool_call id：缺失或重复时补一个稳定的唯一 id。
 *
 * 部分 provider / 模型（尤其免费档与流式端点）会返回缺失 id 的 tool_call，
 * 或让多个调用共用同一个 id。id 为空会让回传的 tool 结果变成
 * `tool_call_id: undefined`，重复 id 则会让多个结果争用同一个调用 ——
 * 两者都会被 provider 判定为 id 不匹配并直接 400。这里统一兜底。
 */
export function normalizeToolCallIds(calls: ToolCall[]): ToolCall[] {
  const seen = new Set<string>();
  return calls.map((tc, i) => {
    const raw = typeof tc.id === 'string' ? tc.id.trim() : '';
    if (raw && !seen.has(raw)) {
      seen.add(raw);
      return tc;
    }
    const id = raw ? `${raw}__dup${i}` : `call_${i}_${Date.now().toString(36)}`;
    seen.add(id);
    return { ...tc, id };
  });
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
  // P1-2: CircuitBreaker 实例（可选）。传入后自动包裹调用，熔断打开时抛出 CircuitBreakerOpen。
  circuitBreaker?: import('../circuit-breaker').CircuitBreaker;
}

// 这些 HTTP 状态视为限流 / 瞬时故障，可重试（免费档常遇 429）。
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 529]);

/** 调用任意 OpenAI 兼容 Chat Completions 端点并解析为标准 LLMResponse。 */
export async function callOpenAIChat(opts: ChatCallOptions): Promise<LLMResponse> {
  const { baseUrl, headers, body, fetchImpl, retries = 0, modelLabel, signal, onToken, onReasoning, circuitBreaker } = opts;
  // token 级流式：回调存在即走 stream:true，边读边 emit 增量并重建完整响应
  // （含工具调用的增量重组），保证既能在聊天 UI 实现打字机效果，又不丢失 agent 的工具执行能力。
  if (onToken || onReasoning) {
    return streamOpenAIChat({ baseUrl, headers, body, fetchImpl, modelLabel, signal, onToken, onReasoning });
  }
  let last: LLMResponse = { content: '', tool_calls: [] };
  // 跨重试累计 token 用量：每次重试都重发全量 prompt，provider 对每次都计费，
  // 但旧实现只取最后一次响应的 usage → 重试成本被低估。这里把各次 usage 累加。
  const usageAcc = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cached_tokens: 0 };

  // 可选 prompt caching：把系统提示词与工具 schema 标记为可缓存前缀
  //（provider 不支持时忽略该字段）。默认开启以省去重复的系统提示 + 工具 schema 计费；
  // 设 PROMPT_CACHE=false 可关闭（逃生阀，避免个别严格校验 cache_control 的 provider 报错）。
  // 开启时本次请求即视为一次「缓存查询」，命中与否由响应 cached_tokens 决定。
  const cacheDisabled = process.env.PROMPT_CACHE === 'false' || process.env.PROMPT_CACHE === '0';
  const caching = !cacheDisabled;
  if (caching) {
    const msgs = (body as any).messages;
    if (Array.isArray(msgs) && msgs.length && msgs[0]?.role === 'system') {
      msgs[0].cache_control = { type: 'ephemeral' };
    }
    // 工具 schema 同为每轮固定开销：在工具数组末项打 cache_control，
    // 使「系统提示 + 全量工具」作为可缓存前缀，后续 step / 重试命中 provider 前缀缓存。
    const tls = (body as any).tools;
    if (Array.isArray(tls) && tls.length) {
      tls[tls.length - 1].cache_control = { type: 'ephemeral' };
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

  const fetchWithBreaker = circuitBreaker
    ? () => circuitBreaker.withRequest(() => fetchImpl(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    }))
    : () => fetchImpl(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });

  for (let attempt = 0; attempt <= retries; attempt++) {
    let resp: Response;
    try {
      resp = await fetchWithBreaker();
    } catch (breakerErr: any) {
      // CircuitBreakerOpen 不是 LLM API 错误，直接上抛让调用方决定策略
      if (breakerErr?.name === 'CircuitBreakerOpen') throw breakerErr;
      throw breakerErr;
    }

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
    const toolCalls: ToolCall[] = normalizeToolCallIds(
      (msg.tool_calls ?? []).map((c: any) => ({
        id: c.id,
        name: c.function.name,
        arguments: safeParseArgs(c.function.arguments),
      }))
    );
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

  // ── 真流式 + 中段空闲超时 ────────────────────────────────────────────────
  // 原实现先攒完整流再解析（伪流式）：provider 中段挂起时 reader.read() 永久阻塞，
  // 且已生成内容因尚未解析而全部丢弃，前端表现为「答到一半彻底卡死」。
  // 现改为：边读边按行增量解析并回调 onToken/onReasoning（真打字机 + 中段可见性），
  // 并对两次 read 之间设置 LLM_STREAM_IDLE_TIMEOUT_MS 空闲超时，超时即中断 reader，
  // 以 partial:true 返回已生成内容，避免整次调用失败、内容全失。
  const IDLE_MS = Number(process.env.LLM_STREAM_IDLE_TIMEOUT_MS ?? 120_000) || 120_000;
  let stalled = false;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const clearIdle = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };
  const armIdle = () => {
    clearIdle();
    idleTimer = setTimeout(() => {
      stalled = true;
      reader.cancel().catch(() => {});
    }, IDLE_MS);
  };

  // 单行 SSE data 解析（增量与 flush 共用）
  let sawSse = false;
  const handleDataLine = (line: string) => {
    const l = line.trim();
    if (!l.startsWith('data:')) return;
    const data = l.slice(5).trim();
    if (!data || data === '[DONE]') return;
    let json: any;
    try {
      json = JSON.parse(data);
    } catch {
      return;
    }
    sawSse = true;
    if (json.model) usedModel = json.model;
    if (json.usage) usage = toUsage(json.usage);
    const choice = json.choices?.[0];
    if (!choice) return;
    const delta = choice.delta ?? {};
    // 部分端点（如 agnes）把思考过程放在「聚合后的 message」而非 delta（常见于最后一个事件）。
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
    // 部分端点（如 agnes）以 reasoning_content 而非 reasoning 返回思考过程，两种字段名都兼容。
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
  };

  let sseBuffer = '';
  try {
    armIdle();
    while (true) {
      const { done, value } = await reader.read();
      if (done || stalled) break;
      armIdle();
      const chunk = decoder.decode(value, { stream: true });
      raw += chunk;
      sseBuffer += chunk;
      let nl: number;
      while ((nl = sseBuffer.indexOf('\n')) >= 0) {
        const line = sseBuffer.slice(0, nl);
        sseBuffer = sseBuffer.slice(nl + 1);
        handleDataLine(line);
      }
    }
    clearIdle();
  } catch (e) {
    clearIdle();
    if (!stalled) throw e; // 仅中段空闲超时（reader 已 cancel）兜底；其他错误原样抛出
    console.warn(
      `[llm] 流读取空闲超时（${IDLE_MS}ms 无新数据，model=${modelLabel}），返回已生成的部分内容（${fullContent.length} 字符）。`
    );
  }

  // flush 剩余（最后一段可能无尾随换行）
  if (sseBuffer) handleDataLine(sseBuffer);

  // 兼容：部分端点（如 agnes）即便请求 stream:true，也可能返回「单条非流式」JSON
  // （object=chat.completion，思考过程在 message.reasoning_content 而非 delta）。
  // 若整个响应从未出现 data: 行（sawSse=false），按单条 JSON 解析。
  if (!sawSse && raw) {
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
  }

  const toolCalls: ToolCall[] = normalizeToolCallIds(
    toolAcc
      .filter(Boolean)
      .map((t, i) => ({
        id: t.id ?? `call_${i}`,
        name: t.name ?? 'unknown',
        arguments: safeParseArgs(t.args),
      }))
  );

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

  return { content: fullContent, tool_calls: toolCalls, usage, model: usedModel, partial: stalled };
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

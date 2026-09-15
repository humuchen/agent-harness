/**
 * Workers AI OpenAI-Compatible Proxy
 *
 * Modern Workers AI models already return responses in OpenAI Chat Completions
 * format (wrapped inside `{ success, result: {...OpenAI response...} }`).
 * This proxy:
 * - Passes OpenAI `messages` + `tools` directly to Workers AI `/ai/run/{model}`
 * - Unwraps `result` for non-streaming responses (returns OpenAI JSON directly)
 * - Passes through SSE streaming events (already OpenAI-compatible)
 * - Maps OpenAI model names → Workers AI slugs
 *
 * This lets agent-harness use Workers AI models as LLM providers with zero
 * changes — just set OPEN_BASE_URL to this Worker's URL + OPEN_API_KEY.
 *
 * Reference: https://developers.cloudflare.com/workers-ai/models/
 */

export interface Env {
  CF_AI_ACCOUNT_ID: string;
  CF_AI_TOKEN?: string; // if set, overrides client Bearer token
}

// Map common OpenAI-style model names to Workers AI model slugs.
// Workers AI REST API URL: /ai/run/@cf/{org}/{model}
// So the value is the full slug WITHOUT @cf/ prefix.
const MODEL_MAP: Record<string, string> = {
  // Llama (non-deprecated as of 2026-09)
  'llama-3-8b': 'meta/llama-3.1-8b-instruct-fp8',
  'llama-3-70b': 'meta/llama-3.3-70b-instruct-fp8-fast',
  'llama-4-scout': 'meta/llama-4-scout-17b-16e-instruct',
  'llama-4-scout-17b': 'meta/llama-4-scout-17b-16e-instruct',
  // Gemma (non-deprecated)
  'gemma-7b': 'google/gemma-4-26b-a4b-it',
  'gemma-2b': 'google/gemma-2b-it-lora',
  // Qwen (non-deprecated)
  'qwen-2-7b': 'qwen/qwen3-30b-a3b-fp8',
  'qwen-2-72b': 'qwen/qwen3-30b-a3b-fp8',
  'qwen3-30b': 'qwen/qwen3-30b-a3b-fp8',
  'qwq-32b': 'qwen/qwq-32b',
  // Microsoft Phi
  'phi-2': 'microsoft/phi-2',
  'phi-3-mini-4k': 'microsoft/phi-3-mini-4k-instruct',
  // OpenAI (NOT available via Workers AI — use OpenRouter/LLM gateway instead)
  // 'gpt-3.5-turbo': 'openai/gpt-3.5-turbo',
  // 'gpt-4o': 'openai/gpt-4o',
  // 'gpt-4o-mini': 'openai/gpt-4o-mini',
  // Mistral (non-deprecated)
  'mistral-7b': 'mistral/mistral-small-3.1-24b-instruct',
  'mistral-small-3.1': 'mistral/mistral-small-3.1-24b-instruct',
  'mixtral-8x7b': 'mistral/mistral-small-3.1-24b-instruct',
  // Other popular models
  'kimi-k2.7-code': 'moonshotai/kimi-k2.7-code',
  'glm-4.7-flash': 'zai-org/glm-4.7-flash',
  'glm-4.7': 'zai-org/glm-4.7-flash',
};

// Default model for Workers AI text generation (non-deprecated)
const DEFAULT_WORKER_MODEL = 'meta/llama-3.1-8b-instruct-fp8';

/**
 * Strip provider prefix from model name.
 * e.g. "meta/llama-3-8b" → "llama-3-8b"
 * e.g. "openai/gpt-4o" → "gpt-4o"
 */
function normalizeModel(model: string): string {
  return model.includes('/') ? model.slice(model.indexOf('/') + 1) : model;
}

/**
 * Resolve an OpenAI-style model name to a Workers AI model slug.
 * Workers AI REST API URL: @cf/{org}/{model} — so MODEL_MAP values
 * are "{org}/{model}" (without @cf/ prefix; the Worker adds @cf/).
 */
function resolveWorkerModel(model: string): string {
  if (MODEL_MAP[model]) return MODEL_MAP[model];
  const normalized = normalizeModel(model).toLowerCase();
  if (MODEL_MAP[normalized]) return MODEL_MAP[normalized];
  if (model.startsWith('@cf/')) return model.slice(4); // strip @cf/ prefix
  if (model.startsWith('cf/')) return model.slice(3);
  return DEFAULT_WORKER_MODEL;
}

/** Convert OpenAI tool definitions to Workers AI format */
function toolsToWorkerFormat(tools?: any[]): any[] {
  if (!tools || !Array.isArray(tools)) return [];
  return tools.map((t) => {
    if (t.type === 'function' && t.function) {
      return {
        name: t.function.name,
        description: t.function.description || '',
        parameters: t.function.parameters || {},
      };
    }
    return t;
  });
}

/**
 * Workers AI 严格校验输入 schema，会拒绝 OpenAI 专属字段（如 `cache_control`，
 * 这是 Anthropic/Claude 的字段）。Harness 在 PROMPT_CACHE 开启时（默认开启）
 * 会往系统消息注入 `cache_control`，若不剥离，GLM-4.7-flash 等严格模型会返回
 * `Invalid input` (code 8001)。转发前统一剥离这些不兼容字段。
 */
function stripIncompatibleFields(messages: any[]): any[] {
  if (!Array.isArray(messages)) return [];
  return messages.map((m) => {
    if (m && typeof m === 'object') {
      const { cache_control, ...rest } = m as Record<string, unknown>;
      return rest;
    }
    return m;
  });
}

/** 把 OpenAI 工具转换成 Workers AI 格式，并兜底保证 parameters 是合法 JSON Schema 对象。 */
function sanitizeTools(tools?: any[]): any[] {
  const converted = toolsToWorkerFormat(tools);
  return converted.map((t) => {
    let params = t.parameters && typeof t.parameters === 'object' ? t.parameters : undefined;
    if (!params || typeof params.type !== 'string') {
      params = { type: 'object', properties: {}, ...(params || {}) };
    }
    const { cache_control, ...restParams } = params as Record<string, unknown>;
    return { ...t, parameters: restParams };
  });
}

/**
 * Build the Workers AI request body from an OpenAI Chat Completions body.
 * Sends `messages` array directly (Workers AI accepts OpenAI format).
 */
function buildWorkerBody(body: any): Record<string, unknown> {
  const msg = String(body.model || 'llama-3-8b');
  const workerModel = resolveWorkerModel(msg);
  const stream = body.stream === true;
  const messages = stripIncompatibleFields(body.messages);
  const tools = sanitizeTools(body.tools);

  const workerBody: Record<string, unknown> = {
    messages,
    stream,
  };

  // Optional parameters
  if (body.max_tokens || body.max_completion_tokens) {
    (workerBody as any).max_tokens = body.max_tokens || body.max_completion_tokens;
  }
  if (body.temperature !== undefined) {
    (workerBody as any).temperature = body.temperature;
  }
  if (body.top_p !== undefined) {
    (workerBody as any).top_p = body.top_p;
  }
  if (body.frequency_penalty !== undefined) {
    (workerBody as any).frequency_penalty = body.frequency_penalty;
  }
  if (body.presence_penalty !== undefined) {
    (workerBody as any).presence_penalty = body.presence_penalty;
  }
  if (body.n && body.n > 1) {
    (workerBody as any).n = body.n;
  }
  if (tools.length > 0) {
    (workerBody as any).tools = tools;
  }

  return { model: workerModel, ...workerBody };
}

/** Estimate token usage when Workers AI doesn't provide it in the response */
function estimateUsage(promptText: string, response: string, tools?: any[]): {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
} {
  const promptTokens = Math.ceil((promptText.length + JSON.stringify(tools || []).length) / 3.5);
  const completionTokens = Math.ceil(response.length / 3.5);
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };
}

async function handleChatCompletions(request: Request, env: Env): Promise<Response> {
  const streamId = `chatcmpl-${Date.now()}`;

  // Parse OpenAI request body
  const body = await request.json().catch(() => ({}));
  const model = String(body.model || 'llama-3-8b');
  const stream = body.stream === true;

  // Auth: prefer secret override, else client Bearer
  const clientAuth = request.headers.get('Authorization') || '';
  const apiKey = env.CF_AI_TOKEN || clientAuth.replace(/^Bearer\s+/i, '');

  // Build Workers AI request
  const { model: workerModel, ...workerBody } = buildWorkerBody(body);
  const workerUrl = `https://api.cloudflare.com/client/v4/accounts/${env.CF_AI_ACCOUNT_ID}/ai/run/@cf/${workerModel}`;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const resp = await fetch(workerUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(workerBody),
  });

  if (!resp.ok) {
    const err = await resp.text();
    return new Response(err, { status: resp.status });
  }

  if (!stream) {
    // Non-streaming: unwrap Workers AI response to OpenAI format
    const data = await resp.json();
    const result = data?.result ?? data;

    let openaiResp: any;
    // Workers AI newer models (glm-4.7-flash, etc.) return OpenAI format inside result
    if (result?.choices && Array.isArray(result.choices)) {
      openaiResp = result;
    }
    // Older models (llama-3.1, etc.) return result.response as a string
    else if (typeof result?.response === 'string') {
      const content = result.response;
      const messages = workerBody.messages || [];
      const promptText = messages.map((m: any) => m.content || '').join('');
      const estimatedUsage = estimateUsage(promptText, content, workerBody.tools);
      openaiResp = {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content },
            finish_reason: 'stop',
          },
        ],
        usage: result.usage || estimatedUsage,
      };
    }

    if (!openaiResp) {
      // Fallback: just unwrap result
      openaiResp = result;
    }

    // Ensure the model field reflects the original model name
    openaiResp.model = model;

    return new Response(JSON.stringify(openaiResp), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Streaming: Workers AI SSE is already close to OpenAI format.
  // GLM-4.7-flash returns OpenAI-compatible chunks already (with choices/delta).
  // Llama-3.1 returns {response:"string"} chunks — we convert those to OpenAI delta.
  const encoder = new TextEncoder();
  const sseStream = new ReadableStream({
    async start(controller) {
      const reader = resp.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
            break;
          }

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;

            const data = trimmed.slice(5).trim();
            if (!data || data === '[DONE]') {
              if (data === '[DONE]') {
                controller.enqueue(encoder.encode('data: [DONE]\n\n'));
              }
              continue;
            }

            // Parse SSE data line
            try {
              const parsed = JSON.parse(data);
              // Workers AI may wrap in { success, result }
              const chunk = parsed?.result ?? parsed;

              // Already OpenAI format (glm-4.7-flash, etc.)
              if (chunk?.choices && Array.isArray(chunk.choices)) {
                const workerModelWithPrefix = `@cf/${workerModel}`;
                if (chunk.model === workerModelWithPrefix || chunk.model === workerModel || chunk.model === undefined) {
                  if (chunk.model !== undefined) chunk.model = model;
                }
                controller.enqueue(
                  encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`)
                );
                continue;
              }

              // Old-format response string (llama-3.1, etc.)
              if (typeof chunk?.response === 'string' && chunk?.response) {
                const delta = { content: chunk.response };
                const usage = chunk.usage;
                controller.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({
                      id: streamId,
                      object: 'chat.completion.chunk',
                      created: Math.floor(Date.now() / 1000),
                      model: model,
                      choices: [
                        {
                          index: 0,
                          delta: delta,
                          finish_reason: null,
                        },
                      ],
                      ...(usage ? { usage } : {}),
                    })}\n\n`
                  )
                );
                continue;
              }

              // Fallback: pass through as-is
              controller.enqueue(encoder.encode(`data: ${data}\n\n`));
            } catch {
              // If not JSON, pass through as-is
              controller.enqueue(encoder.encode(`data: ${data}\n\n`));
            }
          }
        }
      } catch (e) {
        controller.error(e);
      }
    },
  });

  return new Response(sseStream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}

async function handleModels(request: Request, env: Env): Promise<Response> {
  const models = [
    { id: 'llama-3-8b', object: 'model', owned_by: 'meta', permission: [], created: 0 },
    { id: 'llama-3-70b', object: 'model', owned_by: 'meta', permission: [], created: 0 },
    { id: 'llama-4-scout', object: 'model', owned_by: 'meta', permission: [], created: 0 },
    { id: 'gemma-7b', object: 'model', owned_by: 'google', permission: [], created: 0 },
    { id: 'qwen-30b', object: 'model', owned_by: 'qwen', permission: [], created: 0 },
    { id: 'qwq-32b', object: 'model', owned_by: 'qwen', permission: [], created: 0 },
    { id: 'mistral-small-3.1', object: 'model', owned_by: 'mistral', permission: [], created: 0 },
    { id: 'kimi-k2.7-code', object: 'model', owned_by: 'moonshotai', permission: [], created: 0 },
    { id: 'glm-4.7-flash', object: 'model', owned_by: 'zai-org', permission: [], created: 0 },
  ];
  return new Response(JSON.stringify({ object: 'list', data: models }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

async function handleWhisper(request: Request, env: Env): Promise<Response> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${env.CF_AI_ACCOUNT_ID}/ai/run/@cf/openai/whisper`;

  const clientAuth = request.headers.get('Authorization') || '';
  const apiKey = env.CF_AI_TOKEN || clientAuth.replace(/^Bearer\s+/i, '');

  const formData = await request.formData();
  const file = formData.get('file') as File | null;

  if (!file) {
    return new Response(JSON.stringify({ error: 'No file provided' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const arrayBuffer = await file.arrayBuffer();
  const base64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ audio: base64 }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    return new Response(err, { status: resp.status });
  }

  const data = await resp.json();
  // Workers AI Whisper returns { result: { text: "..." } }
  return new Response(
    JSON.stringify({
      text: data?.result?.text || '',
      task: data?.result?.task || 'transcribe',
      language: data?.result?.language || 'en',
      duration: data?.result?.duration || 0,
      segments: data?.result?.segments || [],
    }),
    { headers: { 'Content-Type': 'application/json' } }
  );
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/v1/chat/completions' || path === '/chat/completions') {
      return handleChatCompletions(request, env);
    }

    if (path === '/v1/models' || path === '/models') {
      return handleModels(request, env);
    }

    if (path === '/v1/audio/transcriptions' || path === '/audio/transcriptions') {
      return handleWhisper(request, env);
    }

    return new Response(
      JSON.stringify({
        name: 'Workers AI OpenAI Proxy',
        version: '1.0.0',
        description: 'OpenAI-compatible proxy for Cloudflare Workers AI',
        endpoints: {
          chat: '/v1/chat/completions',
          models: '/v1/models',
          whisper: '/v1/audio/transcriptions',
        },
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  },
};

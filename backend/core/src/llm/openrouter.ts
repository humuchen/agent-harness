import type {
  LLM,
  Message,
  ToolSchema,
  LLMResponse,
  LLMCallOptions
} from '../types';
import { toOpenAIMessage, callOpenAIChat, compactToolSchema } from './shared';
import { resolveOpenRouterConfig } from './config';

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
 * 第三个可选参数携带取消信号（超时 / 用户中止），会被透传给 fetch。
 */
export function createOpenRouterLLM(config: OpenRouterConfig = {}): LLM {
  // 集中解析：配置对象 → 环境变量 → 内置默认（agnes-2.5-flash 等常量见 ./config）。
  // resolveOpenRouterConfig 已处理「空串视为未设置」的坑，无需在此重复。
  const {
    apiKey,
    model,
    baseUrl,
    models,
    siteUrl,
    appName,
    fetchImpl,
    retries
  } = resolveOpenRouterConfig(config);

  return async function openRouterLLM(
    messages: Message[],
    tools: ToolSchema[],
    options?: LLMCallOptions
  ): Promise<LLMResponse> {
    if (!apiKey) {
      throw new Error(
        'OpenRouter LLM requires OPEN_API_KEY (or pass apiKey to createOpenRouterLLM).'
      );
    }

    const body: Record<string, unknown> = {
      messages: messages.map(toOpenAIMessage)
    };

    // OpenRouter 支持单个 `model` 或 `models` 降级列表。
    if (models && models.length > 0) {
      body.models = models;
    } else {
      body.model = model;
    }

    if (tools && tools.length > 0) {
      // 压缩工具描述以降低每轮固定 prompt 开销（不影响本地执行语义）。
      const maxDesc = Number(process.env.TOOL_DESC_MAX_CHARS ?? 160) || 160;
      body.tools = tools.map((t) => {
        const c = compactToolSchema(t, maxDesc);
        return {
          type: 'function',
          function: {
            name: c.name,
            description: c.description,
            parameters: c.parameters
          }
        };
      });
      body.tool_choice = 'auto';
    }

    // 请求模型返回「思考过程」（深度思考内容）。agnes 端点以 delta.reasoning_content
    // 流式返回；该字段驱动前端「深度思考」tab 的逐字（打字机）展示。
    // 个别不识别该参数的 provider 可用 LLM_REASONING=off 关闭，避免未知字段报错。
    if (process.env.LLM_REASONING !== 'off') {
      body.reasoning = { enabled: true };
    }

    // OpenRouter 归因请求头（建议附加）。
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'HTTP-Referer': siteUrl,
      'X-Title': appName
    };

    return callOpenAIChat({
      baseUrl,
      headers,
      body,
      fetchImpl,
      retries,
      modelLabel: model,
      signal: options?.signal,
      // 透传流式回调：开启后走 stream:true，逐 delta 回调 token / reasoning，
      // 驱动聊天 UI 打字机与「深度思考」块（此前遗漏，导致始终走非流式分支、推理丢失）。
      onToken: options?.onToken,
      onReasoning: options?.onReasoning
    });
  };
}

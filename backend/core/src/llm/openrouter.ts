import type {
  LLM,
  Message,
  ToolSchema,
  LLMResponse,
  LLMCallOptions
} from '../types';
import { toOpenAIMessage, callOpenAIChat, compactToolSchema } from './shared';
import { resolveOpenRouterConfig } from './config';
import { resolveTierConfig, resolveTierModel } from './model-tier';
import { structLog } from '../telemetry';

export interface OpenRouterConfig {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  // OpenRouter 特有：提供模型列表以实现自动降级
  //（例如 ['openai/gpt-4o-mini', 'anthropic/claude-3.5-sonnet']）。
  // 设置后会作为 `models` 发送，取代单个 `model` 字段。
  models?: string[];
  // 可注入的 fetch（便于测试或代理）。默认使用全局 fetch。
  fetchImpl?: typeof fetch;
  // 对退化响应（内容为空且没有工具调用）以及限流/瞬时故障（HTTP 429/5xx）
  // 进行重试，某些免费/弱模型会间歇性返回空响应或撞上速率限制。
  // 默认重试 2 次。
  retries?: number;
  /**
   * P1-④ 模型分级路由：轻量模型标识（如 openai/gpt-4o-mini）。
   * 配合 `modelTiering: 'auto'` 启用；仅在低风险步（工具结果合成 / 首轮极短问答）
   * 降级到此模型，成本按实际 `resp.model` 记账。
   */
  lightModel?: string;
  /** 模型分级路由总开关：'auto' 启用，'off'（默认）关闭。 */
  modelTiering?: 'auto' | 'off';
}

/**
 * 面向 OpenRouter (https://openrouter.ai) 的真实 LLM 适配器。
 *
 * OpenRouter 实现了 OpenAI Chat Completions 协议，因此与 OpenAI 适配器
 * 使用相同的契约，但额外具备：
 *   - 默认 `baseUrl` 为 https://openrouter.ai/api/v1
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
    fetchImpl,
    retries
  } = resolveOpenRouterConfig(config);
  // 模型分级路由配置（在闭包创建时解析一次；运行期不读 env）。
  const tierCfg = resolveTierConfig(config);

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

    // 模型分级路由：仅在「单模型」模式下生效（`models` 降级数组由上游控制，
    // 不参与 tiers）。合成步 / 首轮短问答降级到轻量模型，其余保持高阶。
    let effectiveModel = model;
    if (!(models && models.length > 0) && tierCfg.enabled && tierCfg.lightModel) {
      const tier = resolveTierModel({ messages, tools, model, cfg: tierCfg });
      effectiveModel = tier.model;
      structLog('info', 'model tier route', {
        tier: tier.tier,
        model: effectiveModel,
        reason: tier.reason,
        promptChars: tier.promptChars
      });
    }

    // OpenRouter 支持单个 `model` 或 `models` 降级列表。
    if (models && models.length > 0) {
      body.models = models;
    } else {
      body.model = effectiveModel;
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
    // 压缩方案4（Token 成本优化）：推理输出也是 token（26 次调用可累计上万）。
    // 检索/工具类任务长思考收益低，可经 env 收窄而不必全关：
    //   - LLM_REASONING_EFFORT=low|medium|high  控制思考深度（OpenRouter reasoning.effort）
    //   - LLM_REASONING_MAX_TOKENS=2048         限制思考 token 上限（reasoning.max_tokens）
    // 未配置时保持 { enabled: true } 原行为，零变更。
    if (process.env.LLM_REASONING !== 'off') {
      const effortRaw = (process.env.LLM_REASONING_EFFORT ?? '').trim().toLowerCase();
      const effort =
        effortRaw === 'low' || effortRaw === 'medium' || effortRaw === 'high'
          ? effortRaw
          : undefined;
      const maxRaw = Number(process.env.LLM_REASONING_MAX_TOKENS);
      const maxTokens =
        Number.isFinite(maxRaw) && maxRaw > 0 ? Math.floor(maxRaw) : undefined;
      body.reasoning = {
        enabled: true,
        ...(effort ? { effort } : {}),
        ...(maxTokens ? { max_tokens: maxTokens } : {}),
      };
    }

    // 请求头。
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    };

    return callOpenAIChat({
      baseUrl,
      headers,
      body,
      fetchImpl,
      retries,
      modelLabel: effectiveModel,
      signal: options?.signal,
      // P1-10 熔断器透传（修复）：LLMCallOptions.circuitBreaker 此前被静默丢弃，
      // 熔断器在真实调用链上从未生效（含非流式路径）。现透传给 callOpenAIChat，
      // 由 fetchWithBreaker 包裹 HTTP 调用。
      circuitBreaker: options?.circuitBreaker,
      // 透传流式回调：开启后走 stream:true，逐 delta 回调 token / reasoning，
      // 驱动聊天 UI 打字机与「深度思考」块（此前遗漏，导致始终走非流式分支、推理丢失）。
      onToken: options?.onToken,
      onReasoning: options?.onReasoning
    });
  };
}

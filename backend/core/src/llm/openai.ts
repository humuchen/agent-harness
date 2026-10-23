import type { LLM, Message, ToolSchema, LLMResponse, LLMCallOptions } from '../types';
import { toOpenAIMessage, callOpenAIChat, compactToolSchema } from './shared';
import { resolveOpenAIConfig } from './config';
import { resolveTierConfig, resolveTierModel } from './model-tier';
import { structLog } from '../telemetry';

export interface OpenAIConfig {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  // 可注入的 fetch（便于测试或代理）。默认使用全局 fetch。
  fetchImpl?: typeof fetch;
  /**
   * P1-④ 模型分级路由：轻量模型标识。配合 `modelTiering: 'auto'` 启用；
   * 仅在低风险步降级到此模型，成本按实际 `resp.model` 记账。
   */
  lightModel?: string;
  /** 模型分级路由总开关：'auto' 启用，'off'（默认）关闭。 */
  modelTiering?: 'auto' | 'off';
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
  // 集中解析：配置对象 → 环境变量 → 内置默认（见 ./config）。
  const { apiKey, model, baseUrl, fetchImpl } = resolveOpenAIConfig(config);
  // 模型分级路由配置（闭包创建时解析一次）。
  const tierCfg = resolveTierConfig(config);

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

    // 模型分级路由：合成步 / 首轮短问答降级到轻量模型。
    let effectiveModel = model;
    if (tierCfg.enabled && tierCfg.lightModel) {
      const tier = resolveTierModel({ messages, tools, model, cfg: tierCfg });
      effectiveModel = tier.model;
      structLog('info', 'model tier route', {
        tier: tier.tier,
        model: effectiveModel,
        reason: tier.reason,
        promptChars: tier.promptChars
      });
    }

    const body: Record<string, unknown> = {
      model: effectiveModel,
      messages: messages.map(toOpenAIMessage),
    };

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
            parameters: c.parameters,
          },
        };
      });
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
      modelLabel: effectiveModel,
      signal: options?.signal,
      // P1-10 熔断器透传（修复）：此前被静默丢弃，熔断器在真实调用链上从未生效。
      circuitBreaker: options?.circuitBreaker,
      onToken: options?.onToken,
      onReasoning: options?.onReasoning,
    });
  };
}

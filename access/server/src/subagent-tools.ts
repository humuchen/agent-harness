/**
 * SubAgent delegate_task 工具注册（P1-③）。
 *
 * 将 `delegate_task` 工具注册到 AgentHarness 的 ToolRegistry 中。
 * 该工具由 LLM 在运行循环中调用，从而派生一个子 agent 执行子任务，
 * 子 agent 拥有独立的记忆窗口（独立 sessionKey）、独立的工具调用循环，
 * 结果通过工具返回值回传给父 agent。
 *
 * server 层在 `assembleAgent` 后 —— 即在构建 AgentHarness 之前 —— 调用本函数，
 * 传入父 agent 的 sessionKey + signal + 运行模式等装配参数。
 */

import type { ToolRegistry, AgentCard } from '@agent-harness/core';
import type { assembleAgent, RunMode } from './runner';
import {
  getSubAgentManager,
  initSubAgentManager,
  getAgentRegistry,
  structLog,
  recordError
} from '@agent-harness/core';
import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * delegate_task 递归深度追踪（AsyncLocalStorage 跨嵌套传播）：
 * 顶层 run 的工具调用 depth=0；子 agent 的工具调用继承父 depth+1。
 * 无上限的递归派发会在「子 agent 再派子 agent」时指数级烧 token / 占满
 * 并发槽，上限默认 3 层（AGENT_DELEGATE_MAX_DEPTH 可调，0=不限）。
 */
const delegateDepth = new AsyncLocalStorage<number>();
const MAX_DELEGATE_DEPTH = Number(process.env.AGENT_DELEGATE_MAX_DEPTH ?? 3) || 0;

/**
 * SubAgent 装配参数（用于 delegate_task 工具内部递归调用 assembleAgent）。
 */
export interface SubAgentAssembleOpts {
  mode: RunMode;
  sessionKey: string;
  signal?: AbortSignal;
  modelOverride?: string;
  maxSteps?: number;
  timeoutMs?: number;
  ctxWindow?: number;
  modelBaseUrl?: string;
  modelApiKey?: string;
  /**
   * 多 Key 负载/故障转移（P2.4）：父 agent 本次 run 可用的全部明文 Key（主 Key + 附加 Key）。
   * 透传给子 agent 的 assembleAgent，使 delegate_task 派生路径与主 run 的 BYOK 多 Key 策略一致。
   */
  apiKeys?: string[];
  /**
   * TypeSafe AI Jev 决策工具按用户 BYOK 注入的 Key/地址（明文）。透传给子 agent，
   * 避免 builtin__jev_decide 在子 agent 内回落 env 造成跨用户串号。
   */
  jevApiKey?: string;
  jevBaseUrl?: string;
  /**
   * 图片附件透传（图片上传修复）：父 agent 带来的图片经本字段下发给子 agent 的
   * harness.run 第 2 参，确保 delegate_task 派生的子 agent 同样具备多模态上下文
   * （此前漏传 → 子 agent 拿不到图片）。类型与 `AgentHarness.run` 的第 2 参一致。
   */
  attachments?: Array<{ url: string; name: string; type: string }>;
}

/**
 * 注册 delegate_task 工具到 ToolRegistry。
 *
 * 由 server 层在 `assembleAgent` 后、将 tools 交给 AgentHarness 之前调用。
 *
 * @param tools - 父 agent 的 ToolRegistry
 * @param opts - 父 agent 的装配参数，用于派生子 agent
 * @param assembleAgentFn - assembleAgent 函数引用（server 层传入，避免 core → server 的循环依赖）
 */
export function registerSubAgentTool(
  tools: ToolRegistry,
  opts: SubAgentAssembleOpts,
  assembleAgentFn: typeof assembleAgent
): void {
  // 确保 SubAgentManager 单例已初始化
  const manager = initSubAgentManager();

  tools.register(
    'delegate_task',
    '派发一个子任务给专门的子 agent 处理。子 agent 拥有独立的记忆窗口、' +
      '独立的工具调用循环，结果通过本工具返回。适用于需要长时间独立工作的子任务' +
      '（如代码重构、文档撰写、批量处理）。',
    {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description:
            '子任务描述：清晻描述需要子 agent 完成的任务目标、输入条件、预期输出格式',
        },
        agent: {
          type: 'string',
          description: '目标 agent 的注册名（如 "default"），留空使用默认 agent',
        },
        maxSteps: {
          type: 'integer',
          description: '子 agent 最大循环步数（工具调用轮次），默认 24',
          default: 24,
        },
        timeoutSec: {
          type: 'integer',
          description: '子 agent 整体超时（秒），默认 300',
          default: 300,
        },
      },
      required: ['task'],
    },
    async (args: Record<string, unknown>): Promise<unknown> => {
      // 递归深度门禁：子 agent 的工具调用落在父 delegateDepth.run(depth+1) 上下文内，
      // 因此这里读到的 store 就是「本次调用所处的派发深度」。
      const depth = delegateDepth.getStore() ?? 0;
      if (MAX_DELEGATE_DEPTH > 0 && depth >= MAX_DELEGATE_DEPTH) {
        structLog('warn', 'delegate_task depth limit reached', {
          depth,
          maxDepth: MAX_DELEGATE_DEPTH,
          sessionKey: opts.sessionKey
        });
        recordError('subagent.depth_limit');
        return {
          type: 'text' as const,
          text:
            `错误：已达到子任务派发深度上限（${MAX_DELEGATE_DEPTH} 层），不再继续派发。` +
            '请基于当前可用信息直接完成任务。',
        };
      }
      const task =
        typeof args.task === 'string' ? args.task : String(args.task ?? '');
      const agentId =
        typeof args.agent === 'string' && args.agent
          ? args.agent
          : 'default';
      const maxSteps =
        typeof args.maxSteps === 'number' ? args.maxSteps : 24;
      const timeoutSec =
        typeof args.timeoutSec === 'number' ? args.timeoutSec : 300;

      if (!task.trim()) {
        return {
          type: 'text' as const,
          text: '错误：task 参数不能为空。',
        };
      }

      // 查询目标 agent card（用于能力收敛）
      let subCard: AgentCard | null = null;
      if (agentId !== 'default') {
        subCard = await getAgentRegistry().get(agentId);
        if (!subCard) {
          return {
            type: 'text' as const,
            text: `警告：agent "${agentId}" 未注册，将使用 default agent。`,
          };
        }
      }

      // 创建子 agent 实例记录
      const inst = manager.create(opts.sessionKey);
      const subSessionKey = inst.sessionKey;

      // 子 agent 超时控制
      const subController = new AbortController();
      const subTimeout = setTimeout(() => {
        subController.abort();
      }, timeoutSec * 1000);

      // 合并父 agent 的 signal
      if (opts.signal) {
        if (opts.signal.aborted) {
          subController.abort();
        } else {
          opts.signal.addEventListener('abort', () => subController.abort(), {
            once: true,
          });
        }
      }

      // 子 agent 的整个执行（含其工具调用）包进 depth+1 上下文：
      // 子 agent 内再调 delegate_task 时读到的深度即 +1，逐层递增至门禁。
      return delegateDepth.run(depth + 1, async (): Promise<unknown> => {
      try {
        manager.markRunning(inst.id);

        // 递归调用 assembleAgent，创建子 agent
        // 透传 subCard 作为 card 参数，使assembleAgent 能正确派生 guardrail scopes
        // （如 medical-aesthetics domain → scopes:['medical-ad']），避免子 agent
        // 活着在「无 scop 缩窄的全局规则」模式下绕开护栏作用域绑定。
        // BYOK 修复：必须把父 agent 的模型凭据（modelOverride/modelBaseUrl/modelApiKey/
        // ctxWindow/apiKeys/jev*）一并透传，否则 real / real-mcp 模式下子 agent 因缺 Key
        // 抛「真实模式需要有效的 LLM API Key」并包装为「子 agent 出错」。
        const assembled = await assembleAgentFn(
          opts.mode,
          undefined, // onEvent —— 子 agent 不透传事件
          subCard?.assembly?.systemPrompt, // systemPrompt
          opts.modelOverride, // modelOverride —— 父 agent 所选自定义模型下发
          task,
          subSessionKey,
          subController.signal,
          timeoutSec * 1000,
          maxSteps,
          undefined, // memoryArg
          undefined, // verifier
          undefined, // verifyMaxRetries
          subCard, // card —— 驱动 deriveGuardrailScopes + assembly 收窄
          undefined, // tenantCtx
          undefined, // sandboxBackend
          undefined, // streamTokens
          undefined, // webEnabled
          undefined, // planPropose
          undefined, // planTask
          opts.modelBaseUrl, // modelBaseUrl —— 自定义 OpenAI 兼容端点
          opts.modelApiKey, // modelApiKey —— BYOK 按用户注入的 LLM Key
          opts.ctxWindow, // ctxWindow —— 上下文窗口上限
          opts.apiKeys, // apiKeys —— 多 Key 负载/故障转移
          opts.jevApiKey, // jevApiKey —— Jev 决策工具 BYOK
          opts.jevBaseUrl // jevBaseUrl
        );

        // 调用子 agent 的 harness.run()，透传父 agent 的图片附件
        const result = await assembled.harness.run(task, opts.attachments);

        manager.complete(inst.id, result);
        return {
          type: 'text' as const,
          text: result,
        };
      } catch (e: any) {
        recordError('subagent.error');
        structLog('error', 'delegate_task failed', {
          error: e?.message ?? String(e),
          sessionKey: opts.sessionKey,
        });
        manager.fail(inst.id, e?.message ?? String(e));
        return {
          type: 'text' as const,
          text: `子 agent 出错：${e?.message ?? String(e)}`,
        };
      } finally {
        clearTimeout(subTimeout);
        // 清理已完成实例
        manager.cleanup(inst.id);
      }
      }); // end delegateDepth.run(depth + 1)
    }
  );
}

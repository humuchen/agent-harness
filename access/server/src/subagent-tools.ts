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

      try {
        manager.markRunning(inst.id);

        // 递归调用 assembleAgent，创建子 agent
        const assembled = await assembleAgentFn(
          opts.mode,
          undefined, // onEvent —— 子 agent 不透传事件
          '',
          subCard?.assembly?.systemPrompt,
          task,
          subSessionKey,
          subController.signal,
          timeoutSec * 1000,
          maxSteps
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
    }
  );
}

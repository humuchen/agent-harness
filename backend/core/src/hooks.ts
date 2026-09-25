/**
 * Hook 生命周期钩子系统（P1-⑥）。
 *
 * 设计目标：为插件 / 外部观察者提供可注册的 agent 运行周期钩子，
 * 让业务逻辑（如审计 / 日志 / 副作用）无需修改 harness 主循环即可介入。
 *
 * 与 PluginModule 的 setup/onStart/onStop/onUnload 不同，Hook 是**面向 agent 运行期间
 * 的可插拔前/后置扩展点**，插件通过 PluginContext.hooks.register() 注册，core 在
 * harness.ts 的关键节点的 hooks.execute() 自动触发。
 *
 * 约定：
 * - 全部钩子上下文可 JSON 序列化（便于日志 / 可观测）
 * - 单个 HookHandler 抛出异常不影响主流程或其它钩子（但必须留痕——此前零日志，
 *   钩子坏了只能靠业务侧「效果消失」反向发现）
 * - 单个处理器有超时保护（AGENT_HOOK_TIMEOUT_MS，默认 10s）：挂死的插件钩子
 *   不再无限滞留，超时后放弃等待并告警；处理器本身仍在后台跑，其副作用自负
 * - 注册返回注销函数，插件 disable 时对称清理
 */
import { structLog } from './telemetry';

/** Hook 名称枚举。 */
export type HookName =
  | 'agent.pre_run'     // run 开始前，可读取 / 记录 prompt
  | 'agent.post_run'    // run 结束后，含 final / trace / cost
  | 'agent.pre_tool'    // 工具调用前，可观测 toolCall
  | 'agent.post_tool'   // 工具调用后，可观测 result / errored
  | 'agent.pre_llm'     // LLM 调用前，可观测 messages
  | 'agent.post_llm';   // LLM 调用后，可观测 response / usage

/** Hook 执行上下文：贯穿 agent 运行周期的共享字段。 */
export interface HookContext {
  /** runId，全局唯一。 */
  runId: string;
  /** 会话 key（记忆分区依据）。 */
  sessionKey: string;
  /** 租户 id（P0.3，可选）。 */
  tenantId?: string;
  /** run 开始时的 prompt。 */
  prompt?: string;
  /** run 结束后的最终结果。 */
  final?: string;
  /** 消耗的 token 数。 */
  tokens?: number;
  /** 消耗成本（美元）。 */
  cost?: number;
  /** 步数。 */
  steps?: number;
  /** 工具调用详情。 */
  toolCall?: { name: string; arguments: Record<string, unknown> };
  /** 工具调用结果。 */
  toolResult?: { output: unknown; errored: boolean };
  /** LLM 请求的消息数组。 */
  messages?: unknown[];
  /** LLM 响应。 */
  response?: string;
  /** LLM 回复的 token 用量。 */
  usage?: { promptTokens?: number; completionTokens?: number };
  /** 额外字段。 */
  [key: string]: unknown;
}

/** Hook 处理函数。 */
export type HookHandler = (ctx: HookContext) => void | Promise<void>;

/**
 * Hook 注册表：按 name -> Set<handler> 聚集，支持注册 / 注销 / 批量执行。
 * 进程单例，通过 `hooks` 导出。
 */
export class HookRegistry {
  private hooks = new Map<HookName, Set<HookHandler>>();

  /** 注册一个 Hook，返回注销函数。 */
  register<T extends Partial<HookContext> = HookContext>(
    name: HookName,
    handler: HookHandler
  ): () => void {
    if (!this.hooks.has(name)) this.hooks.set(name, new Set());
    this.hooks.get(name)!.add(handler);
    return () => {
      const set = this.hooks.get(name);
      if (set) set.delete(handler);
    };
  }

  /**
   * 执行某类 Hook 的所有注册处理器。
   * 单个处理器抛出异常或超时都不影响其它处理器与主流程，但均记 warn 日志留痕。
   * 超时保护：AGENT_HOOK_TIMEOUT_MS（默认 10000，0=不限）。超时后放弃等待——
   * 处理器仍可能在后台完成（其副作用自负），但不再滞留 execute 的调用方。
   */
  async execute<T extends Partial<HookContext> = HookContext>(
    name: HookName,
    ctx: T
  ): Promise<void> {
    const handlers = this.hooks.get(name);
    if (!handlers || handlers.size === 0) return;
    const timeoutMs =
      Math.max(0, Number(process.env.AGENT_HOOK_TIMEOUT_MS ?? 10_000) || 0);
    for (const h of handlers) {
      try {
        if (timeoutMs > 0) {
          await Promise.race([
            Promise.resolve(h(ctx as HookContext)),
            new Promise<never>((_resolve, reject) => {
              const t = setTimeout(
                () => reject(new Error(`hook handler timeout after ${timeoutMs}ms`)),
                timeoutMs
              );
              // 超时定时器不持有事件循环：进程自然退出时不必等挂死的钩子
              t.unref?.();
            }),
          ]);
        } else {
          await h(ctx as HookContext);
        }
      } catch (e) {
        // Hook 异常/超时不影响主流程，但必须留痕（此前静默吞掉，故障不可见）
        structLog('warn', 'hook handler failed', {
          hook: name,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }
}

/** 进程单例 Hook 注册表。 */
export const hooks = new HookRegistry();

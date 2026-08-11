import { LLM, Message, ToolCall, LLMResponse } from './types';
import { ToolRegistry } from './tools';
import { Memory } from './memory';
import { checkInput, checkOutput, checkToolArgs } from './guardrails';
import { withSpan } from './telemetry';

/**
 * Harness 在跑一轮 `run()` 期间发出的事件。
 * 这些事件让外部（CLI 进度条、Web UI、测试探针）无需侵入核心循环即可
 * 实时观察 LLM ↔ 工具 ↔ 记忆 的每一步。纯可选，不影响任何既有行为。
 */
export type HarnessEvent =
  | { type: 'run:start'; runId: string; input: string }
  | { type: 'run:tools'; tools: { name: string; description: string }[] }
  | { type: 'guardrail:blocked'; phase: 'input' | 'output' | 'tool'; reason: string; tool?: string }
  | { type: 'step:start'; step: number; maxSteps: number }
  | { type: 'llm:call'; step: number; messageCount: number; toolCount: number }
  | { type: 'llm:response'; step: number; content: string; toolCalls: ToolCall[] }
  | { type: 'tool:start'; step: number; call: ToolCall }
  | { type: 'tool:result'; step: number; call: ToolCall; result: string; errored: boolean }
  | { type: 'run:end'; runId: string; final: string; steps: number }
  | { type: 'error'; message: string };

export interface HarnessOptions {
  llm: LLM;
  tools: ToolRegistry;
  memory?: Memory;
  systemPrompt?: string;
  // 对 Agent 循环步数的安全上限（工具调用 -> LLM -> 工具调用 ...）。
  maxSteps?: number;
  // 整体运行超时（毫秒）。超时后中止循环并返回超时提示，避免长时间挂起。
  timeoutMs?: number;
  // 外部取消信号；触发后中止运行（例如用户关闭 UI、进程收到 SIGTERM）。
  signal?: AbortSignal;
  // 可选的事件回调：在循环每一步（LLM 调用 / 工具调用 / 护栏拦截）发生时触发。
  // 用于进度展示、可视化与测试断言，不修改任何业务逻辑。
  onEvent?: (e: HarnessEvent) => void;
}

// 经默认值填充后的解析结果类型：onEvent 永不为空。
interface ResolvedHarnessOptions {
  llm: LLM;
  tools: ToolRegistry;
  memory: Memory;
  systemPrompt: string;
  maxSteps: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  onEvent: (e: HarnessEvent) => void;
}

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${Date.now()}_${idCounter}`;
}

export class AgentHarness {
  private opts: ResolvedHarnessOptions;

  constructor(opts: HarnessOptions) {
    this.opts = {
      maxSteps: 12,
      memory: new Memory(),
      systemPrompt: 'You are a helpful assistant with access to tools.',
      onEvent: () => {},
      ...opts,
    };
  }

  /** 向长期记忆追加一条笔记（会随下次运行的系统提示词注入给模型）。 */
  remember(note: string): void {
    this.opts.memory.remember(note);
  }

  /** 读取当前长期记忆笔记列表。 */
  notes(): string[] {
    return this.opts.memory.notes();
  }

  async run(userInput: string): Promise<string> {
    const runId = nextId('run');
    const emit = (e: HarnessEvent) => this.opts.onEvent?.(e);

    // 组合「超时」与「外部取消」为单一信号：任一触发即中止本次运行。
    const controller = new AbortController();
    const onExternalAbort = () => controller.abort('external');
    if (this.opts.signal) {
      if (this.opts.signal.aborted) controller.abort('external');
      else this.opts.signal.addEventListener('abort', onExternalAbort, { once: true });
    }
    const timeout =
      this.opts.timeoutMs && this.opts.timeoutMs > 0
        ? setTimeout(() => controller.abort('timeout'), this.opts.timeoutMs)
        : null;
    const signal = controller.signal;
    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      if (this.opts.signal) this.opts.signal.removeEventListener('abort', onExternalAbort);
    };

    emit({ type: 'run:start', runId, input: userInput });

    const guard = checkInput(userInput);
    if (!guard.ok) {
      emit({ type: 'guardrail:blocked', phase: 'input', reason: guard.reason ?? 'unknown' });
      const msg = `[guardrail] blocked: ${guard.reason}`;
      cleanup();
      emit({ type: 'run:end', runId, final: msg, steps: 0 });
      return msg;
    }

    const memory = this.opts.memory;

    // 若配置了持久化路径，先载入历史记忆（窗口 + 长期笔记）。
    if (memory.hasPersistence) {
      try {
        await memory.load();
      } catch {
        /* 首次运行无存档，忽略 */
      }
    }

    // 将长期记忆注入系统提示词，使模型能看到跨运行的上下文。
    const ctx = memory.systemContext();
    const sysContent =
      ctx && this.opts.systemPrompt
        ? `${this.opts.systemPrompt}\n\n${ctx}`
        : this.opts.systemPrompt;
    if (sysContent && !memory.history().some((m) => m.role === 'system')) {
      memory.add({ role: 'system', content: sysContent });
    }
    memory.add({ role: 'user', content: userInput });

    let final = '[agent] reached max steps without a final answer';
    let steps = 0;
    try {
      final = await withSpan('agent.run', async () => {
        for (let step = 0; step < this.opts.maxSteps; step++) {
          // 进入下一步前先检查取消信号，避免对已中止的运行继续消耗工具/LLM。
          if (signal.aborted) {
            return abortedMessage(signal);
          }
          steps = step + 1;
          emit({ type: 'step:start', step: steps, maxSteps: this.opts.maxSteps });

          const messages = memory.history();
          emit({
            type: 'llm:call',
            step: steps,
            messageCount: messages.length,
            toolCount: this.opts.tools.schemas().length,
          });

          // 用 Promise.race 让「中止」能打断一个永不 settles 的 LLM 调用，
          // 即使底层适配器未尊重 signal 也能及时退出。
          const llmPromise = this.opts.llm(messages, this.opts.tools.schemas(), { signal });
          const abortedFlag = new Promise<'__aborted__'>((resolve) => {
            if (signal.aborted) return resolve('__aborted__');
            signal.addEventListener('abort', () => resolve('__aborted__'), { once: true });
          });
          const raceResult = await withSpan('llm.call', () => Promise.race([llmPromise, abortedFlag]));
          if (raceResult === '__aborted__') {
            return abortedMessage(signal);
          }
          const resp: LLMResponse = raceResult;

          const outGuard = checkOutput(resp.content);
          if (!outGuard.ok) {
            emit({ type: 'guardrail:blocked', phase: 'output', reason: outGuard.reason ?? 'unknown' });
            return `[guardrail] blocked: ${outGuard.reason}`;
          }

          emit({ type: 'llm:response', step: steps, content: resp.content, toolCalls: resp.tool_calls });
          memory.add({
            role: 'assistant',
            content: resp.content,
            tool_calls: resp.tool_calls,
          });

          if (!resp.tool_calls || resp.tool_calls.length === 0) {
            return resp.content;
          }

          // 执行每个请求的工具调用，并将结果以 tool 消息形式回传给 LLM。
          for (const call of resp.tool_calls) {
            if (signal.aborted) {
              return abortedMessage(signal);
            }
            const argGuard = checkToolArgs(call.name, call.arguments);
            let result: unknown;
            let errored = false;
            if (!argGuard.ok) {
              result = `guardrail blocked: ${argGuard.reason}`;
              errored = true;
              emit({
                type: 'guardrail:blocked',
                phase: 'tool',
                tool: call.name,
                reason: argGuard.reason ?? 'unknown',
              });
            } else {
              emit({ type: 'tool:start', step: steps, call });
              try {
                result = await withSpan(`tool.${call.name}`, async () =>
                  this.opts.tools.call(call.name, call.arguments)
                );
              } catch (e: any) {
                // 将错误作为工具结果返回，以便模型自行修复。
                result = `tool error: ${e?.message ?? String(e)}`;
                errored = true;
              }
            }
            const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
            emit({ type: 'tool:result', step: steps, call, result: resultStr, errored });
            memory.add({
              role: 'tool',
              tool_call_id: call.id,
              name: call.name,
              content: resultStr,
            });
          }
        }
        return '[agent] reached max steps without a final answer';
      });
    } catch (e: any) {
      emit({ type: 'error', message: e?.message ?? String(e) });
      final = `[error] ${e?.message ?? String(e)}`;
    }

    // 运行结束，若有持久化路径则落盘（best-effort）。
    if (memory.hasPersistence) {
      try {
        await memory.save();
      } catch {
        /* 存档失败不应影响已产出的结果 */
      }
    }

    cleanup();
    emit({ type: 'run:end', runId, final, steps });
    return final;
  }
}

/** 根据中止原因生成人类可读的结果提示。 */
function abortedMessage(signal: AbortSignal): string {
  const reason = (signal as { reason?: unknown }).reason;
  if (reason === 'timeout') return '[timeout] run exceeded time limit';
  if (reason === 'external') return '[aborted] run cancelled by caller';
  return '[aborted] run cancelled';
}

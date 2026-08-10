import { LLM, Message, ToolCall } from './types';
import { ToolRegistry } from './tools';
import { Memory } from './memory';
import { checkInput, checkOutput, checkToolArgs } from './guardrails';
import { withSpan } from './telemetry';

export interface HarnessOptions {
  llm: LLM;
  tools: ToolRegistry;
  memory?: Memory;
  systemPrompt?: string;
  // 对 Agent 循环步数的安全上限（工具调用 -> LLM -> 工具调用 ...）。
  maxSteps?: number;
}

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${Date.now()}_${idCounter}`;
}

export class AgentHarness {
  private opts: Required<HarnessOptions>;

  constructor(opts: HarnessOptions) {
    this.opts = {
      maxSteps: 12,
      memory: new Memory(),
      systemPrompt: 'You are a helpful assistant with access to tools.',
      ...opts,
    };
  }

  async run(userInput: string): Promise<string> {
    const guard = checkInput(userInput);
    if (!guard.ok) {
      return `[guardrail] blocked: ${guard.reason}`;
    }

    const memory = this.opts.memory;
    if (
      this.opts.systemPrompt &&
      !memory.history().some((m) => m.role === 'system')
    ) {
      memory.add({ role: 'system', content: this.opts.systemPrompt });
    }
    memory.add({ role: 'user', content: userInput });

    return withSpan('agent.run', async () => {
      for (let step = 0; step < this.opts.maxSteps; step++) {
        const messages = memory.history();
        const resp = await withSpan('llm.call', () =>
          this.opts.llm(messages, this.opts.tools.schemas())
        );

        const outGuard = checkOutput(resp.content);
        if (!outGuard.ok) {
          return `[guardrail] blocked: ${outGuard.reason}`;
        }

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
          const argGuard = checkToolArgs(call.name, call.arguments);
          let result: unknown;
          if (!argGuard.ok) {
            result = `guardrail blocked: ${argGuard.reason}`;
          } else {
            result = await withSpan(`tool.${call.name}`, async () => {
              try {
                return await this.opts.tools.call(call.name, call.arguments);
              } catch (e: any) {
                // 将错误作为工具结果返回，以便模型自行修复。
                return `tool error: ${e?.message ?? String(e)}`;
              }
            });
          }
          memory.add({
            role: 'tool',
            tool_call_id: call.id,
            name: call.name,
            content: typeof result === 'string' ? result : JSON.stringify(result),
          });
        }
      }
      return '[agent] reached max steps without a final answer';
    });
  }
}

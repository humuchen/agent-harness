// 助手回合事件链（runInner 段 E7）：流式回退 → llm:response → post_llm hook →
// assistant 消息入窗。P1#21 H2 自 runInner 迁出，语句顺序与语义逐字等价。
import type { LLMResponse, ToolCall } from '../../types';
import type { Memory } from '../../memory';
import { hooks } from '../../hooks';
import type { HarnessEvent } from '../types';

export interface AssistantTurnInput {
  resp: LLMResponse;
  /** 本步是否已收到真实流式增量（未收到且开启 streamTokens 时整段回退为单 token）。 */
  streamedTokens: boolean;
  streamTokensEnabled?: boolean;
  steps: number;
  runId: string;
  tenantId?: string;
  messages: ReadonlyArray<{ role: string; content?: unknown; tool_calls?: unknown }>;
  memory: Memory;
  emit: (e: HarnessEvent) => void;
}

export function emitAssistantTurn(input: AssistantTurnInput): void {
  const { resp, memory, emit } = input;
  // 流式回退：开启了 streamTokens 但适配器并未逐 delta 回调（mock / 不支持 stream），
  // 则把整段内容作为单个 token 发出，确保聊天 UI 仍能渲染（无打字动画，但内容完整）。
  if (input.streamTokensEnabled && !input.streamedTokens && resp.content) {
    emit({ type: 'llm:token', step: input.steps, delta: resp.content });
  }

  emit({
    type: 'llm:response',
    step: input.steps,
    content: resp.content,
    toolCalls: resp.tool_calls,
    partial: resp.partial
  });
  // Hook: agent.post_llm — observe response after LLM call
  void hooks.execute('agent.post_llm', {
    runId: input.runId,
    sessionKey: input.runId,
    tenantId: input.tenantId,
    response: resp.content,
    toolCalls: resp.tool_calls,
    messages: [...input.messages],
  });
  memory.add({
    role: 'assistant',
    content: resp.content,
    tool_calls: resp.tool_calls as ToolCall[] | undefined
  });
}

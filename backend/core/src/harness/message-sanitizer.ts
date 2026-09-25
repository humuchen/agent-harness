/**
 * 消息序列净化与工具调用收集（P1-2：从 harness.ts 拆出）。
 *
 * 职责：
 *   - sanitizeToolPairing：清洗消息序列中的 tool 配对断裂（孤儿 tool 结果 /
 *     孤儿 tool_call），保证发给 LLM 的请求不会因 id 不匹配被拒；
 *   - collectToolCalls：从对话历史收集所有工具调用（供验证上下文统计）。
 *
 * 两者均为 Message[] 上的纯变换：只清洗发出去的副本，不动 Memory 里的存储。
 */
import type { Message, ToolCall } from '../types';

/** 从对话历史收集所有工具调用（供验证上下文统计）。 */
export function collectToolCalls(messages: Message[]): ToolCall[] {
  const out: ToolCall[] = [];
  for (const m of messages) {
    if (m.role === 'assistant' && m.tool_calls) out.push(...m.tool_calls);
  }
  return out;
}

/**
 * 清洗消息序列中的 tool 配对断裂，保证发给 LLM 的请求不会因 id 不匹配被拒。
 *
 * OpenAI 兼容协议（OpenRouter / MiniMax / OpenAI 等）对两类断裂都会直接 400：
 *  - **孤儿 tool 结果**：存在 `role=tool`，但前面没有声明过同 id 的 tool_call
 *    → `invalid_request_error: tool result 的 tool id 未找到`；
 *  - **孤儿 tool_call**：assistant 声明了 tool_calls 却没有紧跟对应结果
 *    → `tool_calls 必须紧跟对应的 tool 消息`。
 *
 * 成因不止一种：滑动窗口从「assistant + 其 tool 结果」中间切断、上一轮被中止后
 * 持久化的半截历史、模型返回重复/缺失的 tool_call id。与其逐个堵，不如在每次
 * 发送前统一净化一次 —— 只清洗发出去的副本，不动 Memory 里的存储。
 */
export function sanitizeToolPairing(messages: Message[]): Message[] {
  const pending = new Set<string>();
  const out: Message[] = [];
  for (const m of messages) {
    if (m.role === 'tool') {
      const id = m.tool_call_id ?? '';
      // 只保留能匹配到「前面已声明且尚未消费」的调用的结果。
      if (id && pending.has(id)) {
        pending.delete(id);
        out.push(m);
      }
      continue;
    }
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      const ids = m.tool_calls
        .map((tc) => tc.id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0);
      if (ids.length === 0) {
        out.push({ ...m, tool_calls: [] });
        continue;
      }
      out.push(m);
      for (const id of ids) pending.add(id);
      continue;
    }
    out.push(m);
  }
  if (pending.size === 0) return out;
  // 收尾：把始终没有等来结果的孤儿 tool_call 从 assistant 上摘掉，
  // 否则「声明了调用却没有结果」同样会被 provider 拒绝。
  return out.map((m) => {
    if (
      m.role === 'assistant' &&
      Array.isArray(m.tool_calls) &&
      m.tool_calls.some((tc) => pending.has(tc.id))
    ) {
      return { ...m, tool_calls: m.tool_calls.filter((tc) => !pending.has(tc.id)) };
    }
    return m;
  });
}

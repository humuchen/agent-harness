/**
 * 工具调用去重 key（P1-2：从 harness.ts 拆出）。
 *
 * 把工具名 + 参数归一化为稳定字符串，用于去重比较
 * （参数 key 排序，忽略字段顺序差异）。
 * 纯函数，无副作用。
 */
import type { ToolCall } from '../types';

/** 把工具名 + 参数归一化为稳定字符串，用于去重比较（参数 key 排序，忽略字段顺序差异）。 */
export function stableToolKey(call: ToolCall): string {
  let args: unknown = call.arguments;
  try {
    if (typeof args === 'string') args = JSON.parse(args as string);
  } catch {
    /* 保留原字符串 */
  }
  let norm: unknown = args;
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(args as Record<string, unknown>).sort()) {
      sorted[k] = (args as Record<string, unknown>)[k];
    }
    norm = sorted;
  }
  let argStr: string;
  try {
    argStr = JSON.stringify(norm);
  } catch {
    argStr = String(args);
  }
  return `${call.name}::${argStr}`;
}

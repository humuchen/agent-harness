/**
 * 工具错误归一（简单形态）：统一返回 { error: true, message } 结构回灌模型自愈。
 *
 * 适用：以「error 布尔 + 可读消息」为契约的工具（customer-service / memo）。
 * 领域化错误体系（如 medical-aesthetics-lead 的 MaError.toJSON，带 code/retryable）
 * 是插件对模型的领域语言，保留在插件内，不强并。
 */
export interface SimpleErrorResult {
  error: true;
  message: string;
}

/** 把任意异常规范化为简单错误结果（绝不向调用方抛错中断主循环）。 */
export function simpleErrorResult(e: unknown): SimpleErrorResult {
  const message =
    e instanceof Error
      ? e.message
      : typeof e === 'string'
        ? e
        : 'unknown error';
  return { error: true, message };
}

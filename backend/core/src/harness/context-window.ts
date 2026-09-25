/**
 * 上下文窗口工具（P1-2：从 harness.ts 拆出）。
 *
 * 职责：
 *   - contextWindowFor：解析当前生效的上下文窗口上限（token），
 *     导出供 server（/api/state）向前端下发；
 *   - isContextOverflowError：判断错误是否由「上下文超出模型窗口」引起
 *     （用于压缩后自愈重试）；
 *   - 窗口常量（回退基线 / 保守预算上限）。
 *
 * 纯函数模块：只读 process.env，无任何副作用。
 */

/** 上下文窗口上限（token）：用于「上下文用量」占比分母。
 *  已废弃按模型名硬编码的猜测表 —— 各模型真实 context_length 由前端从
 *  OpenRouter 模型目录获取并随 run 下发；此处仅保留 AH_CONTEXT_WINDOW
 *  显式覆盖与保守兜底（仅影响未携带窗口数据的旧客户端）。 */
export const FALLBACK_CONTEXT_WINDOW = 128000;

/** 导出供 server（/api/state）向前端下发当前模型的上下文窗口上限。 */
export function contextWindowFor(model?: string): number {
  const env = Number(process.env.AH_CONTEXT_WINDOW);
  if (env > 0) return env;
  return FALLBACK_CONTEXT_WINDOW;
}

/**
 * 判断错误是否由「上下文超出模型窗口」引起（用于压缩后自愈重试）。
 * 覆盖常见的 400 / 413 及中英文错误文案（部分免费模型如 MiniMax 返回中文报错）。
 */
export function isContextOverflowError(e: unknown): boolean {
  if (!e) return false;
  const r =
    typeof e === 'object'
      ? (e as {
          status?: unknown;
          statusCode?: unknown;
          response?: { status?: unknown };
          message?: unknown;
          body?: unknown;
          error?: { message?: unknown };
        })
      : {};
  const status = r.status ?? r.statusCode ?? r.response?.status;
  if (status === 413) return true;
  const text = [
    r.message,
    r.body,
    r.error?.message,
    typeof e === 'string' ? e : ''
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return /context length|context_length|maximum context|max(imum)? (context|token)|too many tokens|exceeds.*(context|window)|prompt.*too long|reduce.*prompt|token limit|上下文|超出.*(窗口|长度|上下文|限制)/i.test(
    text
  );
}

/** 未知上下文窗口时的保守预算上限：宁可压得多、绝不溢出（模型无回应比多压几条历史更糟）。 */
export const BUDGET_FALLBACK_WINDOW = 32768;

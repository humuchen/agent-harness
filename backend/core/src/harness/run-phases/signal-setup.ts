// run 装配段：组合「外部取消」与「超时」为单一信号（P1#21 自 runInner 迁出，逐字等价）。
import type { RunSignalSetup } from '../run-context';

/**
 * @param externalSignal 调用方传入的取消信号（opts.signal；可 undefined）。
 * @param timeoutMs 运行级超时（opts.timeoutMs；0/undefined = 不限时）。
 */
export function setupRunSignal(
  externalSignal: AbortSignal | undefined,
  timeoutMs: number | undefined
): RunSignalSetup {
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort('external');
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort('external');
    else
      externalSignal.addEventListener('abort', onExternalAbort, {
        once: true
      });
  }
  const timeout =
    timeoutMs && timeoutMs > 0
      ? setTimeout(() => controller.abort('timeout'), timeoutMs)
      : null;
  const signal = controller.signal;
  const cleanup = () => {
    if (timeout) clearTimeout(timeout);
    if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
  };
  return { signal, cleanup };
}

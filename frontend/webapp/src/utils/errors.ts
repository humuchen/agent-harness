/**
 * 统一错误提示出口（归一化文案 + ah-notification）。
 * ----------------------------------------------------------------
 * 全站接口报错只走这一个函数：先把异常交给 ./error-message.ts 归一化成人话，
 * 再用 ah-notification 弹出。此前每个面板各自 `String(e?.message ?? e)` 塞进
 * 内联红条，同一类问题在 UI 上有七八种说法；这里收敛为唯一口径 + 唯一展示位。
 */
import { notify, type NotificationOptions } from '../components/ah-notification';
import { errorMessage, isAbortError } from './error-message';

export { errorMessage, errorStatus, isAbortError } from './error-message';

/** notifyError 的可选项。 */
export interface NotifyErrorOptions {
  /** 无法识别异常时的兜底文案。 */
  fallback?: string;
  /** 加粗标题（如「插件管理」「修改密码」）。 */
  title?: string;
  /** 去重键：轮询 / 高频接口建议传，避免重复刷屏。 */
  key?: string;
  /** 覆盖默认停留时长（ms）。 */
  duration?: number;
}

/**
 * 统一错误提示：把异常归一化后用 notification 弹出。
 * - 用户主动中止（AbortError / UserStoppedRun）静默跳过；
 * - 未指定 key 时，相同文案在短时间内会自动合并为 ×N（见 ah-notification）。
 *
 * @returns 弹出的通知 id；被跳过（中止类错误）时返回 -1。
 */
export function notifyError(e: unknown, opts: NotifyErrorOptions = {}): number {
  if (isAbortError(e)) return -1;
  const payload: NotificationOptions = {
    message: errorMessage(e, opts.fallback ?? '操作失败，请稍后重试'),
    type: 'error',
    ...(opts.title ? { title: opts.title } : {}),
    ...(opts.key ? { key: opts.key } : {}),
    ...(typeof opts.duration === 'number' ? { duration: opts.duration } : {})
  };
  return notify.show(payload);
}

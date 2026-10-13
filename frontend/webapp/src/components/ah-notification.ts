/**
 * ah-notification：命令式 API 入口（notify 单例）。
 * ----------------------------------------------------------------
 * 状态机与渲染分别迁至 ah-notification.svelte.ts / ah-notification.svelte；
 * 本模块只保留原有 `notify` 公开 API（show / success / error / warning / info /
 * close / clear / configure）与类型导出，调用方 import 路径与用法零改动。
 */
import {
  showNotification,
  closeNotification,
  clearNotifications,
  configureNotifications
} from './ah-notification.svelte';

export type {
  NotificationType,
  NotificationPlacement,
  NotificationOptions
} from './ah-notification.svelte';

/** 去掉 message 字段的选项（各语法糖方法用）。 */
type MessageOptions = Omit<import('./ah-notification.svelte').NotificationOptions, 'message' | 'type'>;

export interface NotificationConfig {
  placement?: import('./ah-notification.svelte').NotificationPlacement;
  max?: number;
}

export const notify = {
  /** 通用入口。 */
  show(opts: import('./ah-notification.svelte').NotificationOptions): number {
    return showNotification(opts);
  },
  success(message: string, opts?: MessageOptions): number {
    return showNotification({ ...opts, message, type: 'success' });
  },
  error(message: string, opts?: MessageOptions): number {
    return showNotification({ ...opts, message, type: 'error' });
  },
  warning(message: string, opts?: MessageOptions): number {
    return showNotification({ ...opts, message, type: 'warning' });
  },
  info(message: string, opts?: MessageOptions): number {
    return showNotification({ ...opts, message, type: 'info' });
  },
  /** 关闭指定通知。 */
  close(id: number): void {
    closeNotification(id);
  },
  /** 清空全部通知。 */
  clear(): void {
    clearNotifications();
  },
  /** 全局配置（位置 / 同屏上限）。 */
  configure(cfg: NotificationConfig): void {
    configureNotifications(cfg);
  }
};

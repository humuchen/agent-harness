/**
 * 本地通知插件封装（Capacitor @capacitor/local-notifications）
 *
 * 替换浏览器 Notification API：
 * - 浏览器 Notification 在 Capacitor WebView 中不可用
 * - Capacitor LocalNotifications 使用原生系统通知
 */
import { LocalNotifications } from '@capacitor/local-notifications';
import { getPlugins } from '../bridge/register-plugins';

export interface NotificationController {
  /** 请求通知权限 */
  requestPermission(): Promise<{ granted: boolean }>;
  /** 立刻显示本地通知 */
  display(options: {
    title: string;
    body: string;
    id?: string;
  }): Promise<void>;
}

export const notificationController: NotificationController = {
  async requestPermission() {
    const { isNative } = getPlugins();
    if (!isNative) {
      // 浏览器环境，使用浏览器 Notification API
      if (typeof Notification === 'undefined') return { granted: false };
      const perm = await Notification.requestPermission();
      return { granted: perm === 'granted' };
    }
    try {
      const result = await LocalNotifications.requestPermissions();
      return { granted: result.display === 'granted' };
    } catch {
      return { granted: false };
    }
  },
  async display(options) {
    const { isNative } = getPlugins();
    if (!isNative) {
      // 浏览器环境
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted') {
        return;
      }
      try {
        const n = new Notification(options.title, { body: options.body });
        n.onclick = () => { window.focus(); n.close(); };
      } catch { /* ignore */ }
      return;
    }
    // 原生环境
    try {
      await LocalNotifications.schedule({
        notifications: [{
          title: options.title,
          body: options.body,
          id: Math.floor(Math.random() * 100000),
          sound: null,
          smallIcon: 'ic_stat_icon_sample',
        }]
      });
    } catch { /* ignore */ }
  }
};

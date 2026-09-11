/**
 * 推送通知插件封装（接口 + 默认实现）
 *
 * 对接 server 端 P1-2 审计事件 / IM 回调（P0-2），
 * 移动端仅做 FCM/APNs 投递层，事件源在 server 侧。
 */
import { getPlugins } from '../bridge/register-plugins';

export interface PushNotificationController {
  /** 请求推送权限并注册设备 */
  register(): Promise<void>;
  /** 监听推送到达事件 */
  onNotification(handler: (notification: unknown) => void): void;
}

/**
 * 默认实现：通过 Capacitor PushNotifications 插件注册设备。
 * 测试时可注入 mock。
 */
export const pushNotificationController: PushNotificationController = {
  async register() {
    const { pushNotifications, isNative } = getPlugins();
    if (!isNative) return;
    const perm = await pushNotifications.requestPermissions();
    if (perm.receive === 'granted') {
      await pushNotifications.register();
    }
  },
  onNotification(handler) {
    const { pushNotifications, isNative } = getPlugins();
    if (!isNative) return;
    pushNotifications.addListener('pushNotificationReceived', handler as any);
  }
};

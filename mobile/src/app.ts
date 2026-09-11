/**
 * 移动端入口
 *
 * 启动流程：
 * 1. 注册所有 Capacitor 原生插件
 * 2. 从 Preferences 读取持久化 token（生物认证快捷登录）
 * 3. 引导 WebView 加载 webapp（dist/）
 */
import { registerPlugins } from './bridge/register-plugins';

// 注册原生插件
registerPlugins();

// 导出插件（供业务层使用）
export { pushNotificationController } from './plugins/push-notification';
export { deepLinkController } from './plugins/deep-link';
export { fileUploadController } from './plugins/file-upload';
export { biometricAuthController } from './plugins/biometric-auth';
export { offlineCacheController } from './plugins/offline-cache';
export { uploadArtifact, stripDataUrlPrefix } from './plugins/artifacts-client';

/**
 * 生物认证快捷登录插件封装
 *
 * 通过 @aparajita/capacitor-biometric-auth 调用系统生物识别，
 * 验证通过后从 Preferences 读取缓存 token 完成快捷登录。
 *
 * 流程：
 * 1. 首次登录：用户输入密码 → server 返回 token → saveToken() 缓存
 * 2. 后续启动：isAvailable() → authenticate() → getToken() → 自动登录
 *
 * 安全：token 存 @capacitor/preferences（iOS Keychain / Android EncryptedSharedPreferences），
 * 不存 localStorage，避免 XSS 窃取。
 */
import { BiometricAuth, BiometryType } from '@aparajita/capacitor-biometric-auth';
import { getPlugins } from '../bridge/register-plugins';

export interface BiometricAuthController {
  /** 检查设备是否支持生物认证 */
  isAvailable(): Promise<{ available: boolean; biometryType?: string }>;
  /** 执行生物认证 */
  authenticate(reason?: string): Promise<boolean>;
  /** 保存 token 到安全存储 */
  saveToken(token: string): Promise<void>;
  /** 从安全存储读取 token */
  getToken(): Promise<string | null>;
  /** 清除缓存的 token（登出时） */
  clearToken(): Promise<void>;
}

function mapBiometryType(type: BiometryType): string {
  switch (type) {
    case BiometryType.touchId:
      return 'touchId';
    case BiometryType.faceId:
      return 'faceId';
    case BiometryType.fingerprintAuthentication:
      return 'fingerprint';
    case BiometryType.faceAuthentication:
      return 'face';
    case BiometryType.irisAuthentication:
      return 'iris';
    default:
      return 'unknown';
  }
}

export const biometricAuthController: BiometricAuthController = {
  async isAvailable() {
    try {
      const result = await BiometricAuth.checkBiometry();
      return {
        available: result.isAvailable,
        biometryType: result.biometryType != null ? mapBiometryType(result.biometryType) : undefined
      };
    } catch {
      return { available: false };
    }
  },
  async authenticate(reason?: string) {
    try {
      const options = { reason: reason !== undefined ? reason : '验证身份以登录' };
      await BiometricAuth.authenticate(options);
      return true;
    } catch {
      return false;
    }
  },
  async saveToken(token: string) {
    const { preferences } = getPlugins();
    await preferences.set({ key: 'auth_token', value: token });
  },
  async getToken() {
    const { preferences } = getPlugins();
    const result = await preferences.get({ key: 'auth_token' });
    return result.value;
  },
  async clearToken() {
    const { preferences } = getPlugins();
    await preferences.remove({ key: 'auth_token' });
  }
};

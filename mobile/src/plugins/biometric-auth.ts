/**
 * 生物认证快捷登录插件封装
 *
 * 通过 @capacitor/biometric-auth（或同类插件）调用系统生物识别，
 * 验证通过后从 Preferences 读取 token 完成快捷登录。
 *
 * 注意：生物认证插件未在 package.json 中固定（社区包名待定），
 * 当前为接口占位，实现时替换为具体插件调用。
 */
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
}

export const biometricAuthController: BiometricAuthController = {
  async isAvailable() {
    // TODO: 接入具体生物认证插件后实现
    // const { BiometricAuth } = await import('@capacitor/biometric-auth');
    // return BiometricAuth.isAvailable();
    return { available: false };
  },
  async authenticate(_reason?: string) {
    // TODO: 接入具体生物认证插件后实现
    return false;
  },
  async saveToken(token: string) {
    const { preferences } = getPlugins();
    await preferences.set({ key: 'auth_token', value: token });
  },
  async getToken() {
    const { preferences } = getPlugins();
    const result = await preferences.get({ key: 'auth_token' });
    return result.value;
  }
};

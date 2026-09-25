/**
 * 生物认证快捷登录插件封装
 *
 * 通过 @aparajita/capacitor-biometric-auth 调用系统生物识别，
 * 验证通过后从安全缓存读取 token 完成快捷登录。
 *
 * 流程：
 * 1. 首次登录：用户输入密码 → server 返回 token → saveToken() 缓存
 * 2. 后续启动：isAvailable() → authenticate() → getToken() → 自动登录
 *
 * 安全（P1 修复，注释与实现保持一致）：
 * - token 以 AES-GCM 密文落 @capacitor/preferences，密钥为「每次安装随机生成」
 *   的 256-bit 值（与密文分键存放）。此前明文落盘且注释谎称
 *   EncryptedSharedPreferences/Keychain——@capacitor/preferences 在 Android 上
 *   底层是明文 SharedPreferences，iOS 上是 UserDefaults，均非加密存储。
 * - 盘上加密 + AndroidManifest allowBackup=false / dataExtractionRules 双层缓解
 *   「root 提取 / 云备份导出」。注意：密钥与密文同位于 Preferences，防的是
 *   备份导出与误泄露，不防「已 root 的本地攻击者同时拿到两者」——彻底解法需引入
 *   原生 Keychain/Keystore 安全存储插件（后续项，见评估报告 P1 P4 修复说明）。
 * - WebCrypto 不可用（极旧 WebView）时拒绝缓存 token（fail-safe：快捷登录不可用，
 *   用户手输密码登录），绝不静默回落明文。
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

const TOKEN_KEY = 'auth_token'; // 存 AES-GCM 信封（iv:ct，base64）
const KEY_KEY = 'auth_token_key'; // 存每安装随机的 AES-256 密钥（base64）

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

function bufToB64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

function b64ToBuf(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

/** subtle 不可用（非安全上下文 / 极旧 WebView）→ 拒绝缓存凭据，fail-safe。 */
function subtleOk(): boolean {
  return typeof crypto !== 'undefined' && !!crypto.subtle;
}

/** 取（或首次生成）每安装随机的 AES-256-GCM 密钥。 */
async function getAesKey(): Promise<CryptoKey> {
  const { preferences } = getPlugins();
  const existing = (await preferences.get({ key: KEY_KEY })).value;
  let raw: Uint8Array;
  if (existing) {
    raw = new Uint8Array(b64ToBuf(existing));
  } else {
    raw = crypto.getRandomValues(new Uint8Array(32));
    await preferences.set({ key: KEY_KEY, value: bufToB64(raw.buffer as ArrayBuffer) });
  }
  return crypto.subtle.importKey('raw', raw.buffer as ArrayBuffer, 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
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
    if (!subtleOk()) return; // fail-safe：无法加密就不落盘（快捷登录退化为手输登录）
    const { preferences } = getPlugins();
    const key = await getAesKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      new TextEncoder().encode(token)
    );
    await preferences.set({
      key: TOKEN_KEY,
      value: `${bufToB64(iv.buffer as ArrayBuffer)}:${bufToB64(ct)}`,
    });
  },
  async getToken() {
    if (!subtleOk()) return null;
    const { preferences } = getPlugins();
    const envelope = (await preferences.get({ key: TOKEN_KEY })).value;
    if (!envelope) return null;
    const sep = envelope.indexOf(':');
    if (sep <= 0) return null;
    try {
      const iv = b64ToBuf(envelope.slice(0, sep));
      const ct = b64ToBuf(envelope.slice(sep + 1));
      const key = await getAesKey();
      const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(iv) }, key, ct);
      return new TextDecoder().decode(pt);
    } catch {
      // 解密失败（密钥轮换 / 数据损坏 / 被篡改）→ 视作未登录，绝不返回半截凭据
      return null;
    }
  },
  async clearToken() {
    const { preferences } = getPlugins();
    await preferences.remove({ key: TOKEN_KEY });
    // 密钥一并清除：换账号登录时用全新密钥，避免旧密钥残留拉长攻击窗口
    await preferences.remove({ key: KEY_KEY });
  }
};

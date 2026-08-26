/**
 * 前端 AES-GCM helper（与后端 `decryptApiKey` 配对）。
 *
 * 密钥来自 build-time 注入的 `__AH_CRYPTO_KEY__`（64 hex chars / 32 bytes）。
 * 密文格式：base64(iv + ciphertext + tag)，iv 固定 12 bytes，与后端约定一致。
 */

/** 取 build-time 注入的 AES-256 key；未配置则抛错（禁止静默降级）。 */
function getBuildTimeCryptoKey(): Uint8Array {
  // @ts-ignore - vite define 注入
  const raw = typeof __AH_CRYPTO_KEY__ === 'string' ? __AH_CRYPTO_KEY__ : '';
  if (!raw || raw.length !== 64) {
    throw new Error('missing build-time crypto key: __AH_CRYPTO_KEY__ must be 64 hex chars');
  }
  const out = new Uint8Array(raw.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(raw.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** 纯前端 base64 编码（避免依赖未 polyfill 的 Buffer）。 */
function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode.apply(null, Array.from(chunk));
  }
  return btoa(binary);
}

/** AES-GCM 加密：输出 base64(iv + ciphertext + authTag)。 */
export async function encryptApiKey(plaintext: string): Promise<string> {
  const key = getBuildTimeCryptoKey();
  // 参数级 `as any`：TS lib 的 Uint8Array<ArrayBufferLike> 与 BufferSource 重载不匹配，
  // 运行时完全合法（WebCrypto 接受任意 ArrayBufferView）。
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    key as any,
    { name: 'AES-GCM' },
    false,
    ['encrypt']
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    keyMaterial,
    new TextEncoder().encode(plaintext)
  );
  const ivBytes = new Uint8Array(iv);
  const ctBytes = new Uint8Array(ct as unknown as ArrayBuffer);
  const combined = new Uint8Array(ivBytes.length + ctBytes.length);
  combined.set(ivBytes, 0);
  combined.set(ctBytes, ivBytes.length);
  return toBase64(combined);
}

/**
 * 插件清单签名校验（P2.b 插件市场）。
 *
 * 插件从远程 registry 拉取后，必须验证其清单完整性与发布者身份，防止「投毒」的恶意插件
 * 以 AgentCard 入驻平台、获得路由/执行资格。支持两种方案：
 *   - 'hmac'（默认）：共享密钥 HMAC-SHA256 签名，适合自托管 registry / 内部分发；
 *   - 'ed25519'：非对称签名（发布者私钥签名、平台公钥验签），适合公开/多租户 registry。
 *
 * 设计要点：
 *   - 签名对「规范化后的清单 JSON」计算，避免字段顺序/空白导致的验签失败；
 *   - 全字段可 JSON 序列化，与 PluginManifest 约定一致；
 *   - 未配置密钥（verify=false）时允许跳过验签，但会返回显式警告，符合「一切降级可用」。
 */

import { createHmac, createHash, timingSafeEqual } from 'node:crypto';
import type { PluginManifest } from './manifest';

/** 签名方案。 */
export type SigScheme = 'hmac' | 'ed25519';

/** 规范化清单：稳定字段顺序 + 去空白，作为签名/验签的确定输入。 */
export function canonicalizeManifest(m: PluginManifest): string {
  // 仅对「能力声明级」字段签名，排除传输/运行期元数据（endpoint 等可由部署期覆盖）。
  const seed: Record<string, unknown> = {
    id: m.id,
    version: m.version,
    name: m.name ?? null,
    description: m.description ?? null,
    capabilities: m.capabilities ?? [],
    dependencies: m.dependencies ?? [],
    permissions: m.permissions ?? [],
    transport: m.transport ?? null,
    entry: m.entry ?? null,
  };
  return JSON.stringify(seed, Object.keys(seed).sort());
}

/** 用共享密钥对清单做 HMAC-SHA256，返回 hex 签名。 */
export function signManifest(m: PluginManifest, secret: string): string {
  const hmac = createHmac('sha256', secret);
  hmac.update(canonicalizeManifest(m));
  return hmac.digest('hex');
}

/**
 * 验证清单签名。
 * @param m 待验证清单
 * @param signature 期望的 hex 签名
 * @param secretOrPub 共享密钥（hmac）或 PEM 公钥（ed25519）
 * @param scheme 签名方案，默认 hmac
 */
export function verifyManifest(
  m: PluginManifest,
  signature: string,
  secretOrPub: string,
  scheme: SigScheme = 'hmac'
): boolean {
  if (scheme === 'hmac') {
    const expected = signManifest(m, secretOrPub);
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(signature || '', 'hex');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }
  // ed25519：使用 node 内置 crypto 验签（密钥为 PEM/DER 形式）。
  try {
    // 延迟引入，避免在不支持 ed25519 的旧 Node 上加载期报错。
    const { createPublicKey, verify: verifySig } = require('node:crypto') as typeof import('node:crypto');
    const pub = createPublicKey(secretOrPub);
    const payload = Buffer.from(canonicalizeManifest(m), 'utf8');
    const sig = Buffer.from(signature || '', 'hex');
    return verifySig(null, payload, pub, sig);
  } catch {
    return false;
  }
}

/** 计算 checksum（sha256 hex），用于审计/去重，不参与验签。 */
export function manifestChecksum(m: PluginManifest): string {
  return createHash('sha256').update(canonicalizeManifest(m)).digest('hex');
}
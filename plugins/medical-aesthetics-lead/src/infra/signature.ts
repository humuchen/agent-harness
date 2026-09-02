/**
 * 渠道 webhook 验签（真实入口的安全边界）。
 *
 * 渠道方（抖音/小红书/微信/美团 的对接网关）以 HMAC-SHA256 对「时间戳 + 原始报文」签名，
 * 插件侧用共享密钥 MA_WEBHOOK_SECRET 复算并做**恒定时间比较**，防重放（时间窗）+ 防篡改。
 * 未配置密钥时一律拒绝——不允许无鉴权的裸奔入口。
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { MaError, notConfigured } from './errors';

/** 允许的时间偏移（秒）：超出即视为重放。 */
const DEFAULT_TOLERANCE_SEC = 300;

/** 计算签名：hex(HMAC_SHA256(secret, `${timestamp}.${rawBody}`))。 */
export function computeSignature(secret: string, timestamp: string, rawBody: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

/** 恒定时间比较（长度不等直接 false，避免 timingSafeEqual 抛错）。 */
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf-8');
  const bb = Buffer.from(b, 'utf-8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * 校验 webhook 签名。校验失败抛 MaError（UNAUTHORIZED / NOT_CONFIGURED）。
 * @param secret     共享密钥（来自 MA_WEBHOOK_SECRET）
 * @param headers    请求头（取 x-ma-timestamp / x-ma-signature）
 * @param rawBody    未经解析的原始请求体
 */
export function verifyWebhook(
  secret: string,
  headers: Record<string, string | string[] | undefined>,
  rawBody: string,
  toleranceSec = DEFAULT_TOLERANCE_SEC
): void {
  if (!secret) throw notConfigured('渠道 webhook 密钥', 'MA_WEBHOOK_SECRET');

  const pick = (k: string): string => {
    const v = headers[k];
    return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
  };
  const ts = pick('x-ma-timestamp').trim();
  const sig = pick('x-ma-signature').trim();
  if (!ts || !sig) {
    throw new MaError('UNAUTHORIZED', '缺少 x-ma-timestamp / x-ma-signature 请求头');
  }

  const tsNum = Number.parseInt(ts, 10);
  if (!Number.isFinite(tsNum)) {
    throw new MaError('UNAUTHORIZED', 'x-ma-timestamp 非法');
  }
  const skew = Math.abs(Math.floor(Date.now() / 1000) - tsNum);
  if (skew > toleranceSec) {
    throw new MaError('UNAUTHORIZED', `请求时间戳超出容忍窗口（偏移 ${skew}s > ${toleranceSec}s），疑似重放`);
  }

  if (!safeEqual(computeSignature(secret, ts, rawBody), sig.toLowerCase())) {
    throw new MaError('UNAUTHORIZED', 'webhook 签名校验失败');
  }
}

/** 校验运营管理令牌（数据导入等写接口）。 */
export function verifyAdminToken(
  expected: string,
  headers: Record<string, string | string[] | undefined>
): void {
  if (!expected) throw notConfigured('运营管理令牌', 'MA_ADMIN_TOKEN');
  const raw = headers['authorization'];
  const got = (Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '')).replace(/^Bearer\s+/i, '').trim();
  if (!got || !safeEqual(expected, got)) {
    throw new MaError('UNAUTHORIZED', '管理令牌无效');
  }
}

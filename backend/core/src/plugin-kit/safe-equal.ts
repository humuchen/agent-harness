/**
 * 恒定时间字符串比较（令牌/签名校验用）：长度不等直接 false，等长经
 * timingSafeEqual 比较——杜绝 === 的理论时序侧信道。此前 ma（signature.ts）正确
 * 实现、cs（routes.ts）用 ===，两插件安全口径不一；收敛后统一。
 */
import { timingSafeEqual } from 'node:crypto';

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf-8');
  const bb = Buffer.from(b, 'utf-8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

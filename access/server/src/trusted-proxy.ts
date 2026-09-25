/**
 * 可信代理网段判定（P1 安全修复）。
 *
 * 背景：clientIp() 此前盲信 cf-connecting-ip / X-Forwarded-For 首段，且不校验
 * TCP 对端地址——直连部署下攻击者伪造请求头即可绕过基于 IP 的限流与审计。
 *
 * 策略：仅当 TCP 对端（socket 远端地址）落在 TRUST_PROXY_CIDRS 配置的可信网段内，
 * 才采信代理注入头（cf-connecting-ip 优先，其次 XFF 首段）；否则一律以 socket
 * 地址为准（伪造头不再影响真实 IP 判定）。
 *
 * 配置：TRUST_PROXY_CIDRS 逗号分隔 CIDR 列表；缺省仅信任本机回环
 * （127.0.0.0/8 与 ::1）——「nginx/caddy 同机反代」这一最常见自托管拓扑零配置可用；
 * 经 docker 网络接入的 cloudflared 等代理需显式加入其容器网段
 * （compose 内已提供含 172.16.0.0/12 的缺省值）。
 *
 * 零依赖实现：IPv4 走 32 位整数掩码比较；IPv6 先完整展开 :: 缩写再按
 * 十六进制前缀（含尾组位级掩码）比较；::ffff:a.b.c.d 映射地址折返为 IPv4 判定。
 */

import { isIP } from 'node:net';

let cachedCidrs: string[] | null = null;

function trustedCidrs(): string[] {
  if (cachedCidrs) return cachedCidrs;
  const raw = process.env.TRUST_PROXY_CIDRS ?? '';
  const list = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  cachedCidrs = list.length ? list : ['127.0.0.0/8', '::1/128'];
  return cachedCidrs;
}

/** env 变更后清缓存（测试用）。 */
export function resetTrustedProxyCache(): void {
  cachedCidrs = null;
}

/** IPv4 → 32 位无符号整数；非法返回 null。 */
function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const v = Number(p);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = n * 256 + v;
  }
  return n >>> 0;
}

/** IPv4 是否命中 CIDR（a.b.c.d/len）。 */
function matchIpv4Cidr(ip: string, cidr: string): boolean {
  const slash = cidr.indexOf('/');
  const base = slash >= 0 ? cidr.slice(0, slash) : cidr;
  const len = slash >= 0 ? Number(cidr.slice(slash + 1)) : 32;
  if (!Number.isInteger(len) || len < 0 || len > 32) return false;
  const ipInt = ipv4ToInt(ip);
  const baseInt = ipv4ToInt(base);
  if (ipInt === null || baseInt === null) return false;
  if (len === 0) return true;
  const mask = (0xffffffff << (32 - len)) >>> 0;
  return ((ipInt & mask) >>> 0) === ((baseInt & mask) >>> 0);
}

/** 完整展开 IPv6 的 :: 缩写为 8 组 4 位十六进制串（128 bit → 32 hex chars）；非法返回 null。 */
function expandIpv6(s: string): string | null {
  if (!s.includes(':')) return null;
  const dc = s.indexOf('::');
  if (s.indexOf('::', dc + 1) >= 0) return null; // 多个 :: 非法
  const head = dc >= 0 ? s.slice(0, dc) : s;
  const tail = dc >= 0 ? s.slice(dc + 2) : '';
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  // 允许尾部内嵌 IPv4 段（如 ::ffff:1.2.3.4）——折算成两组十六进制。
  let tailGroups = t;
  const lastSeg = t[t.length - 1];
  if (t.length && lastSeg && lastSeg.includes('.')) {
    const v4 = ipv4ToInt(lastSeg);
    if (v4 === null) return null;
    tailGroups = [
      ...t.slice(0, -1),
      ((v4 >>> 16) & 0xffff).toString(16),
      (v4 & 0xffff).toString(16),
    ];
  }
  const fill = 8 - h.length - tailGroups.length;
  if (fill < 0 || (dc < 0 && fill !== 0)) return null;
  const groups = [...h, ...Array(dc >= 0 ? fill : 0).fill('0'), ...tailGroups];
  if (groups.length !== 8) return null;
  return groups.map((g) => (g || '0').padStart(4, '0')).join('');
}

/** IPv6（已展开）是否命中 CIDR 前缀。 */
function matchIpv6Prefix(expanded: string, cidr: string): boolean {
  const slash = cidr.indexOf('/');
  const base = slash >= 0 ? cidr.slice(0, slash) : cidr;
  const len = slash >= 0 ? Number(cidr.slice(slash + 1)) : 128;
  if (!Number.isInteger(len) || len < 0 || len > 128) return false;
  const baseExp = expandIpv6(base.replace(/^\[|\]$/g, ''));
  if (!baseExp) return false;
  if (len === 0) return true;
  const fullChars = Math.floor(len / 4);
  if (expanded.slice(0, fullChars) !== baseExp.slice(0, fullChars)) return false;
  const rem = len % 4;
  if (rem === 0) return true;
  const mask = (0xf << (4 - rem)) & 0xf;
  const ca = parseInt(expanded[fullChars] ?? '0', 16);
  const cb = parseInt(baseExp[fullChars] ?? '0', 16);
  if (Number.isNaN(ca) || Number.isNaN(cb)) return false;
  return (ca & mask) === (cb & mask);
}

/**
 * TCP 对端地址是否落在任一可信网段。
 * 接受 Node socket remoteAddress 的原始形态（含 ::ffff: 映射、%scope 后缀、方括号）。
 */
export function isTrustedProxy(remoteAddr: string): boolean {
  if (!remoteAddr || remoteAddr === 'unknown') return false;
  const addr = (remoteAddr.split('%')[0] ?? remoteAddr).replace(/^\[|\]$/g, '');
  const kind = isIP(addr);
  if (kind === 0) return false;
  // ::ffff:a.b.c.d 映射地址折返为 IPv4 参与判定（Node 双栈 socket 常见形态）。
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(addr);
  const v4 = kind === 4 ? addr : mapped?.[1];
  const v6 = kind === 6 && !mapped ? addr : null;
  for (const cidr of trustedCidrs()) {
    const c = cidr.trim().toLowerCase();
    if (!c) continue;
    if (v4) {
      if (matchIpv4Cidr(v4, c)) return true;
      // 可信网段用 IPv4-mapped IPv6 写法时同样折返比较
      const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(c);
      if (m?.[1] && matchIpv4Cidr(v4, m[1])) return true;
    } else if (v6) {
      const expanded = expandIpv6(v6);
      if (expanded && matchIpv6Prefix(expanded, c)) return true;
    }
  }
  return false;
}

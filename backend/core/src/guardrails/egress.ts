// 出网管控与私网判定（P0.3 / DNS rebinding 防护核心）。P1#21 拆分自 guardrails.ts。

/** 域名是否匹配策略中的条目（`*` 表示全部；`*.example.com` 通配子域；普通条目精确匹配主机或任意子域）。 */
function domainMatches(host: string, entry: string): boolean {
  // P1 绕过修复：剥掉 FQDN trailing dot（`evil.com.` 与 `evil.com` 同一主机），
  // 否则 `endsWith`/全等匹配被末尾点破坏，denylist 可被 trailing dot 绕过。
  const h = host.toLowerCase().replace(/\.+$/, '');
  const e = entry.toLowerCase().trim().replace(/\.+$/, '');
  if (e === '*') return true; // 通配全部：denylist 含 '*' 即禁止一切外部出网。
  if (e.startsWith('*.')) {
    const base = e.slice(2);
    return h === base || h.endsWith(`.${base}`);
  }
  // 普通条目按注释/文档声明的语义匹配「主机自身或任意子域」：
  // 旧实现只有全等，denylist 配 evil.com 拦不住 sub.evil.com（策略静默弱化）。
  return h === e || h.endsWith(`.${e}`);
}

/** 判断 host 是否属于本地/私有网络地址（127.x.x.x、localhost、192.168.x.x、10.x.x.x、172.16-31.x.x）。 */
function isPrivateHost(host: string): boolean {
  // 强制非空后转小写，避免 TypeScript 的 strict null checks 报错
  const h = (host.split(':')[0] ?? '').toLowerCase();
  return (
    h === 'localhost' ||
    h.startsWith('127.') ||
    h.startsWith('192.168.') ||
    h.startsWith('10.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
    h.startsWith('[::1]') ||
    h === '::1'
  );
}

/**
 * 判断单个 IP 字面量是否为私有/保留地址（SSRF 面覆盖）：
 * v4：0/8、10/8、100.64/10（CGNAT）、127/8、169.254/16（链路本地/云元数据）、
 *     172.16/12、192.168/16；v6：::1、fc00::/7（ULA）、fe80::/10、IPv4-mapped。
 */
export function isPrivateIp(ip: string): boolean {
  const s = ip.trim().toLowerCase();
  if (s.includes(':')) {
    // IPv6（含 mapped ::ffff:a.b.c.d）
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
    if (mapped && mapped[1]) return isPrivateIp(mapped[1]);
    if (s === '::1' || s === '::') return true;
    if (s.startsWith('fe8') || s.startsWith('fe9') || s.startsWith('fea') || s.startsWith('feb')) return true; // fe80::/10
    if (s.startsWith('fc') || s.startsWith('fd')) return true; // fc00::/7 ULA
    return false;
  }
  const parts = s.split('.');
  if (parts.length !== 4 || parts.some((p) => p === '' || Number.isNaN(Number(p)))) return false;
  const [a, b] = [Number(parts[0]), Number(parts[1])];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // 链路本地 / AWS/GCP 元数据
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

/** 主机名 → 私网判定的 TTL 缓存（DNS 结果短暂缓存，避免每次出网都打解析器）。 */
const privateResolveCache = new Map<string, { result: boolean; at: number }>();
const PRIVATE_RESOLVE_TTL_MS = 30_000;

/**
 * 主机名是否解析到私有/保留网络（DNS rebinding 防护核心）：
 * - 字面量 IP / localhost：走 isPrivateHost / isPrivateIp 快路径（零开销）；
 * - 域名：dns.lookup({all:true}) 展开**全部**解析结果，任一命中私有段即判私网
 *   （攻击者常同时配 A/AAAA 记录，只查第一条会被绕过）；
 * - 解析失败视为「非私网」交给后续真实连接去失败（此处不做网络可达性判断）。
 * 注意：这仍是「请求时」校验，与实际建连之间存在秒级 TTL 窗口；彻底闭合需
 * 连接层拦截（undici dispatcher / 自定义 lookup），待依赖引入后接入。
 */
export async function resolveHostIsPrivate(host: string): Promise<boolean> {
  const h = (host.split(':')[0] ?? '').trim().toLowerCase();
  if (!h) return false;
  // 字面量快路径
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':')) return isPrivateIp(h.replace(/^\[|\]$/g, ''));
  const cached = privateResolveCache.get(h);
  if (cached && Date.now() - cached.at < PRIVATE_RESOLVE_TTL_MS) return cached.result;
  // P1 资源修复：过期条目此前永不删除（TTL 只用于命中判断），面向公网抓取的
  // 部署随域名多样性线性泄漏。命中失败的过期条目顺手清除 + 容量超限整体重置。
  if (cached) privateResolveCache.delete(h);
  if (privateResolveCache.size >= 5_000) privateResolveCache.clear();
  let result: boolean;
  try {
    const dns = await import('node:dns/promises');
    const addrs = await Promise.race([
      dns.lookup(h, { all: true, verbatim: true }),
      new Promise<never>((_res, rej) => {
        const t = setTimeout(() => rej(new Error('dns lookup timeout')), 3000);
        t.unref?.();
      }),
    ]);
    result = (addrs as Array<{ address: string }>).some((a) => isPrivateIp(a.address));
  } catch {
    result = false; // 解析失败不判私网，交由真实连接失败
  }
  privateResolveCache.set(h, { result, at: Date.now() });
  return result;
}

/**
 * 出网管控（P0.3）：依据策略判定某 URL 是否允许访问。
 * - open / 无 network：放行；
 * - allowlist：仅允许 listed 域名（含子域），其余拒绝；
 * - denylist：禁止 listed 域名（含子域），其余放行；
 * - 本地/私有地址（127.0.0.0/8、10.0.0.0/8、172.16.0.0/12、192.168.0.0/16、localhost）豁免管控，始终放行。
 * 返回 null 表示放行，否则为拒绝原因。
 */
export function checkEgress(url: string, net?: import('./types').NetworkPolicy): string | null {
  if (!net || net.mode === 'open') return null;
  let host: string;
  try {
    // P1 绕过修复：必须用 hostname（不含端口）——`new URL().host` 对
    // `internal.com:8080` 返回含端口 authority，全等/后缀匹配全部失灵，
    // denylist/allowlist 可被「加一个非默认端口」绕过。
    host = new URL(url).hostname;
  } catch {
    return 'invalid URL';
  }
  // 本地/私有网络豁免：缺省放行（存量零回归）；allowPrivateNetwork=false 时纳入管控，
  // 防止 allowlist 域名 DNS rebinding / 直连内网服务（SSRF 面）。
  if (isPrivateHost(host) && (net.allowPrivateNetwork ?? true)) return null;
  if (net.mode === 'denylist') {
    const denied = (net.deniedDomains ?? []).some((d) => domainMatches(host, d));
    return denied ? `egress denied to ${host} (denylist)` : null;
  }
  // allowlist
  const allowed = (net.allowedDomains ?? []).some((d) => domainMatches(host, d));
  return allowed ? null : `egress not allowed to ${host} (not in allowlist)`;
}

/**
 * 出网管控异步变体（DNS rebinding 防护）：在同步字面量校验之上，把域名经
 * dns.lookup 展开为全部解析结果，任一命中私网段即按私网策略处理。
 * 仅当 `allowPrivateNetwork === false` 时执行 DNS 解析（缺省 true 完全零开销零回归）。
 * 返回 null 表示放行，否则为拒绝原因。
 */
export async function checkEgressAsync(url: string, net?: import('./types').NetworkPolicy): Promise<string | null> {
  // 快路径：open 模式 / invalid URL 短路
  if (!net || net.mode === 'open') return null;
  // 私网豁免（缺省 true）→ 字面量校验即终点，零额外开销零回归
  const privateExempt = net.allowPrivateNetwork ?? true;
  let host: string;
  try {
    // 与 checkEgress 同口径：hostname（不含端口），防止端口后缀绕过。
    host = new URL(url).hostname;
  } catch {
    return 'invalid URL';
  }
  if (privateExempt) return checkEgress(url, net);
  // —— strict 模式（allowPrivateNetwork=false）：私网纳入管控 ——
  if (isPrivateHost(host)) return `egress denied to ${host} (private network)`;
  if (await resolveHostIsPrivate(host)) {
    return `egress denied to ${host} (resolves to private network address)`;
  }
  // 解析级校验通过 → 继续按域名规则（allowlist/denylist）判定
  return checkEgress(url, net);
}

import { objectParams, ToolRegistry } from '../tools';
import { resolveHostIsPrivate, type NetworkPolicy } from '../guardrails';

export interface WebFetchOptions {
  maxBytes?: number;
  timeoutMs?: number;
  /**
   * P1 C1：响应体服务端硬上限（原始字节，与 LLM 可控的截断参数无关）。
   * 超过即中止读取并返回错误/截断标记，防止超大响应把进程内存打爆。
   */
  hardBodyBytes?: number;
  /**
   * P0-C：出网域名白名单（精确 host 或 `*.example.com` 通配后缀）。
   * 缺省（空数组）= 全放行，保持向后兼容；非空时 host 不匹配直接返回 error。
   * 来源：options.allowedDomains ?? process.env.WEB_FETCH_ALLOWED_DOMAINS（逗号分隔）。
   */
  allowedDomains?: string[];
  /**
   * 反 403（改进1）：默认请求使用的 User-Agent。
   * 缺省读 env WEB_FETCH_USER_AGENT，再缺省用真实 Chrome UA——
   * 旧版固定 `agent-harness/0.1` 是各大 WAF 的第一层爬虫特征，403 高发主因。
   * LLM 仍可通过 args.headers['user-agent'] 覆盖单次请求。
   */
  userAgent?: string;
  /**
   * 反 403（改进3）：二级回退抓取代理 URL 模板，模板中 `{url}` 会被替换为
   * encodeURIComponent(目标URL)。主请求被 403 拦截时走该代理再试一次。
   * 缺省读 env WEB_FETCH_FALLBACK_PROXY；未配置 = 不回退（行为不变）。
   * 例：https://r.jina.ai/{url} 或自建 reader 代理 https://reader.internal/fetch?target={url}
   */
  fallbackProxy?: string;
  /**
   * 反 404/5xx（改进2）：429/5xx/瞬时网络错误的最大重试次数（不含首次）。
   * 缺省 2；退避 = min(400ms * 2^n + 抖动, 2s)，429 优先尊重 Retry-After（上限 2s）。
   */
  maxRetries?: number;
  /**
   * 效率改进：2xx 响应的进程级缓存 TTL（毫秒）。同 URL 重复抓取（LLM 高频行为）
   * 直接命中缓存返回，不重发网络请求；并发同 URL 请求会合并为一次在途请求。
   * 缺省 5 分钟；0 = 禁用缓存。env WEB_FETCH_CACHE_TTL_MS 可全局调整。
   * LLM 可传 args.refresh=true 单次绕过缓存强制重抓。
   */
  cacheTtlMs?: number;
}

// ---------------------------------------------------------------------------
// 改进6：状态码分类观测
// ---------------------------------------------------------------------------

/** web_fetch 调用结果分类计数（进程级累计）。 */
export interface WebFetchStats {
  /** 总调用次数（进入网络阶段或被本地策略拒绝均计入）。 */
  total: number;
  /** 2xx 成功。 */
  ok2xx: number;
  /** 3xx（fetch 自动跟随重定向后一般看不到，出现即记录）。 */
  redirect3xx: number;
  /** 403（WAF/反爬拦截——重点观测项）。 */
  blocked403: number;
  /** 404（多为 LLM 构造/失效 URL）。 */
  notFound404: number;
  /** 其他 4xx。 */
  client4xx: number;
  /** 429（触发重试）。 */
  rateLimited429: number;
  /** 5xx（触发重试）。 */
  server5xx: number;
  /** 响应体超硬上限被拒。 */
  tooLarge: number;
  /** 请求超时（AbortError）。 */
  timeout: number;
  /** 网络层错误（DNS/连接失败等）。 */
  networkError: number;
  /** 域名白名单拒绝。 */
  allowlistDenied: number;
  /** 私网/SSRF 校验拒绝。 */
  privateDenied: number;
  /** 403 后经回退代理成功抓取的次数。 */
  fallbackUsed: number;
  /** 2xx 但正文近空（JS 渲染空壳/反爬软页）——压缩方案3 观测项。 */
  nearEmpty: number;
  /** 效率改进：命中进程缓存（TTL 内同 URL 或并发在途合并）免于重复网络请求的次数。 */
  cacheHits: number;
}

const stats: WebFetchStats = {
  total: 0, ok2xx: 0, redirect3xx: 0, blocked403: 0, notFound404: 0, client4xx: 0,
  rateLimited429: 0, server5xx: 0, tooLarge: 0, timeout: 0, networkError: 0,
  allowlistDenied: 0, privateDenied: 0, fallbackUsed: 0, nearEmpty: 0, cacheHits: 0,
};

/** 读取 web_fetch 状态码分类统计快照（只读副本）。 */
export function getWebFetchStats(): WebFetchStats {
  return { ...stats };
}

/** 清零统计（测试/运维用）。 */
export function resetWebFetchStats(): void {
  for (const k of Object.keys(stats) as (keyof WebFetchStats)[]) stats[k] = 0;
}

// ---------------------------------------------------------------------------
// 效率改进：进程级响应缓存 + 在途请求合并
// ---------------------------------------------------------------------------

/**
 * 网络层的原始抓取结果（解码后的完整文本）——缓存的存储单元。
 * 与「格式化输出」（max_bytes 截断、markdown 提取、near_empty 判定）解耦：
 * 同一 URL 以不同 max_bytes 重复调用时可直接复用原始文本重新格式化。
 */
interface RawFetchResult {
  status: number;
  ok: boolean;
  contentType: string;
  /** 已按正确字符集解码（HTML 已完成正文提取）的文本。 */
  text: string;
  /** 是否因服务端硬字节上限中止了读取。 */
  truncatedByLimit: boolean;
  /** near_empty 判定（网络层判定一次，缓存命中时不重复计数）。 */
  nearEmpty: boolean;
  /** 抓取路径标记（fallback-proxy 等）。 */
  via?: string;
  /** 响应带 Cache-Control: no-store：不入缓存（尊重站点语义，如动态/鉴权内容）。 */
  noStore?: boolean;
}

interface CacheEntry {
  raw: RawFetchResult;
  at: number;
}

const respCache = new Map<string, CacheEntry>();
/** 同 URL 并发在途请求：第二个调用者 await 同一 Promise，避免并发重复抓取。 */
const inflight = new Map<string, Promise<RawFetchResult | string>>();
const CACHE_MAX_ENTRIES = 64;
const DEFAULT_CACHE_TTL_MS = 5 * 60_000;

function parseCacheTtlMs(): number {
  const env = Number(process.env.WEB_FETCH_CACHE_TTL_MS);
  if (Number.isFinite(env) && env >= 0) return env;
  return DEFAULT_CACHE_TTL_MS;
}

/** 缓存取用（LRU：命中刷新插入序；过期即删）。 */
function cacheGet(key: string, ttlMs: number): RawFetchResult | null {
  const hit = respCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at >= ttlMs) {
    respCache.delete(key);
    return null;
  }
  respCache.delete(key);
  respCache.set(key, hit);
  return hit.raw;
}

function cachePut(key: string, raw: RawFetchResult): void {
  if (respCache.size >= CACHE_MAX_ENTRIES) {
    const oldest = respCache.keys().next().value;
    if (oldest !== undefined) respCache.delete(oldest);
  }
  respCache.set(key, { raw, at: Date.now() });
}

/** 清空响应缓存与在途合并表（测试/运维用）。 */
export function clearWebFetchCache(): void {
  respCache.clear();
  inflight.clear();
}

// ---------------------------------------------------------------------------
// Token 成本优化（压缩方案3）：近空结果检测
// ---------------------------------------------------------------------------

/** HTML 提取后有效正文低于该字符数即视为「近空」（空壳页/反爬软页）。 */
const NEAR_EMPTY_MIN_CHARS = 200;

/** 近空结果的引导文案：明确告知不要重试同一 URL，避免浪费轮次与 token。 */
const NEAR_EMPTY_HINT =
  'page has almost no readable text (likely JS-rendered or bot-protected). ' +
  'Do NOT retry the same URL; switch to another source immediately.';

// ---------------------------------------------------------------------------
// 改进4：进程级 cookie jar（按 host 记忆 set-cookie，提升会话型站点成功率）
// ---------------------------------------------------------------------------

interface JarEntry { value: string; expires: number }
const cookieJar = new Map<string, Map<string, JarEntry>>();
const COOKIE_JAR_MAX_HOSTS = 200;
/** P1 资源修复：单 host 的 cookie 条目数上限——容量控制此前只在 host 维度，恶意站点
 * 可在单页响应里塞数百个 Set-Cookie，随抓取累积（每 host 独立 Map 无淘汰）。 */
const COOKIE_JAR_MAX_PER_HOST = 50;
const SESSION_COOKIE_TTL_MS = 30 * 60 * 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 从响应收集 set-cookie，按 host 存入 jar（mock 响应无 getSetCookie 时回落 headers.get）。 */
function storeCookies(host: string, resp: Response): void {
  let raws: string[] = [];
  try {
    const gsc = (resp.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie;
    if (typeof gsc === 'function') raws = gsc.call(resp.headers) ?? [];
    else {
      const one = resp.headers.get('set-cookie');
      if (one) raws = [one];
    }
  } catch { /* 非常规 headers 实现，忽略 */ }
  if (raws.length === 0) return;
  let jar = cookieJar.get(host);
  if (!jar) {
    // 简单容量控制：超限时丢弃最早的 host（插入序）。
    if (cookieJar.size >= COOKIE_JAR_MAX_HOSTS) {
      const oldest = cookieJar.keys().next().value;
      if (oldest !== undefined) cookieJar.delete(oldest);
    }
    jar = new Map();
    cookieJar.set(host, jar);
  }
  for (const raw of raws) {
    const pair = raw.split(';')[0] ?? '';
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!name) continue;
    // 解析 Expires/Max-Age，无则按会话 TTL 保存。
    let expires = Date.now() + SESSION_COOKIE_TTL_MS;
    const maxAge = /max-age\s*=\s*(\d+)/i.exec(raw);
    const expAttr = /expires\s*=\s*([^;]+)/i.exec(raw);
    if (maxAge && maxAge[1] !== undefined) expires = Date.now() + Number(maxAge[1]) * 1000;
    else if (expAttr && expAttr[1] !== undefined) {
      const t = Date.parse(expAttr[1].trim());
      if (Number.isFinite(t)) expires = t;
    }
    jar.set(name, { value, expires });
    if (value === '' || expires <= Date.now()) {
      jar.delete(name); // 删除语义
    } else if (jar.size > COOKIE_JAR_MAX_PER_HOST) {
      // 超限淘汰最旧条目（插入序）。
      const oldest = jar.keys().next().value;
      if (oldest !== undefined) jar.delete(oldest);
    }
  }
}

/** 取该 host 当前应携带的 Cookie 头（无则返回 undefined）。 */
function cookieHeaderFor(host: string): string | undefined {
  const jar = cookieJar.get(host);
  if (!jar || jar.size === 0) return undefined;
  const now = Date.now();
  const parts: string[] = [];
  for (const [name, entry] of jar) {
    if (entry.expires <= now) { jar.delete(name); continue; }
    parts.push(`${name}=${entry.value}`);
  }
  return parts.length ? parts.join('; ') : undefined;
}

// ---------------------------------------------------------------------------
// 改进5：Readability-lite 正文提取（替代裸 stripHtml）
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", copy: '©',
  reg: '®', trade: '™', mdash: '—', ndash: '–', hellip: '…', middot: '·',
  laquo: '«', raquo: '»', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
};

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      const code = parseInt(h, 16);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ' ';
    })
    .replace(/&#(\d+);/g, (_, d) => {
      const code = parseInt(d, 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ' ';
    })
    .replace(/&([a-z]+);/gi, (_, name) => NAMED_ENTITIES[name.toLowerCase()] ?? ' ');
}

/** 从 <meta name/property="description|og:description"> 提取页面摘要（属性顺序两种写法都兼容）。 */
function extractMetaDescription(html: string): string | null {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const key = /(?:\bname|\bproperty)\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
    const k = (key?.[1] ?? key?.[2] ?? '').toLowerCase();
    if (k !== 'description' && k !== 'og:description') continue;
    const content = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
    const val = decodeEntities(content?.[1] ?? content?.[2] ?? '').replace(/\s+/g, ' ').trim();
    if (val) return val;
  }
  return null;
}

/**
 * 极简正文提取（输出轻量 Markdown 结构）：
 * 1) 记录 title 与 meta description；剔除 script/style/noscript/svg/template/iframe 与注释；
 * 2) 剔除 nav/header/footer/aside/form 区块与表单噪音；
 * 3) <pre> 代码块原样保留（占位符方案，不参与空白压缩，保住缩进与换行）；
 * 4) 结构保真：h1-h6 → `#` 前缀、li → `- `、a → [text](href)、blockquote → `> `，
 *    让模型直接看到标题层级、列表项与可跟进的链接；
 * 5) 块级标签转换行 → 剥标签 → 还原实体 → 压缩行内空白并去空行。
 * （刻意不裁剪到 main/article 内部：SPA 空壳页保留全文反而能让「无正文」一眼可辨，
 *   且 main/article 定位对嵌套/异构页面误伤率高。）
 */
function extractText(html: string): string {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const description = extractMetaDescription(html);
  // <pre> 先摘出存占位符：内部只剥标签+还原实体，不参与后续空白压缩。
  const pres: string[] = [];
  const work = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<title[^>]*>[\s\S]*?<\/title>/gi, ' ') // 标题单独输出，避免正文重复
    .replace(/<(script|style|noscript|svg|template|iframe)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(nav|header|footer|aside|form)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(input|button|select)\b[^>]*\/?>/gi, ' ')
    .replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_m, inner: string) => {
      const code = decodeEntities(String(inner).replace(/<[^>]+>/g, ''));
      return `\n\u0000PRE${pres.push(code) - 1}\u0000\n`;
    })
    // 链接 → [text](href)：内部先剥标签取文本；锚点/脚本/无文本链接直接降级。
    .replace(/<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a\s*>/gi,
      (_m, dq: string | undefined, sq: string | undefined, inner: string) => {
        const href = (dq ?? sq ?? '').trim();
        const text = decodeEntities(String(inner).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
        if (!text) return '';
        if (!href || href.startsWith('#') || /^(javascript|mailto|tel|data):/i.test(href)) return text;
        return `[${text}](${href})`;
      })
    // 标题层级 / 列表 / 引用 → Markdown 前缀（收尾换行由块级标签正则统一处理）。
    .replace(/<h([1-6])\b[^>]*>/gi, (_m, lvl: string) => `\n${'#'.repeat(Number(lvl))} `)
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/li>/gi, '')
    .replace(/<blockquote\b[^>]*>/gi, '\n> ');

  let text = work
    // 块级边界 → 换行，保住段落/标题/表格结构（li 已单独处理）
    .replace(/<\/(p|div|section|article|tr|h[1-6]|blockquote|pre|table|ul|ol|dl|figcaption)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');

  text = decodeEntities(text)
    .split('\n')
    .map((line) => line.replace(/[\t ]+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n')
    .replace(/\u0000PRE(\d+)\u0000/g, (_m, i: string) => {
      const code = pres[Number(i)];
      return code !== undefined ? `\n${code}\n` : '';
    });

  // 头部元信息：标题 + 描述（无 title 的页面 meta description 也能独撑摘要）。
  const head: string[] = [];
  const t = decodeEntities(title ?? '').replace(/\s+/g, ' ').trim();
  if (t) head.push(`标题: ${t}`);
  if (description) head.push(`描述: ${description}`);
  return (head.length ? `${head.join('\n')}\n\n` : '') + text;
}

export function registerWebFetch(registry: ToolRegistry, opts: WebFetchOptions = {}): void {
  // Token 成本优化（压缩方案1）：默认抓取上限从 200_000 降到 4_000 字符。
  // 动机：一次 16KB 级抓取会驻留历史、被后续每一步重复计费（实测全程可放大 6-10k tok）。
  // 4k 字符 ≈ 1-2k token，通常已覆盖标题/摘要/关键段落；确需长文时 LLM 可对单次请求
  // 显式传 max_bytes 提升上限，运维可经 env WEB_FETCH_DEFAULT_MAX_CHARS 全局调整。
  const envMax = Number(process.env.WEB_FETCH_DEFAULT_MAX_CHARS);
  const maxBytes =
    opts.maxBytes ?? (Number.isFinite(envMax) && envMax > 0 ? Math.floor(envMax) : 4_000);
  const timeoutMs = opts.timeoutMs ?? 15_000;
  // P1 C1：响应体服务端硬上限（原始字节）。此前 resp.text() 无上限整包入内存，
  // 截断上限 max_bytes 又来自 LLM 参数且无校验——恶意/超大响应可直接 OOM 进程。
  const hardBodyBytes = Math.max(opts.hardBodyBytes ?? 2_000_000, 1024);
  // P0-C：出网域名白名单（精确 host 或 *.example.com 通配后缀）。空 = 全放行（向后兼容）。
  const allowedDomains = (opts.allowedDomains ?? parseAllowedDomainsEnv()).map(normalizeDomain).filter(Boolean);
  // 改进1：默认 UA / 浏览器化请求头（LLM 可经 args.headers 覆盖单次请求）。
  const envUa = (process.env.WEB_FETCH_USER_AGENT ?? '').trim();
  const defaultUserAgent =
    opts.userAgent ?? (envUa || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36');
  // 改进3：403 二级回退代理模板（未配置 = 不回退）。
  const fallbackProxy = (opts.fallbackProxy ?? process.env.WEB_FETCH_FALLBACK_PROXY ?? '').trim();
  // 改进2：429/5xx/瞬时网络错误重试次数。
  const maxRetries = Math.max(0, Math.min(opts.maxRetries ?? 2, 5));
  // 效率改进：响应缓存 TTL（0 = 禁用）。
  const cacheTtlMs = opts.cacheTtlMs ?? parseCacheTtlMs();
  registry.register(
    'builtin__web_fetch',
    'Fetch a URL and return its text content (HTML is extracted to readable Markdown-like plain text ' +
      'with headings, lists and links preserved). ' +
      'Use for retrieving up-to-date information from the web. Only http/https are allowed. ' +
      'IMPORTANT: always use URLs exactly as they appear in search results or user input — ' +
      'never construct, guess, or modify URLs yourself (fabricated URLs cause 404). ' +
      'If a fetch returns 403/404, do not invent variants of the URL; report it and try another source instead. ' +
      'Keep responses small: the default cap is 4000 characters, which is enough for most pages — ' +
      'raise max_bytes only for a page you already know needs more. ' +
      'Identical GET requests within a few minutes are served from cache; pass refresh=true to force a fresh fetch. ' +
      'If a result is marked near_empty, the page has almost no readable text (JS-rendered or bot-protected): ' +
      'do NOT retry the same URL, switch to another source immediately.',
    objectParams(
      {
        url: { type: 'string', description: 'Full http(s) URL to fetch.' },
        method: { type: 'string', description: 'HTTP method (default GET).' },
        headers: { type: 'object', description: 'Optional request headers as a flat object (overrides defaults).' },
        max_bytes: {
          type: 'number',
          description: 'Max characters to return (default 4000; raise only when the page is known to need more).'
        },
        refresh: {
          type: 'boolean',
          description: 'Skip the response cache and fetch fresh (default false).'
        },
      },
      ['url']
    ),
    async (args: Record<string, unknown>, ctx?: Record<string, unknown>) => {
      const url = String(args.url ?? '');
      let u: URL;
      try {
        u = new URL(url);
      } catch {
        return 'error: invalid URL';
      }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        return 'error: only http/https URLs are allowed';
      }
      // P0-C：域名白名单校验（非空白名单时 host 必须命中）。
      if (allowedDomains.length > 0 && !hostAllowed(u.hostname, allowedDomains)) {
        stats.total++; stats.allowlistDenied++;
        return `error: host not in allowlist: ${u.hostname} (allowed: ${allowedDomains.join(', ')})`;
      }
      // P0 安全修复（secure by default）：私网/链路本地地址默认拒绝——不再依赖可选策略。
      // - 有策略（ctx.networkPolicy）：以策略 allowPrivateNetwork 为准（未指定时按 false 收紧）；
      // - 无策略（缺省直连 registry 的宿主）：回落本工具级开关 WEB_FETCH_ALLOW_PRIVATE_NETWORK
      //   （true/1/on 放行），否则一律拒绝。DNS rebinding 防护（解析级 + 连接时双查）保持不变。
      const net = ctx?.networkPolicy as NetworkPolicy | undefined;
      const privRaw = (process.env.WEB_FETCH_ALLOW_PRIVATE_NETWORK ?? '').trim().toLowerCase();
      const allowPrivate = net
        ? (net.allowPrivateNetwork ?? false)
        : privRaw === 'true' || privRaw === '1' || privRaw === 'on';
      if (!allowPrivate) {
        if (await resolveHostIsPrivate(u.hostname)) {
          stats.total++; stats.privateDenied++;
          return `error: egress denied: ${u.hostname} resolves to a private network address (set GUARDRAIL_ALLOW_PRIVATE_NETWORK=true or WEB_FETCH_ALLOW_PRIVATE_NETWORK=on to allow)`;
        }
      }
      stats.total++;
      // 压缩方案1配套：args.max_bytes 此前从未被读取（schema 声称支持但实际无效）。
      // 现按设计意图生效：单次请求可显式提升上限，formatResult 仍用 hardBodyBytes 夹紧防注入。
      const reqMaxRaw = Number(args.max_bytes);
      const reqMaxBytes =
        Number.isFinite(reqMaxRaw) && reqMaxRaw > 0 ? Math.floor(reqMaxRaw) : maxBytes;
      const run: FetchRunOptions = {
        method: (args.method ? String(args.method) : 'GET').toUpperCase(),
        extraHeaders: args.headers && typeof args.headers === 'object' ? (args.headers as Record<string, unknown>) : {},
        defaultUserAgent,
        timeoutMs,
        hardBodyBytes,
        maxBytes: reqMaxBytes,
        maxRetries,
        fallbackProxy,
        allowedHost: u.hostname,
      };
      // P1 SSRF 修复：传入逐跳校验上下文（重定向手动跟随，每跳复检）。
      const guard: RedirectGuard = { allowedDomains, allowPrivate };
      // 效率改进：仅缓存「LLM 未注入自定义头」的 GET（自定义头常带鉴权/会话语义，复用有污染风险）。
      const cacheable = run.method === 'GET' && Object.keys(run.extraHeaders).length === 0 && cacheTtlMs > 0;
      const key = u.toString();
      if (cacheable && args.refresh !== true) {
        const cached = cacheGet(key, cacheTtlMs);
        if (cached) {
          stats.cacheHits++;
          return formatResult(cached, run);
        }
        // 在途合并：并发同 URL 请求共用一次网络抓取，完成后各自格式化。
        const pending = inflight.get(key);
        if (pending) {
          const shared = await pending;
          if (typeof shared === 'string') return shared;
          stats.cacheHits++;
          return formatResult(shared, run);
        }
        const p = performFetch(u, run, guard).finally(() => { inflight.delete(key); });
        inflight.set(key, p);
        const result = await p;
        if (typeof result === 'string') return result;
        // 仅缓存 2xx 且站点未声明 no-store 的结果（403/404 不缓存：403 后续可能
        // 走回退代理成功，404 虽可缓存但保持行为可预测）。
        if (result.status >= 200 && result.status < 300 && !result.noStore) cachePut(key, result);
        return formatResult(result, run);
      }
      const result = await performFetch(u, run, guard);
      return typeof result === 'string' ? result : formatResult(result, run);
    },
    'builtin'
  );
}

// ---------------------------------------------------------------------------
// 请求执行：重试 + 回退代理 + cookie + 限额读取 + 分类统计
// ---------------------------------------------------------------------------

interface FetchRunOptions {
  method: string;
  extraHeaders: Record<string, unknown>;
  defaultUserAgent: string;
  timeoutMs: number;
  hardBodyBytes: number;
  maxBytes: number;
  maxRetries: number;
  fallbackProxy: string;
  allowedHost: string;
}

/** 组装浏览器化请求头：默认 UA/Accept/Accept-Language + cookie jar；LLM headers 最后覆盖。 */
function buildHeaders(run: FetchRunOptions, host: string): Record<string, string> {
  const base: Record<string, string> = {
    'user-agent': run.defaultUserAgent,
    'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
  };
  const cookie = cookieHeaderFor(host);
  if (cookie) base['cookie'] = cookie;
  for (const [k, v] of Object.entries(run.extraHeaders)) {
    if (v !== undefined && v !== null) base[String(k).toLowerCase()] = String(v);
  }
  return base;
}

function backoffDelay(attempt: number, retryAfter: string | null): number {
  const ra = Number(retryAfter ?? '');
  if (Number.isFinite(ra) && ra > 0) return Math.min(ra * 1000, 2000);
  // Retry-After 也可为 HTTP-date（RFC 7231）：换算为相对毫秒再夹紧。
  if (retryAfter) {
    const t = Date.parse(retryAfter);
    if (Number.isFinite(t)) {
      const delta = t - Date.now();
      if (delta > 0) return Math.min(delta, 2000);
    }
  }
  return Math.min(400 * 2 ** (attempt - 1) + Math.random() * 200, 2000);
}

async function fetchOnce(
  url: string,
  headers: Record<string, string>,
  method: string,
  timeoutMs: number,
  redirect: 'follow' | 'manual' = 'follow'
): Promise<{ resp?: Response; error?: Error; timedOut: boolean }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { method, headers, signal: ctrl.signal, redirect });
    return { resp, timedOut: false };
  } catch (e: unknown) {
    const err = e instanceof Error ? e : new Error(String(e));
    const timedOut = err.name === 'AbortError' || /abort/i.test(err.message);
    return { error: err, timedOut };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// P1 SSRF 修复：重定向手动跟随
// ---------------------------------------------------------------------------

/**
 * 重定向手动跟随的跳数上限（防重定向环 / 资源放大）。
 */
const MAX_REDIRECT_HOPS = 5;

/**
 * 逐跳校验所需的策略上下文：主路径（guard 存在）以 `redirect: 'manual'` 请求，
 * 每个 3xx 由本模块解析 Location 并重新校验 allowlist + 私网后再跟随。
 * 旧实现 `redirect: 'follow'` 由 fetch 内部直跳——公网 URL 302 到云元数据
 * （169.254.169.254）/ 内网服务时完全绕过首跳校验，是已知可利用的 SSRF 面。
 */
interface RedirectGuard {
  allowedDomains: string[];
  allowPrivate: boolean;
}

/**
 * 网络抓取主循环：重试 + 手动重定向 + 回退代理 + cookie + 限额读取。
 * 成功返回 RawFetchResult（缓存存储单元），失败返回 `error: ...` 文案。
 */
async function performFetch(u: URL, run: FetchRunOptions, guard?: RedirectGuard): Promise<RawFetchResult | string> {
  const attempts = run.maxRetries + 1;
  let current = u;
  let hop = 0;
  let attempt = 1;

  for (;;) {
    const headers = buildHeaders(run, current.hostname);
    const { resp, error, timedOut } = await fetchOnce(
      current.toString(),
      headers,
      run.method,
      run.timeoutMs,
      guard ? 'manual' : 'follow'
    );

    if (error || !resp) {
      if (timedOut) {
        stats.timeout++;
        // 超时不重试：慢站重试大概率仍超时，避免把总时延放大 3 倍。
        return `error: request timed out after ${run.timeoutMs}ms`;
      }
      stats.networkError++;
      const err = error ?? new Error('fetch failed');
      if (attempt < attempts) {
        await sleep(backoffDelay(attempt, null));
        attempt++;
        continue;
      }
      return `error: ${err.message}`;
    }

    const status = resp.status;
    if (status >= 200 && status < 300) stats.ok2xx++;
    else if (status >= 300 && status < 400) stats.redirect3xx++;
    else if (status === 403) stats.blocked403++;
    else if (status === 404) stats.notFound404++;
    else if (status === 429) stats.rateLimited429++;
    else if (status >= 400 && status < 500) stats.client4xx++;
    else if (status >= 500) stats.server5xx++;

    // P1 SSRF 修复：手动逐跳跟随重定向，每跳重新校验协议 + allowlist + 私网。
    if (guard && status >= 300 && status < 400 && hop < MAX_REDIRECT_HOPS) {
      const loc = resp.headers.get('location');
      try { await resp.body?.cancel(); } catch { /* 忽略释放失败 */ }
      if (loc) {
        let next: URL;
        try {
          next = new URL(loc, current);
        } catch {
          return 'error: invalid redirect location';
        }
        if (next.protocol !== 'http:' && next.protocol !== 'https:') {
          return 'error: redirect to non-http/https URL denied';
        }
        if (guard.allowedDomains.length > 0 && !hostAllowed(next.hostname, guard.allowedDomains)) {
          return `error: redirect host not in allowlist: ${next.hostname}`;
        }
        if (!guard.allowPrivate && (await resolveHostIsPrivate(next.hostname))) {
          stats.privateDenied++;
          return `error: redirect target ${next.hostname} resolves to a private network address (set GUARDRAIL_ALLOW_PRIVATE_NETWORK=true or WEB_FETCH_ALLOW_PRIVATE_NETWORK=on to allow)`;
        }
        current = next;
        hop++;
        continue;
      }
      // 无 Location 的 3xx：按普通响应读取（保持旧行为）。
    }

    // 改进2：429/408/5xx 退避重试（尊重 Retry-After 秒数或 HTTP-date，上限 2s）。
    if ((status === 429 || status === 408 || status >= 500) && attempt < attempts) {
      try { await resp.body?.cancel(); } catch { /* 忽略释放失败 */ }
      await sleep(backoffDelay(attempt, resp.headers.get('retry-after')));
      attempt++;
      continue;
    }

    // 改进3：403 被反爬拦截 → 配置了回退代理时走代理再抓一次（仅首次 403 后触发一次）。
    if (status === 403 && run.fallbackProxy) {
      const proxied = await tryFallbackProxy(current.toString(), run);
      if (proxied !== null) return proxied;
      // 代理失败 → 落回正常 403 返回路径。
    }

    return readRawResult(resp, { ...run, allowedHost: current.hostname });
  }
}

/** 改进3：经回退代理抓取；成功返回结果，失败返回 null（回落主路径 403 处理）。 */
async function tryFallbackProxy(originalUrl: string, run: FetchRunOptions): Promise<RawFetchResult | string | null> {
  const proxiedUrl = run.fallbackProxy.replace('{url}', encodeURIComponent(originalUrl));
  const { resp, error } = await fetchOnce(proxiedUrl, buildHeaders(run, safeHost(proxiedUrl)), 'GET', run.timeoutMs);
  if (error || !resp || !(resp.status >= 200 && resp.status < 300)) {
    try { await resp?.body?.cancel(); } catch { /* 忽略 */ }
    return null;
  }
  stats.fallbackUsed++;
  return readRawResult(resp, { ...run, allowedHost: safeHost(proxiedUrl) }, 'fallback-proxy');
}

function safeHost(url: string): string {
  try { return new URL(url).hostname; } catch { return ''; }
}

/**
 * 读取响应体并产出原始抓取结果（网络层终点，也是缓存的存储单元）；
 * 超硬上限返回 `error: ...` 文案。
 */
async function readRawResult(
  resp: Response,
  run: FetchRunOptions,
  via?: string
): Promise<RawFetchResult | string> {
  const ct = resp.headers.get('content-type') ?? '';
  // P1 C1：先按 Content-Length 提前拒绝超限响应。
  const declared = Number(resp.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > run.hardBodyBytes) {
    try { await resp.body?.cancel(); } catch { /* 忽略释放失败 */ }
    stats.tooLarge++;
    return `error: response body too large (${declared} bytes > ${run.hardBodyBytes} hard limit)`;
  }
  // P1 C1：流式分块读取 + 字节预算，超限即中止连接，不再 resp.text() 整包入内存。
  const body = await readBodyCapped(resp, run.hardBodyBytes);
  // 质量改进：字节流按嗅探到的字符集解码（GBK/Big5/Shift_JIS/latin1 等），
  // 避免「meta 声明 gbk 的页面被当 UTF-8 解出乱码」这一中文抓取的高频质量事故。
  // mock/无流运行时（body 为 null）拿到的是 text() 已解码字符串，直接使用。
  const decoded = body.bytes ? decodeWithCharset(body.bytes, ct) : body.text;
  const isHtml = ct.includes('html');
  const text = isHtml ? extractText(decoded) : decoded;
  storeCookies(run.allowedHost, resp);
  // 压缩方案3：近空结果检测（仅 HTML——纯文本/JSON 端点本来就短，短 ≠ 无效）。
  // 2xx 但正文近空大概率是 JS 渲染空壳或反爬软页；显式标记 near_empty + 引导提示，
  // 避免模型对着空壳 URL 反复重试浪费轮次（实测此类无效抓取单次全程浪费 1-2k tok）。
  // 在网络层判定一次并随结果缓存，命中缓存重新格式化时不重复计数。
  const nearEmpty = isHtml && text.trim().length < NEAR_EMPTY_MIN_CHARS;
  if (nearEmpty) stats.nearEmpty++;
  return {
    status: resp.status,
    ok: resp.ok,
    contentType: ct,
    text,
    truncatedByLimit: body.truncatedByLimit,
    nearEmpty,
    ...(via ? { via } : {}),
    ...((resp.headers.get('cache-control') ?? '').includes('no-store') ? { noStore: true } : {}),
  };
}

/** 将原始抓取结果格式化为工具结果 JSON（max_bytes 截断在此生效，可基于缓存重复调用）。 */
function formatResult(r: RawFetchResult, run: FetchRunOptions): string {
  let out = r.truncatedByLimit ? r.text + ' ...[fetch aborted: hard byte limit]' : r.text;
  // P1 C1：LLM 可控的截断上限夹紧到 [1, hardBodyBytes]，防参数注入超大值。
  const cap = Math.min(Math.max(run.maxBytes, 1), run.hardBodyBytes);
  if (out.length > cap) out = out.slice(0, cap) + `\n...[truncated at ${cap} chars]`;
  return JSON.stringify({
    status: r.status,
    ok: r.ok,
    content_type: r.contentType,
    length: out.length,
    ...(r.nearEmpty ? { near_empty: true, hint: NEAR_EMPTY_HINT } : {}),
    ...(r.via ? { via: r.via } : {}),
    body: out,
  });
}

// ---------------------------------------------------------------------------
// 质量改进：非 UTF-8 字符集识别与解码
// ---------------------------------------------------------------------------

/**
 * 嗅探响应字符集：优先 HTTP Content-Type 头，其次 HTML 头部 <meta charset> /
 * <?xml encoding?>。meta 嗅探只看前 2KB，并以 windows-1252（latin1 兼容）单字节
 * 通道解码——meta 标签本身必为 ASCII，该通道不会破坏标签结构。
 */
function sniffCharset(contentType: string, bytes: Uint8Array): string | null {
  const ct = /charset\s*=\s*"?([\w.:-]+)"?/i.exec(contentType);
  if (ct?.[1]) return ct[1];
  const head = new TextDecoder('windows-1252').decode(bytes.subarray(0, 2048));
  const meta = /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(head)
    ?? /<\?xml[^>]+encoding\s*=\s*["']([\w.:-]+)/i.exec(head);
  return meta?.[1] ?? null;
}

/**
 * 按嗅探到的字符集解码字节流；未识别或运行时不支持的 label 一律回落 UTF-8。
 * GBK/GB2312/GB18030/Big5/Shift_JIS/EUC-KR/ISO-8859-1/windows-1252 均为
 * WHATWG Encoding 内置 label，Node 开箱支持，无需额外依赖。
 */
function decodeWithCharset(bytes: Uint8Array, contentType: string): string {
  const label = sniffCharset(contentType, bytes);
  if (label && !/^(utf-?8|us-ascii|ascii)$/i.test(label)) {
    try {
      return new TextDecoder(label, { fatal: false }).decode(bytes);
    } catch {
      // 未知 label → 回落 UTF-8
    }
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

// ---------------------------------------------------------------------------
// P1 C1：响应体流式限额读取
// ---------------------------------------------------------------------------

/**
 * 流式读取响应体，累计字节超过 budget 时中止连接并返回已读字节。
 * truncatedByLimit 标记是否因预算触发了中止。
 * 返回 bytes（供调用方按正确字符集解码）；无 body 流的 Response（mock/部分运行时）
 * 回落一次性 text()，此时 bytes 为 null、text 为已解码字符串。
 */
async function readBodyCapped(
  resp: Response,
  budget: number
): Promise<{ bytes: Uint8Array | null; text: string; truncatedByLimit: boolean }> {
  const reader = resp.body?.getReader();
  if (!reader) {
    try {
      const t = await resp.text();
      return {
        bytes: null,
        text: t.length > budget ? t.slice(0, budget) : t,
        truncatedByLimit: t.length > budget,
      };
    } catch {
      return { bytes: null, text: '', truncatedByLimit: false };
    }
  }
  const chunks: Uint8Array[] = [];
  let received = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const remain = budget - received;
      if (value.byteLength > remain) {
        chunks.push(value.slice(0, Math.max(remain, 0)));
        received += Math.min(value.byteLength, Math.max(remain, 0));
        truncated = true;
        break;
      }
      chunks.push(value);
      received += value.byteLength;
    }
  } finally {
    // 提前退出（超预算截断）时取消流并释放锁，避免连接悬挂。
    if (truncated) {
      try { await reader.cancel(); } catch { /* 流已结束，忽略 */ }
    }
    try { reader.releaseLock(); } catch { /* 忽略重复释放 */ }
  }
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const merged = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    merged.set(c, off);
    off += c.byteLength;
  }
  return { bytes: merged, text: '', truncatedByLimit: truncated };
}

// ---------------------------------------------------------------------------
// P0-C：域名白名单辅助
// ---------------------------------------------------------------------------

/** 从 env 解析逗号分隔的白名单（去空白、去空项）。 */
function parseAllowedDomainsEnv(): string[] {
  const raw = process.env.WEB_FETCH_ALLOWED_DOMAINS;
  if (!raw || !raw.trim()) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** host 归一化：小写、去端口、去协议前缀。 */
function normalizeDomain(d: string): string {
  let host = String(d).trim().toLowerCase();
  if (host.startsWith('http://') || host.startsWith('https://')) {
    host = host.replace(/^https?:\//, '').split('/')[0] ?? '';
  }
  const colon = host.lastIndexOf(':');
  if (colon > 0) {
    host = host.slice(0, colon);
  }
  return host;
}

/** host 是否命中白名单（精确匹配或 *.suffix 通配后缀）。 */
function hostAllowed(host: string, allowed: string[]): boolean {
  const h = normalizeDomain(host);
  for (const entry of allowed) {
    if (entry.startsWith('*.')) {
      const suffix = entry.slice(2);
      if (h === suffix || h.endsWith('.' + suffix)) return true;
    } else if (h === entry) {
      return true;
    }
  }
  return false;
}

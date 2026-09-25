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
}

const stats: WebFetchStats = {
  total: 0, ok2xx: 0, redirect3xx: 0, blocked403: 0, notFound404: 0, client4xx: 0,
  rateLimited429: 0, server5xx: 0, tooLarge: 0, timeout: 0, networkError: 0,
  allowlistDenied: 0, privateDenied: 0, fallbackUsed: 0,
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
// 改进4：进程级 cookie jar（按 host 记忆 set-cookie，提升会话型站点成功率）
// ---------------------------------------------------------------------------

interface JarEntry { value: string; expires: number }
const cookieJar = new Map<string, Map<string, JarEntry>>();
const COOKIE_JAR_MAX_HOSTS = 200;
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
    if (value === '' || expires <= Date.now()) jar.delete(name); // 删除语义
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

/** 取第一个 <tag ...>...</tag> 区间的内部内容（找不到返回 null）。 */
function innerBlock(html: string, tag: string): string | null {
  const open = new RegExp(`<${tag}[\\s>]`, 'i').exec(html);
  if (!open || open.index === undefined) return null;
  const bodyStart = html.indexOf('>', open.index);
  if (bodyStart < 0) return null;
  const closeRe = new RegExp(`</${tag}\\s*>`, 'ig');
  closeRe.lastIndex = bodyStart;
  const close = closeRe.exec(html);
  if (!close) return null;
  return html.slice(bodyStart + 1, close.index);
}

/**
 * 极简正文提取：
 * 1) 记录 <title>；剔除 script/style/noscript/svg/template/iframe 与注释；
 * 2) 剔除 nav/header/footer/aside/form 区块与表单噪音；
 * 3) 块级标签转换行保段落结构 → 剥标签 → 还原实体 → 压缩行内空白并去空行。
 * （刻意不裁剪到 main/article 内部：SPA 空壳页保留全文反而能让「无正文」一眼可辨，
 *   且 main/article 定位对嵌套/异构页面误伤率高。）
 */
function extractText(html: string): string {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const work = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<title[^>]*>[\s\S]*?<\/title>/gi, ' ') // 标题单独输出，避免正文重复
    .replace(/<(script|style|noscript|svg|template|iframe)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(nav|header|footer|aside|form)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(input|button|select)\b[^>]*\/?>/gi, ' ');

  let text = work
    // 块级边界 → 换行，保住段落/标题/列表结构
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre|table|ul|ol|dl|figcaption)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');

  text = decodeEntities(text)
    .split('\n')
    .map((line) => line.replace(/[\t ]+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n');

  const t = decodeEntities(title ?? '').replace(/\s+/g, ' ').trim();
  return t ? `标题: ${t}\n\n${text}` : text;
}

export function registerWebFetch(registry: ToolRegistry, opts: WebFetchOptions = {}): void {
  const maxBytes = opts.maxBytes ?? 200_000;
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
  registry.register(
    'builtin__web_fetch',
    'Fetch a URL and return its text content (HTML is extracted to readable plain text). ' +
      'Use for retrieving up-to-date information from the web. Only http/https are allowed. ' +
      'IMPORTANT: always use URLs exactly as they appear in search results or user input — ' +
      'never construct, guess, or modify URLs yourself (fabricated URLs cause 404). ' +
      'If a fetch returns 403/404, do not invent variants of the URL; report it and try another source instead.',
    objectParams(
      {
        url: { type: 'string', description: 'Full http(s) URL to fetch.' },
        method: { type: 'string', description: 'HTTP method (default GET).' },
        headers: { type: 'object', description: 'Optional request headers as a flat object (overrides defaults).' },
        max_bytes: { type: 'number', description: 'Max characters to return (default 200000).' },
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
      return fetchWithRetries(u, {
        method: (args.method ? String(args.method) : 'GET').toUpperCase(),
        extraHeaders: args.headers && typeof args.headers === 'object' ? (args.headers as Record<string, unknown>) : {},
        defaultUserAgent,
        timeoutMs,
        hardBodyBytes,
        maxBytes,
        maxRetries,
        fallbackProxy,
        allowedHost: u.hostname,
      });
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
  return Math.min(400 * 2 ** (attempt - 1) + Math.random() * 200, 2000);
}

async function fetchOnce(
  url: string,
  headers: Record<string, string>,
  method: string,
  timeoutMs: number
): Promise<{ resp?: Response; error?: Error; timedOut: boolean }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { method, headers, signal: ctrl.signal });
    return { resp, timedOut: false };
  } catch (e: unknown) {
    const err = e instanceof Error ? e : new Error(String(e));
    const timedOut = err.name === 'AbortError' || /abort/i.test(err.message);
    return { error: err, timedOut };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithRetries(u: URL, run: FetchRunOptions): Promise<string> {
  const attempts = run.maxRetries + 1;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const headers = buildHeaders(run, u.hostname);
    const { resp, error, timedOut } = await fetchOnce(u.toString(), headers, run.method, run.timeoutMs);

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

    // 改进2：429/5xx 退避重试（尊重 Retry-After，上限 2s）。
    if ((status === 429 || status >= 500) && attempt < attempts) {
      try { await resp.body?.cancel(); } catch { /* 忽略释放失败 */ }
      await sleep(backoffDelay(attempt, resp.headers.get('retry-after')));
      continue;
    }

    // 改进3：403 被反爬拦截 → 配置了回退代理时走代理再抓一次（仅首次 403 后触发一次）。
    if (status === 403 && run.fallbackProxy) {
      const proxied = await tryFallbackProxy(u.toString(), run);
      if (proxied !== null) return proxied;
      // 代理失败 → 落回正常 403 返回路径。
    }

    const result = await readResult(resp, run);
    if (result !== null) return result;
    // tooLarge：readResult 已计数，按 Content-Length 给出错误信息。
    const declared = Number(resp.headers.get('content-length') ?? '');
    return `error: response body too large (${Number.isFinite(declared) && declared > 0 ? declared : 'unknown'} bytes > ${run.hardBodyBytes} hard limit)`;
  }
  // 不可达：循环内每个分支要么 return 要么 continue（最后一次迭代不 continue）。
  return 'error: unreachable';
}

/** 改进3：经回退代理抓取；成功返回格式化结果，失败返回 null（回落主路径）。 */
async function tryFallbackProxy(originalUrl: string, run: FetchRunOptions): Promise<string | null> {
  const proxiedUrl = run.fallbackProxy.replace('{url}', encodeURIComponent(originalUrl));
  const { resp, error } = await fetchOnce(proxiedUrl, buildHeaders(run, safeHost(proxiedUrl)), 'GET', run.timeoutMs);
  if (error || !resp || !(resp.status >= 200 && resp.status < 300)) {
    try { await resp?.body?.cancel(); } catch { /* 忽略 */ }
    return null;
  }
  stats.fallbackUsed++;
  const result = await readResult(resp, { ...run, allowedHost: safeHost(proxiedUrl) }, 'fallback-proxy');
  return result ?? `error: response body too large via fallback proxy (> ${run.hardBodyBytes} hard limit)`;
}

function safeHost(url: string): string {
  try { return new URL(url).hostname; } catch { return ''; }
}

/** 读取响应体并格式化为工具结果 JSON；超限时返回 null（调用方按 tooLarge 处理）。 */
async function readResult(
  resp: Response,
  run: FetchRunOptions,
  via?: string
): Promise<string | null> {
  const ct = resp.headers.get('content-type') ?? '';
  // P1 C1：先按 Content-Length 提前拒绝超限响应。
  const declared = Number(resp.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > run.hardBodyBytes) {
    try { await resp.body?.cancel(); } catch { /* 忽略释放失败 */ }
    stats.tooLarge++;
    return null;
  }
  // P1 C1：流式分块读取 + 字节预算，超限即中止连接，不再 resp.text() 整包入内存。
  const { text: raw, truncatedByLimit } = await readBodyCapped(resp, run.hardBodyBytes);
  const text = ct.includes('html') ? extractText(raw) : raw;
  storeCookies(run.allowedHost, resp);
  let out = truncatedByLimit ? text + ' ...[fetch aborted: hard byte limit]' : text;
  // P1 C1：LLM 可控的截断上限夹紧到 [1, hardBodyBytes]，防参数注入超大值。
  const cap = Math.min(Math.max(run.maxBytes, 1), run.hardBodyBytes);
  if (out.length > cap) out = out.slice(0, cap) + `\n...[truncated at ${cap} chars]`;
  return JSON.stringify({
    status: resp.status,
    ok: resp.ok,
    content_type: ct,
    length: out.length,
    ...(via ? { via } : {}),
    body: out,
  });
}

// ---------------------------------------------------------------------------
// P1 C1：响应体流式限额读取
// ---------------------------------------------------------------------------

/**
 * 流式读取响应体，累计字节超过 budget 时中止连接并返回已读部分。
 * 返回 truncatedByLimit 标记是否因预算触发了中止。
 * 兼容无 body 流的 Response（mock/部分运行时）：回落一次性 text()。
 */
async function readBodyCapped(
  resp: Response,
  budget: number
): Promise<{ text: string; truncatedByLimit: boolean }> {
  const reader = resp.body?.getReader();
  if (!reader) {
    try {
      const t = await resp.text();
      return { text: t.length > budget ? t.slice(0, budget) : t, truncatedByLimit: t.length > budget };
    } catch {
      return { text: '', truncatedByLimit: false };
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
  // 非 fatal 解码：截断可能切断多字节字符，容忍替换符。
  const text = new TextDecoder('utf-8', { fatal: false }).decode(merged);
  return { text, truncatedByLimit: truncated };
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

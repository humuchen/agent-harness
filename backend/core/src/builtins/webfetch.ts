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
}

/** 极简 HTML→纯文本：去掉 script/style 与标签，还原常见实体并压缩空白。 */
function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

export function registerWebFetch(registry: ToolRegistry, opts: WebFetchOptions = {}): void {
  const maxBytes = opts.maxBytes ?? 200_000;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  // P1 C1：响应体服务端硬上限（原始字节）。此前 resp.text() 无上限整包入内存，
  // 截断上限 max_bytes 又来自 LLM 参数且无校验——恶意/超大响应可直接 OOM 进程。
  const hardBodyBytes = Math.max(opts.hardBodyBytes ?? 2_000_000, 1024);
  // P0-C：出网域名白名单（精确 host 或 *.example.com 通配后缀）。空 = 全放行（向后兼容）。
  const allowedDomains = (opts.allowedDomains ?? parseAllowedDomainsEnv()).map(normalizeDomain).filter(Boolean);
  registry.register(
    'builtin__web_fetch',
    'Fetch a URL and return its text content (HTML is lightly stripped to plain text). ' +
      'Use for retrieving up-to-date information from the web. Only http/https are allowed.',
    objectParams(
      {
        url: { type: 'string', description: 'Full http(s) URL to fetch.' },
        method: { type: 'string', description: 'HTTP method (default GET).' },
        headers: { type: 'object', description: 'Optional request headers as a flat object.' },
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
          return `error: egress denied: ${u.hostname} resolves to a private network address (set GUARDRAIL_ALLOW_PRIVATE_NETWORK=true or WEB_FETCH_ALLOW_PRIVATE_NETWORK=on to allow)`;
        }
      }
      const method = (args.method ? String(args.method) : 'GET').toUpperCase();
      const baseHeaders: Record<string, string> = { 'user-agent': 'agent-harness/0.1' };
      const extra =
        args.headers && typeof args.headers === 'object' ? (args.headers as Record<string, unknown>) : {};
      for (const [k, v] of Object.entries(extra)) baseHeaders[k] = String(v);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const resp = await fetch(u.toString(), { method, headers: baseHeaders, signal: ctrl.signal });
        const ct = resp.headers.get('content-type') ?? '';
        // P1 C1：先按 Content-Length 提前拒绝超限响应。
        const declared = Number(resp.headers.get('content-length') ?? '');
        if (Number.isFinite(declared) && declared > hardBodyBytes) {
          try { await resp.body?.cancel(); } catch { /* 忽略释放失败 */ }
          return `error: response body too large (${declared} bytes > ${hardBodyBytes} hard limit)`;
        }
        // P1 C1：流式分块读取 + 字节预算，超限即中止连接，不再 resp.text() 整包入内存。
        const { text: raw, truncatedByLimit } = await readBodyCapped(resp, ctrl, hardBodyBytes);
        let text = ct.includes('html') ? stripHtml(raw) : raw;
        if (truncatedByLimit) text += ' ...[fetch aborted: hard byte limit]';
        // P1 C1：LLM 可控的截断上限夹紧到 [1, hardBodyBytes]，防参数注入超大值。
        const rawCap = args.max_bytes ? Number(args.max_bytes) : maxBytes;
        const cap = Number.isFinite(rawCap) ? Math.min(Math.max(Math.floor(rawCap), 1), hardBodyBytes) : maxBytes;
        if (text.length > cap) text = text.slice(0, cap) + `\n...[truncated at ${cap} chars]`;
        return JSON.stringify({
          status: resp.status,
          ok: resp.ok,
          content_type: ct,
          length: text.length,
          body: text,
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return `error: ${msg}`;
      } finally {
        clearTimeout(timer);
      }
    },
    'builtin'
  );
}

// ---------------------------------------------------------------------------
// P1 C1：响应体流式限额读取
// ---------------------------------------------------------------------------

/**
 * 流式读取响应体，累计字节超过 budget 时中止连接并返回已读部分。
 * 返回 truncatedByLimit 标记是否因预算触发了中止。
 */
async function readBodyCapped(
  resp: Response,
  ctrl: AbortController,
  budget: number
): Promise<{ text: string; truncatedByLimit: boolean }> {
  const reader = resp.body?.getReader();
  if (!reader) return { text: '', truncatedByLimit: false };
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
        ctrl.abort(); // 立即断开底层连接，剩余数据不再进内存
        break;
      }
      chunks.push(value);
      received += value.byteLength;
    }
  } finally {
    // 中止/提前退出时释放锁并取消流，避免连接悬挂。
    try { await reader.cancel(); } catch { /* 已 abort 或流已结束，忽略 */ }
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

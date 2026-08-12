import { objectParams, ToolRegistry } from '../tools';

export interface WebFetchOptions {
  maxBytes?: number;
  timeoutMs?: number;
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
    async (args: Record<string, unknown>) => {
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
        let text = await resp.text();
        if (ct.includes('html')) text = stripHtml(text);
        const cap = args.max_bytes ? Number(args.max_bytes) : maxBytes;
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

/**
 * loaders.ts — 文档加载抽象（P6-B 方案二一期，对齐 LangChain DocumentLoader 的最小子集）。
 *
 * 设计要点：
 * - **stdlib-only 纪律**：内置 markdown / text / url 三种 loader 纯 JS 实现（fetch + 正则
 *   正文提取），零 npm 解析依赖；PDF / DOCX 走「外部解析旁路」（对齐 embed-server 模式，
 *   `RAG_LOADER_PDF_URL` / `RAG_LOADER_DOCX_URL` 指向外部抽取服务，POST { source } → { text }），
 *   未配置时明确报错（不静默失败）。
 * - 统一入口 `loadDocument({ type, value })`：调用方（/v1/ingest 的 source 分支）只面向
 *   一种形状；loader 失败抛错由上游明确反馈，不做降级吞错。
 * - markdown 原样透传（结构感知交给 splitter.ts 的标题递归切分）；text 做基本空白规整。
 */

/** 加载结果：文本 + 元数据（url loader 带 finalUrl/title；其余带 sourceType）。 */
export interface LoadedDoc {
  text: string;
  meta: Record<string, unknown>;
}

export type SourceType = 'markdown' | 'text' | 'url' | 'pdf' | 'docx';

export interface DocumentSource {
  type: SourceType;
  /** markdown/text = 内容本体；url/pdf/docx = 地址（url 完整 URL；pdf/docx 为外部服务的源标识）。 */
  value: string;
}

/** 外部解析旁路（PDF/DOCX）：POST { source } → { text }（对齐 embed-server 契约）。 */
async function loadViaExternalService(
  kind: 'pdf' | 'docx',
  value: string
): Promise<LoadedDoc> {
  const endpoint =
    kind === 'pdf'
      ? process.env.RAG_LOADER_PDF_URL
      : process.env.RAG_LOADER_DOCX_URL;
  if (!endpoint || !endpoint.trim()) {
    throw new Error(
      `[rag-loader] ${kind.toUpperCase()} 解析需要外部服务支持：未配置 ` +
        `${kind === 'pdf' ? 'RAG_LOADER_PDF_URL' : 'RAG_LOADER_DOCX_URL'}（stdlib-only 纪律，` +
        `内置 loader 仅支持 markdown / text / url）`
    );
  }
  const resp = await fetch(endpoint.trim(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source: value, type: kind }),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(
      `[rag-loader] 外部 ${kind.toUpperCase()} 解析服务返回 HTTP ${resp.status}${detail ? `：${detail.slice(0, 200)}` : ''}`
    );
  }
  const data = (await resp.json().catch(() => ({}))) as { text?: unknown };
  const text = typeof data.text === 'string' ? data.text : '';
  if (!text.trim()) {
    throw new Error(`[rag-loader] 外部 ${kind.toUpperCase()} 解析服务返回空文本`);
  }
  return { text, meta: { sourceType: kind, external: true } };
}

/** URL → 正文文本：剥 script/style → 抽 <title> → 去标签 → 实体解码 → 压空白。 */
export function htmlToText(html: string): { text: string; title?: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch?.[1]?.replace(/\s+/g, ' ').trim();
  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr|blockquote)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text: body, ...(title ? { title } : {}) };
}

/** 云元数据/内网/回环地址段判定（v4 常见段 + v6 回环/链路本地/ULA/IPv4-mapped）。 */
function isPrivateIpLiteral(ip: string): boolean {
  const s = ip.trim().toLowerCase();
  if (s.includes(':')) {
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
    if (mapped?.[1]) return isPrivateIpLiteral(mapped[1]);
    if (s === '::1' || s === '::') return true;
    return /^(fe[89ab]|f[cd])/.test(s); // fe80::/10 链路本地 + fc00::/7 ULA
  }
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return false;
  const octets = [m[1], m[2], m[3], m[4]].map(Number);
  if (octets.some((n) => n > 255)) return false;
  const [a, b] = octets as [number, number, number, number];
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // 链路本地 / 云元数据（169.254.169.254）
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

/**
 * P1 SSRF 防护：目标主机不得是/解析到私有·回环·链路本地地址。
 * - 字面量 IP / localhost：零网络开销快路径；
 * - 域名：dns.lookup({all:true}) 展开**全部**解析结果（攻击者常同时配 A/AAAA），
 *   任一命中私有段即拒绝；解析失败交由后续真实连接失败（不在此判可达性）。
 */
async function assertPublicHost(parsed: URL): Promise<void> {
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    isPrivateIpLiteral(hostname)
  ) {
    throw new Error(`[rag-loader] SSRF 防护：拒绝访问私有/回环地址（${hostname}）`);
  }
  try {
    const dns = await import('node:dns/promises');
    const addrs = (await Promise.race([
      dns.lookup(hostname, { all: true, verbatim: true }),
      new Promise<never>((_, rej) => {
        const t = setTimeout(() => rej(new Error('dns lookup timeout')), 3000);
        t.unref?.();
      }),
    ])) as Array<{ address: string }>;
    if (addrs.some((a) => isPrivateIpLiteral(a.address))) {
      throw new Error(`[rag-loader] SSRF 防护：${hostname} 解析到私有/回环地址，已拒绝`);
    }
  } catch (e) {
    if (e instanceof Error && e.message.includes('SSRF 防护')) throw e;
    // 解析失败不判私网，交由真实连接失败。
  }
}

/** 统一文档加载入口（内存操作 + url fetch；不触碰本地文件系统）。 */
export async function loadDocument(source: DocumentSource): Promise<LoadedDoc> {
  const value = (source.value ?? '').trim();
  if (!value) throw new Error('[rag-loader] source.value 必填');
  switch (source.type) {
    case 'markdown':
      return { text: value, meta: { sourceType: 'markdown' } };
    case 'text':
      return { text: value.replace(/\r\n/g, '\n').trim(), meta: { sourceType: 'text' } };
    case 'url': {
      let parsed: URL;
      try {
        parsed = new URL(value);
      } catch {
        throw new Error(`[rag-loader] 非法 URL：${value}`);
      }
      if (!/^https?:$/.test(parsed.protocol)) {
        throw new Error(`[rag-loader] 仅支持 http/https 协议：${value}`);
      }
      // P1 SSRF 修复 + 资源防护：
      // 1. redirect: 'manual' 手动逐跳跟随（上限 5 跳），每跳重新做私网校验——
      //    旧实现 redirect:'follow' 下公网 URL 302 到云元数据/内网完全绕过校验；
      // 2. AbortSignal.timeout 防对端挂起（旧实现无超时，请求可永不返回）；
      // 3. 响应体流式读取并按 RAG_MAX_DOC_BYTES（默认 10MB）截断，不再整包入内存。
      const maxDocBytes =
        Number(process.env.RAG_MAX_DOC_BYTES ?? 10_485_760) || 10_485_760;
      const FETCH_TIMEOUT_MS = 30_000;
      const MAX_REDIRECT_HOPS = 5;
      let current = parsed;
      // resp 在循环首次迭代即赋值（break 前必经），无需 null 初值（no-useless-assignment）。
      let resp: Response;
      for (let hop = 0; ; hop++) {
        await assertPublicHost(current);
        resp = await fetch(current.toString(), {
          redirect: 'manual',
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (resp.status >= 300 && resp.status < 400 && hop < MAX_REDIRECT_HOPS) {
          const loc = resp.headers.get('location');
          try { await resp.body?.cancel(); } catch { /* 忽略释放失败 */ }
          if (loc) {
            let next: URL;
            try {
              next = new URL(loc, current);
            } catch {
              throw new Error('[rag-loader] 非法重定向 Location');
            }
            if (!/^https?:$/.test(next.protocol)) {
              throw new Error('[rag-loader] 重定向到非 http/https 协议，已拒绝');
            }
            current = next;
            continue;
          }
        }
        break;
      }
      if (!resp || !resp.ok) {
        throw new Error(`[rag-loader] URL 抓取失败：HTTP ${resp?.status ?? '?'}（${value}）`);
      }
      // 流式读取 + 字节预算，超限即中止连接（与 webfetch readBodyCapped 同思路）。
      const reader = resp.body?.getReader();
      let html: string;
      if (reader) {
        const dec = new TextDecoder();
        const chunks: string[] = [];
        let received = 0;
        let truncated = false;
        try {
          for (;;) {
            const { done, value: chunk } = await reader.read();
            if (done) break;
            if (!chunk) continue;
            const remain = maxDocBytes - received;
            const take = chunk.subarray(0, Math.max(remain, 0));
            // stream: true 保持跨块 UTF-8 多字节序列状态，避免截断出替换符。
            chunks.push(dec.decode(take, { stream: true }));
            received += take.byteLength;
            if (chunk.byteLength > remain) {
              truncated = true;
              try { await reader.cancel(); } catch { /* 忽略 */ }
              break;
            }
          }
        } finally {
          try { await reader.cancel(); } catch { /* 已结束则忽略 */ }
        }
        html = chunks.join('') + (truncated ? '' : dec.decode());
      } else {
        html = (await resp.text()).slice(0, maxDocBytes);
      }
      const { text, title } = htmlToText(html);
      if (!text) throw new Error(`[rag-loader] URL 正文抽取为空：${value}`);
      return {
        text,
        meta: { sourceType: 'url', finalUrl: current.toString(), ...(title ? { title } : {}) },
      };
    }
    case 'pdf':
      return loadViaExternalService('pdf', value);
    case 'docx':
      return loadViaExternalService('docx', value);
    default:
      throw new Error(`[rag-loader] 不支持的 source.type：${String(source.type)}`);
  }
}

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
      const resp = await fetch(parsed.toString(), { redirect: 'follow' });
      if (!resp.ok) {
        throw new Error(`[rag-loader] URL 抓取失败：HTTP ${resp.status}（${value}）`);
      }
      const html = await resp.text();
      const { text, title } = htmlToText(html);
      if (!text) throw new Error(`[rag-loader] URL 正文抽取为空：${value}`);
      return {
        text,
        meta: { sourceType: 'url', finalUrl: parsed.toString(), ...(title ? { title } : {}) },
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

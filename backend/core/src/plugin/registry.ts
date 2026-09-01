/**
 * 插件远程 registry 客户端（P2.b 插件市场）。
 *
 * 在 P1.③ 的 PluginLoader 之上，增加「从远程 registry 拉取清单 + 版本/依赖解析 + 验签」
 * 的能力，使平台具备插件目录分发。客户端与传输解耦：fetch 实现可注入（测试用 mock），
 * 默认用全局 fetch。
 *
 * 约定端点（registry 侧实现需对齐）：
 *   GET {registryUrl}/plugins            → RegistryIndex（插件列表）
 *   GET {registryUrl}/plugins/:id         → 该插件最新版 RegistryEntry
 *   GET {registryUrl}/plugins/:id/:ver    → 该插件指定版本 RegistryEntry
 * RegistryEntry 含完整 PluginManifest + 可选 signature（hex）+ publishedAt。
 */

import type { PluginManifest } from './manifest';

/** registry 中的单个插件条目（清单 + 签名）。 */
export interface RegistryEntry {
  id: string;
  version: string;
  manifest: PluginManifest;
  /** 清单签名（hex 字符串），由发布者用发布密钥生成。 */
  signature?: string;
  /** 发布时间（ISO 字符串）。 */
  publishedAt?: string;
}

/** registry 索引响应。 */
export interface RegistryIndex {
  plugins: RegistryEntry[];
}

/** 插件 registry 客户端。 */
export class PluginRegistryClient {
  /** 注入的 fetch 实现（测试用）；缺省用全局 fetch。 */
  private readonly fetchImpl?: typeof fetch;

  constructor(fetchImpl?: typeof fetch) {
    this.fetchImpl = fetchImpl;
  }

  private get fetcher(): typeof fetch {
    return this.fetchImpl ?? (globalThis.fetch as unknown as typeof fetch);
  }

  private async httpGetJson<T>(url: string): Promise<T> {
    const res = await this.fetcher(url as unknown as URL);
    if (!res.ok) throw new Error(`plugin registry HTTP ${res.status} for ${url}`);
    return (await res.json()) as T;
  }

  /** 拉取 registry 全量索引。 */
  async index(registryUrl: string): Promise<RegistryEntry[]> {
    const base = registryUrl.replace(/\/$/, '');
    try {
      const idx = await this.httpGetJson<RegistryIndex>(`${base}/plugins`);
      return idx.plugins ?? [];
    } catch {
      // 兼容以数组直接返回的 registry。
      return await this.httpGetJson<RegistryEntry[]>(`${base}/plugins`);
    }
  }

  /** 拉取某插件（不指定版本则取 latest）。 */
  async get(registryUrl: string, id: string, version?: string): Promise<RegistryEntry> {
    const base = registryUrl.replace(/\/$/, '');
    const url = version ? `${base}/plugins/${encodeURIComponent(id)}/${encodeURIComponent(version)}` : `${base}/plugins/${encodeURIComponent(id)}`;
    return this.httpGetJson<RegistryEntry>(url);
  }

  /**
   * 从候选条目中解析目标版本。
   * - range 为精确版本（含点号的数字串）→ 精确匹配，缺失则抛错；
   * - range 为 'latest' 或省略 → 取语义版本最高者；
   * - range 为 '^x.y.z' → 取同主版本号的最高者。
   */
  resolveVersion(entries: RegistryEntry[], range?: string): RegistryEntry {
    if (entries.length === 0) throw new Error('no entries to resolve version from');
    const sorted = (list: RegistryEntry[]) =>
      list.slice().sort((a, b) => cmpVersion(b.version, a.version));
    if (!range || range === 'latest') {
      const best = sorted(entries)[0];
      if (!best) throw new Error('no entries to resolve version from');
      return best;
    }
    if (range.startsWith('^')) {
      const major = range.slice(1).split('.')[0];
      const matched = entries.filter((e) => e.version.split('.')[0] === major);
      if (matched.length === 0) throw new Error(`no plugin version matching ${range}`);
      const best = sorted(matched)[0];
      if (!best) throw new Error(`no plugin version matching ${range}`);
      return best;
    }
    const exact = entries.find((e) => e.version === range);
    if (!exact) throw new Error(`plugin version ${range} not found`);
    return exact;
  }
}

/** 语义化版本比较：a>b 返回 >0，a<b 返回 <0，相等返回 0。非数字段按 0 处理。 */
export function cmpVersion(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}

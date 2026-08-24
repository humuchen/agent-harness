/**
 * 项目知识库服务（真实数据源出口）。
 *
 * - source=db（缺省）：检索本地 ma_project（内容由运营经导入接口写入 / 外部 KB 服务同步落库）。
 *   源码零内置语料——库空即返回空，绝不回退到硬编码数组。
 * - source=http：真实请求外部 KB 服务（MA_KB_BASE_URL），并把结果写穿透缓存到本地库，
 *   便于看板聚合与离线检索。未配置即 fail-closed。
 *
 * P0/P1 升级：
 * - 检索支持「词面 + 意图归一 + 可选语义 hybrid」：若 MA_EMBED_BASE_URL 已配，则对查询实时
 *   嵌入并叠加余弦相似度；未配置则退化为词面+意图，绝不伪造向量。
 * - 合规内建：对客只暴露合规文案（compliantCopy 优先，未过审则退回科普 summary 且不带疗效 FAQ）。
 */

import { searchProjects as dbSearch, upsertProject, listProjects } from '../repo/kb-repo';
import type { ProjectRecord } from '../repo/types';
import { HttpClient } from '../infra/http';
import { getConfig } from '../config';
import { notConfigured } from '../infra/errors';
import { embedText } from '../infra/embed';

/** 实时嵌入查询文本（仅 MA_EMBED_BASE_URL 已配时；未配返回 null，绝不伪造）。 */
async function embedQuery(query: string): Promise<number[] | null> {
  return embedText(query);
}

/** 检索医美项目知识库（真实数据）。 */
export async function searchProjects(query: string, limit = 5): Promise<ProjectRecord[]> {
  const cfg = getConfig();
  // 优先走外部 RAG 服务（services/rag）；未配则回退本地库 / 外部 KB 服务。
  if (cfg.rag.enabled) {
    const r = await searchProjectsRag(query, limit);
    if (r.projects.length) return r.projects;
    // RAG 命中参考文档但无结构化项目时，仍回退本地库补充（安全网，避免空答）。
    if (cfg.kb.enabled || cfg.kb.source === 'db') {
      try {
        const qe = await embedQuery(query);
        return dbSearch(query, limit, qe);
      } catch {
        /* 回退失败不阻断 */
      }
    }
    return [];
  }
  if (cfg.kb.source === 'http') {
    if (!cfg.kb.enabled) throw notConfigured('知识库服务', 'MA_KB_BASE_URL / MA_KB_TOKEN');
    const client = new HttpClient(cfg.kb, 'KB');
    const res = await client.json<{ projects?: ProjectRecord[] }>({
      method: 'GET',
      path: '/v1/projects/search',
      query: { q: query, limit },
    });
    const projects = res?.projects ?? [];
    // 写穿透缓存（非强制）：即便外部服务中断，本地库仍有最近一次的检索结果可展示。
    for (const p of projects) {
      try {
        upsertProject({ ...p, active: true, updatedAt: Date.now() });
      } catch {
        /* 缓存失败不阻断检索 */
      }
    }
    return projects;
  }
  // 缺省：本地库检索（词面 + 意图 + 可选语义）
  const qe = await embedQuery(query);
  return dbSearch(query, limit, qe);
}

/** RAG 检索结果中的参考文档片段（供 Agent 引用）。 */
export interface RagRef {
  title: string;
  content: string;
  score: number;
  confidence?: string;
}

/** 从 RAG /v1/retrieve 结果清洗出结构化项目 + 参考文档。 */
export interface RagSearchResult {
  projects: ProjectRecord[];
  refs: RagRef[];
}

/** 调外部 RAG 服务检索（fail-closed：失败直接抛错，绝不伪造/回退空数据）。 */
async function ragRetrieve(query: string, topK: number): Promise<RagSearchResult> {
  const cfg = getConfig();
  if (!cfg.rag.baseUrl) throw notConfigured('RAG 检索服务', 'MA_RAG_BASE_URL');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.rag.timeoutMs || 8000);
  try {
    const res = await fetch(`${cfg.rag.baseUrl.replace(/\/+$/, '')}/v1/retrieve`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cfg.rag.token ? { authorization: `Bearer ${cfg.rag.token}` } : {}),
      },
      body: JSON.stringify({ query, top_k: topK, score_threshold: 0 }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`RAG 检索失败 HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = (await res.json()) as {
      results?: {
        chunk_id: string;
        title?: string;
        content: string;
        score: number;
        metadata?: Record<string, unknown>;
      }[];
    };
    const results = data.results ?? [];
    const projects: ProjectRecord[] = [];
    const refs: RagRef[] = [];
    for (const r of results) {
      const m = r.metadata ?? {};
      if (m.type === 'project') {
        // 由 RAG 元数据重建 ProjectRecord，保留合规闸门所需字段
        projects.push({
          projectId: String(m.projectId ?? m.name ?? r.chunk_id),
          name: String(m.name ?? ''),
          category: m.category ? String(m.category) : undefined,
          aliases: Array.isArray(m.aliases) ? (m.aliases as string[]) : [],
          summary: String(m.summary ?? ''),
          indications: m.indications ? String(m.indications) : undefined,
          contraindications: m.contraindications ? String(m.contraindications) : undefined,
          recovery: m.recovery ? String(m.recovery) : undefined,
          priceRange: m.priceRange ? String(m.priceRange) : undefined,
          faq: Array.isArray(m.faq)
            ? (m.faq as unknown[]).map((f) =>
                typeof f === 'string' ? { q: f } : { q: String((f as Record<string, unknown>).q ?? ''), a: (f as Record<string, unknown>).a ? String((f as Record<string, unknown>).a) : undefined },
              )
            : [],
          source: 'rag',
          intentTags: Array.isArray(m.intentTags) ? (m.intentTags as string[]) : undefined,
          audience: m.audience ? String(m.audience) : undefined,
          seasonality: m.seasonality ? String(m.seasonality) : undefined,
          compliantCopy: m.compliantCopy ? String(m.compliantCopy) : undefined,
          complianceReviewed: m.complianceReviewed === true,
          updatedAt: Date.now(),
        });
      } else {
        refs.push({
          title: r.title ?? String(m.file ?? r.chunk_id),
          content: r.content,
          score: r.score,
          confidence: m.confidence ? String(m.confidence) : undefined,
        });
      }
    }
    return { projects, refs };
  } finally {
    clearTimeout(timer);
  }
}

/** 经 RAG 检索医美项目知识库（带参考文档）。 */
export async function searchProjectsRag(query: string, limit = 5): Promise<RagSearchResult> {
  return ragRetrieve(query, Math.max(limit, 6));
}

/** 导入/同步一批项目（运营写接口调用）。返回成功条数。 */
export function importProjects(projects: ProjectRecord[]): number {
  let n = 0;
  for (const p of projects) {
    upsertProject({ ...p, updatedAt: p.updatedAt ?? Date.now() });
    n += 1;
  }
  return n;
}

/** 列出知识库项目（看板/校验）。 */
export function listKnowledge(activeOnly = true): ProjectRecord[] {
  return listProjects(activeOnly);
}

/**
 * 对客视图：合规内建核心。
 * - 优先返回 compliantCopy（已过审的对外合规文案）；
 * - 未过审（complianceReviewed=false）则只用科普 summary，且不返回疗效类 FAQ（避免疗效承诺风险）；
 * - 过审条目可附带 FAQ（其 FAQ 应是合规表述）。
 */
export function toCustomerView(p: ProjectRecord): {
  name: string;
  category?: string;
  copy: string;
  reviewed: boolean;
  faq: string[];
  priceRange?: string;
  recovery?: string;
  contraindications?: string;
} {
  const reviewed = p.complianceReviewed === true;
  const copy = (reviewed && p.compliantCopy ? p.compliantCopy : p.summary).trim();
  const faq = reviewed
    ? (p.faq ?? []).map((f) => (f.a ? `${f.q}：${f.a}` : f.q))
    : [];
  return {
    name: p.name,
    category: p.category,
    copy,
    reviewed,
    faq,
    priceRange: p.priceRange,
    recovery: p.recovery,
    contraindications: p.contraindications,
  };
}

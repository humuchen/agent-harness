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

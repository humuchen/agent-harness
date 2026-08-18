/**
 * 项目知识库仓储（真实 SQL 检索）。
 *
 * - 内容由运营经导入接口写入 ma_project，或通过外部 KB 服务（MA_KB_SOURCE=http）同步落库；
 * - searchProjects() 用参数化 LIKE 做模糊初筛 + 关键词命中加权打分（score），返回真实命中；
 * - 源码零内置业务数据，彻底消除"假知识"。库空即返回空——绝不回退到内置语料。
 */

import { getDb, dbCall } from '../infra/db';
import { getConfig } from '../config';
import { type ProjectRecord } from './types';

/** DB 行 → 领域模型（aliases/faq 为 JSON 文本列，需解析）。 */
function rowToProject(r: Record<string, unknown>): ProjectRecord {
  let aliases: string[] = [];
  try {
    aliases = r.aliases ? JSON.parse(String(r.aliases)) : [];
  } catch {
    aliases = [];
  }
  let faq: { q: string; a?: string }[] = [];
  try {
    faq = r.faq ? JSON.parse(String(r.faq)) : [];
  } catch {
    faq = [];
  }
  return {
    projectId: String(r.project_id),
    name: String(r.name),
    category: (r.category as string) ?? undefined,
    aliases,
    summary: String(r.summary),
    indications: (r.indications as string) ?? undefined,
    contraindications: (r.contraindications as string) ?? undefined,
    recovery: (r.recovery as string) ?? undefined,
    priceRange: (r.price_range as string) ?? undefined,
    faq,
    source: (r.source as string) ?? undefined,
    active: Number(r.active) === 1,
    updatedAt: Number(r.updated_at)
  };
}

/** 把查询词拆成小写 token（中英文均按空白/常见标点切），用于命中打分。 */
function tokens(q: string): string[] {
  return q
    .toLowerCase()
    .split(/[\s,，。、;；:：!！?？()（）/]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 1);
}

/**
 * 关键词命中加权打分：name/alias 命中权重最高，category/summary 次之，indications/recovery 再次。
 * 纯函数，便于单测；打分在 JS 侧完成（SQL 只做"是否可能相关"的模糊初筛）。
 */
export function scoreProject(p: ProjectRecord, q: string): number {
  const tks = tokens(q);
  if (!tks.length) return 1;
  const name = p.name.toLowerCase();
  const aliasStr = (p.aliases ?? []).join(' ').toLowerCase();
  const hay: Array<[string, number]> = [
    [name, 5],
    [aliasStr, 4],
    [p.category?.toLowerCase() ?? '', 3],
    [p.summary.toLowerCase(), 2],
    [(p.indications ?? '').toLowerCase(), 2],
    [(p.recovery ?? '').toLowerCase(), 1],
    [(p.priceRange ?? '').toLowerCase(), 1]
  ];
  let score = 0;
  for (const tk of tks) {
    for (const [h, w] of hay) {
      if (h.includes(tk)) score += w;
    }
  }
  return score;
}

/**
 * 检索知识库。库内无相关项目时返回空数组——这是 fail-closed 的正确表现：
 * 没有真实数据就如实告知，而非回退到内置语料。
 */
export function searchProjects(query: string, limit = 5): ProjectRecord[] {
  return dbCall(() => {
    const db = getDb();
    const tid = getConfig().tenantId;
    const like = `%${query.trim()}%`;
    // SQL 层模糊初筛（参数化，防注入）
    const rows = db
      .prepare(
        `SELECT * FROM ma_project WHERE tenant_id = ? AND active = 1
         AND (name LIKE ? OR category LIKE ? OR aliases LIKE ? OR summary LIKE ? OR indications LIKE ?)
         ORDER BY updated_at DESC LIMIT 100`
      )
      .all(tid, like, like, like, like, like);
    const projects = rows.map(rowToProject);
    const q = query.trim();
    if (!q) return projects.slice(0, limit);
    // JS 侧加权打分 + 排序 + 截断
    return projects
      .map((p) => ({ p, s: scoreProject(p, q) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, limit)
      .map((x) => x.p);
  }, '检索知识库');
}

/** 读取单条项目（按 project_id）。 */
export function getProject(projectId: string): ProjectRecord | null {
  return dbCall(() => {
    const row = getDb()
      .prepare(
        'SELECT * FROM ma_project WHERE tenant_id = ? AND project_id = ?'
      )
      .get(getConfig().tenantId, projectId);
    return row ? rowToProject(row) : null;
  }, '读取知识库项目');
}

/** 列出项目（供导入校验/看板）。 */
export function listProjects(activeOnly = true, limit = 100): ProjectRecord[] {
  return dbCall(() => {
    const rows = getDb()
      .prepare(
        `SELECT * FROM ma_project WHERE tenant_id = ? ${
          activeOnly ? 'AND active = 1' : ''
        } ORDER BY category, name LIMIT ?`
      )
      .all(getConfig().tenantId, limit);
    return rows.map(rowToProject);
  }, '列出知识库项目');
}

/** 导入/同步单条项目（upsert），供 KB 导入接口与外部 KB 服务写入。源码自身从不调用。 */
export function upsertProject(p: ProjectRecord): void {
  dbCall(() => {
    const db = getDb();
    db.prepare(
      `INSERT INTO ma_project (
        project_id, tenant_id, name, category, aliases, summary, indications,
        contraindications, recovery, price_range, faq, source, active, updated_at
      ) VALUES (
        :project_id, :tenant_id, :name, :category, :aliases, :summary, :indications,
        :contraindications, :recovery, :price_range, :faq, :source, :active, :updated_at
      )
      ON CONFLICT(project_id) DO UPDATE SET
        name=excluded.name, category=excluded.category, aliases=excluded.aliases,
        summary=excluded.summary, indications=excluded.indications,
        contraindications=excluded.contraindications, recovery=excluded.recovery,
        price_range=excluded.price_range, faq=excluded.faq, source=excluded.source,
        active=excluded.active, updated_at=excluded.updated_at`
    ).run({
      project_id: p.projectId,
      tenant_id: getConfig().tenantId,
      name: p.name,
      category: p.category ?? null,
      aliases: JSON.stringify(p.aliases ?? []),
      summary: p.summary,
      indications: p.indications ?? null,
      contraindications: p.contraindications ?? null,
      recovery: p.recovery ?? null,
      price_range: p.priceRange ?? null,
      faq: JSON.stringify(p.faq ?? []),
      source: p.source ?? 'import',
      active: p.active ?? true ? 1 : 0,
      updated_at: p.updatedAt ?? Date.now()
    });
  }, '导入知识库项目');
}

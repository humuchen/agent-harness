/**
 * 项目知识库仓储（真实 SQL 检索）。
 *
 * 数据来源（单一事实源 → 落库）：
 * - 运营母版 knowledge/domain/project-catalog.json 经 scripts/kb-seed.cjs 灌入；
 * - 或外部 KB 服务（MA_KB_SOURCE=http）同步落库；
 * - 或 POST /kb/import 写接口。
 * 源码零内置业务数据，库空即返回空——绝不回退到内置语料。
 *
 * 检索策略（P0/P1 升级）：
 * 1. SQL 层 LIKE 模糊初筛（参数化，防注入）；
 * 2. JS 侧加权打分（name/alias > category/summary > 适应症/恢复/经营字段）；
 * 3. 意图归一扩展：命中 ma_project_intent 的 keyword 时，把对应项目以意图权重提权（提升
 *    "脸大/显老/毛孔粗" 这类口语诉求的召回，无需堆别名）；
 * 4. 可选语义 hybrid：若查询与项目均带 embedding，则叠加余弦相似度（未配置嵌入服务时跳过，绝不伪造向量）。
 */

import { getDb, dbCall } from '../infra/db';
import { getConfig } from '../config';
import { type ProjectRecord, type IntentMapping } from './types';

/** DB 行 → 领域模型（aliases/faq/embedding 等为 JSON 文本列，需解析）。 */
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
  let embedding: number[] | null = null;
  try {
    embedding = r.embedding
      ? (JSON.parse(String(r.embedding)) as number[])
      : null;
  } catch {
    embedding = null;
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
    updatedAt: Number(r.updated_at),
    intentTags: tryJsonArray(r.intent_tags),
    comboWith: tryJsonArray(r.combo_with),
    audience: (r.audience as string) ?? undefined,
    seasonality: (r.seasonality as string) ?? undefined,
    durationMin: r.duration_min == null ? undefined : Number(r.duration_min),
    painLevel: r.pain_level == null ? undefined : Number(r.pain_level),
    downtimeDays: (r.downtime_days as string) ?? undefined,
    courseSessions: (r.course_sessions as string) ?? undefined,
    avgPriceTier: (r.avg_price_tier as string) ?? undefined,
    compliantCopy: (r.compliant_copy as string) ?? undefined,
    complianceReviewed: Number(r.compliance_reviewed) === 1,
    embedding
  };
}

function tryJsonArray(v: unknown): string[] | undefined {
  if (!v) return undefined;
  try {
    const a = JSON.parse(String(v));
    return Array.isArray(a) ? a.map(String) : undefined;
  } catch {
    return undefined;
  }
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
 * 关键词命中加权打分：name/alias 命中权重最高，category/summary 次之，适应症/恢复/经营字段再次。
 * 纯函数，便于单测；打分在 JS 侧完成（SQL 只做"是否可能相关"的模糊初筛）。
 */
export function scoreProject(p: ProjectRecord, q: string): number {
  const tks = tokens(q);
  if (!tks.length) return 1;
  const hay: Array<[string, number]> = [
    [p.name.toLowerCase(), 5],
    [(p.aliases ?? []).join(' ').toLowerCase(), 4],
    [p.category?.toLowerCase() ?? '', 3],
    [p.summary.toLowerCase(), 2],
    [(p.indications ?? '').toLowerCase(), 2],
    [(p.recovery ?? '').toLowerCase(), 1],
    [(p.priceRange ?? '').toLowerCase(), 1],
    [(p.intentTags ?? []).join(' ').toLowerCase(), 2],
    [(p.audience ?? '').toLowerCase(), 1],
    [(p.avgPriceTier ?? '').toLowerCase(), 1]
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
 * 意图归一扩展：把口语诉求（"脸大/显老/毛孔粗"）映射到知识库项目。
 * 命中 ma_project_intent 的 keyword/intent 时，返回 {projectId: 意图权重} 供检索提权。
 * 仅做包含匹配（查询串包含关键词即算命中），低成本、零依赖、可解释。
 */
export function expandByIntent(query: string): Map<string, number> {
  const q = query.toLowerCase().trim();
  if (!q) return new Map();
  const boost = new Map<string, number>();
  return dbCall(() => {
    const rows = getDb()
      .prepare(
        `SELECT intent, project_id, weight, keywords FROM ma_project_intent WHERE tenant_id = ?`
      )
      .all(getConfig().tenantId) as Array<{
      intent: string;
      project_id: string;
      weight: number;
      keywords: string | null;
    }>;
    for (const r of rows) {
      const kws: string[] = r.keywords ? safeSplitJson(r.keywords) : [];
      const hit =
        q.includes(r.intent.toLowerCase()) ||
        kws.some((k) => q.includes(k.toLowerCase()));
      if (hit) {
        const prev = boost.get(r.project_id) ?? 0;
        boost.set(r.project_id, prev + (r.weight || 1) * 3);
      }
    }
    return boost;
  }, '意图归一扩展');
}

function safeSplitJson(s: string): string[] {
  try {
    const a = JSON.parse(s);
    return Array.isArray(a) ? a.map(String) : [];
  } catch {
    // 退化：按逗号切
    return s
      .split(/[,，]/)
      .map((x) => x.trim())
      .filter(Boolean);
  }
}

/** 余弦相似度（embedding 均为同维向量）。任一为空返回 0。 */
export function cosine(a?: number[] | null, b?: number[] | null): number {
  if (!a || !b || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** 检索知识库（词面打分 + 意图提权 + 可选语义 hybrid）。
 * 库内无相关项目时返回空数组——fail-closed 的正确表现。 */
export function searchProjects(
  query: string,
  limit = 5,
  queryEmbedding?: number[] | null
): ProjectRecord[] {
  return dbCall(() => {
    const db = getDb();
    const tid = getConfig().tenantId;
    const q = query.trim();
    const like = `%${q}%`;
    // 1) 字面初筛（LIKE）作为第一波候选
    const rows = db
      .prepare(
        `SELECT * FROM ma_project WHERE tenant_id = ? AND active = 1
        AND (name LIKE ? OR category LIKE ? OR aliases LIKE ? OR summary LIKE ? OR indications LIKE ? OR intent_tags LIKE ?)
        ORDER BY updated_at DESC LIMIT 200`
      )
      .all(tid, like, like, like, like, like, like) as Record<
      string,
      unknown
    >[];
    const byId = new Map<string, ProjectRecord>();
    for (const r of rows) byId.set(String(r.project_id), rowToProject(r));

    // 2) 意图归一扩展：把口语诉求**直接映射进候选集**（绕过字面 LIKE），
    //    否则"脸大/显老/想变白"等无字面命中的诉求会因 LIKE 空集而空召回。
    const intentBoost = expandByIntent(q);
    if (intentBoost.size) {
      const ids = [...intentBoost.keys()];
      const ph = ids.map(() => '?').join(',');
      const intentRows = db
        .prepare(
          `SELECT * FROM ma_project WHERE tenant_id = ? AND active = 1 AND project_id IN (${ph})`
        )
        .all(tid, ...ids) as Record<string, unknown>[];
      for (const r of intentRows)
        byId.set(String(r.project_id), rowToProject(r));
    }

    const projects = [...byId.values()];
    if (!q && !queryEmbedding) return projects.slice(0, limit);

    const useEmbed =
      !!queryEmbedding &&
      projects.some((p) => p.embedding && p.embedding.length);
    const scored = projects.map((p) => {
      let s = scoreProject(p, q);
      s += intentBoost.get(p.projectId) ?? 0;
      if (useEmbed && p.embedding) {
        s += 4 * cosine(queryEmbedding, p.embedding); // 语义权重与意图同量级
      }
      return { p, s };
    });
    return scored
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
export function listProjects(activeOnly = true, limit = 500): ProjectRecord[] {
  return dbCall(() => {
    const rows = getDb()
      .prepare(
        `SELECT * FROM ma_project WHERE tenant_id = ? ${
          activeOnly ? 'AND active = 1' : ''
        } ORDER BY category, name LIMIT ?`
      )
      .all(getConfig().tenantId, limit) as Record<string, unknown>[];
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
        contraindications, recovery, price_range, faq, source, active, updated_at,
        intent_tags, combo_with, audience, seasonality, duration_min, pain_level,
        downtime_days, course_sessions, avg_price_tier, compliant_copy, compliance_reviewed, embedding
      ) VALUES (
        :project_id, :tenant_id, :name, :category, :aliases, :summary, :indications,
        :contraindications, :recovery, :price_range, :faq, :source, :active, :updated_at,
        :intent_tags, :combo_with, :audience, :seasonality, :duration_min, :pain_level,
        :downtime_days, :course_sessions, :avg_price_tier, :compliant_copy, :compliance_reviewed, :embedding
      )
      ON CONFLICT(project_id) DO UPDATE SET
        name=excluded.name, category=excluded.category, aliases=excluded.aliases,
        summary=excluded.summary, indications=excluded.indications,
        contraindications=excluded.contraindications, recovery=excluded.recovery,
        price_range=excluded.price_range, faq=excluded.faq, source=excluded.source,
        active=excluded.active, updated_at=excluded.updated_at,
        intent_tags=excluded.intent_tags, combo_with=excluded.combo_with,
        audience=excluded.audience, seasonality=excluded.seasonality,
        duration_min=excluded.duration_min, pain_level=excluded.pain_level,
        downtime_days=excluded.downtime_days, course_sessions=excluded.course_sessions,
        avg_price_tier=excluded.avg_price_tier, compliant_copy=excluded.compliant_copy,
        compliance_reviewed=excluded.compliance_reviewed, embedding=excluded.embedding`
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
      updated_at: p.updatedAt ?? Date.now(),
      intent_tags: JSON.stringify(p.intentTags ?? []),
      combo_with: JSON.stringify(p.comboWith ?? []),
      audience: p.audience ?? null,
      seasonality: p.seasonality ?? null,
      duration_min: p.durationMin ?? null,
      pain_level: p.painLevel ?? null,
      downtime_days: p.downtimeDays ?? null,
      course_sessions: p.courseSessions ?? null,
      avg_price_tier: p.avgPriceTier ?? null,
      compliant_copy: p.compliantCopy ?? null,
      compliance_reviewed: p.complianceReviewed ? 1 : 0,
      embedding: p.embedding ? JSON.stringify(p.embedding) : null
    });
  }, '导入知识库项目');
}

/** 清空本租户意图映射（seed 重导入前调用，避免重复累积）。 */
export function clearIntents(): void {
  dbCall(() => {
    getDb()
      .prepare('DELETE FROM ma_project_intent WHERE tenant_id = ?')
      .run(getConfig().tenantId);
  }, '清空意图映射');
}

/** 写入意图映射（intent-map.json → ma_project_intent）。 */
export function upsertIntent(m: IntentMapping): void {
  dbCall(() => {
    getDb()
      .prepare(
        `INSERT INTO ma_project_intent (intent, project_id, tenant_id, weight, keywords)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(intent, project_id, tenant_id) DO UPDATE SET weight=excluded.weight, keywords=excluded.keywords`
      )
      .run(
        m.intent,
        m.projectId,
        getConfig().tenantId,
        m.weight ?? 1,
        JSON.stringify(m.keywords ?? [])
      );
  }, '写入意图映射');
}

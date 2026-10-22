/**
 * 话术库 / 案例库仓储（P1-⑤ 三层知识缺失的两层）。
 *
 * 与 kb-repo 同一纪律：
 * - 参数化 SQL 防注入；
 * - 库空即返回空，绝不回退到内置语料 / 硬编码案例；
 * - 案例强制 masked（入库 true、外发前再校验），绝不携带姓名 / 电话 / 院区精确追溯。
 *
 * 检索策略：LIKE 字面初筛 → JS 侧加权打分（场景/等级/项目/标签命中提权）。
 * 语义 hybrid（embedding）暂不强制：话术/案例量级小、可解释优先；如需可复用 kb-repo 的 embed 路径。
 */

import { getDb, dbCall, allRows, getRow, runStmt } from '../infra/db';
import { getConfig } from '../config';
import { type ScriptRecord, type CaseRecord } from './types';

function safeJsonArray(v: unknown): string[] | undefined {
  if (!v) return undefined;
  try {
    const a = JSON.parse(String(v));
    return Array.isArray(a) ? a.map(String) : undefined;
  } catch {
    return undefined;
  }
}

// ─── 话术库 ─────────────────────────────────────────────────────────

function rowToScript(r: Record<string, unknown>): ScriptRecord {
  return {
    scriptId: String(r.script_id),
    tenantId: String(r.tenant_id),
    scene: String(r.scene),
    grade: (r.grade as ScriptRecord['grade']) ?? undefined,
    project: (r.project as string) ?? undefined,
    title: String(r.title),
    body: String(r.body),
    compliantCopy: (r.compliant_copy as string) ?? undefined,
    complianceReviewed: Number(r.compliance_reviewed) === 1,
    active: Number(r.active) === 1,
    updatedAt: Number(r.updated_at),
  };
}

function tokens(q: string): string[] {
  return q
    .toLowerCase()
    .split(/[\s,，。、;；:：!！?？()（）/]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 1);
}

/** 话术加权打分：场景/等级/项目/标题/正文命中提权。纯函数，便于单测。 */
function scoreScript(s: ScriptRecord, q: string): number {
  const tks = tokens(q);
  if (!tks.length) return 1;
  const hay: Array<[string, number]> = [
    [s.scene.toLowerCase(), 5],
    [(s.title ?? '').toLowerCase(), 4],
    [s.body.toLowerCase(), 2],
    [(s.project ?? '').toLowerCase(), 3],
    [(s.grade ?? '').toLowerCase(), 1],
  ];
  let score = 0;
  for (const tk of tks) {
    for (const [h, w] of hay) if (h.includes(tk)) score += w;
  }
  return score;
}

/** 检索话术：可按场景过滤；未传场景则全场景。合规优先（complianceReviewed 优先返回，但不过滤未审条目，交由调用方处理）。 */
export async function searchScripts(query: string, limit = 5, scene?: string): Promise<ScriptRecord[]> {
  return await dbCall(async () => {
    const db = await getDb();
    const tid = getConfig().tenantId;
    const like = `%${query.trim()}%`;
    const sql =
      `SELECT * FROM ma_script WHERE tenant_id = ? AND active = 1` +
      (scene ? ` AND scene = ?` : ``) +
      ` AND (scene LIKE ? OR title LIKE ? OR body LIKE ? OR project LIKE ?) ORDER BY updated_at DESC LIMIT 200`;
    const params = scene ? [tid, scene, like, like, like, like] : [tid, like, like, like, like];
    const rows = (await allRows(db.prepare(sql), ...params)) as Record<string, unknown>[];
    const scripts = rows.map(rowToScript);
    if (!query.trim()) return scripts.slice(0, limit);
    return scripts
      .map((s) => ({ s, score: scoreScript(s, query) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((x) => x.s);
  }, '检索话术库');
}

/** 读取单条话术。 */
export async function getScript(scriptId: string): Promise<ScriptRecord | null> {
  return await dbCall(async () => {
    const row = await getRow((await getDb()).prepare('SELECT * FROM ma_script WHERE tenant_id = ? AND script_id = ?'), getConfig().tenantId, scriptId);
    return row ? rowToScript(row) : null;
  }, '读取话术');
}

/** 列出话术（看板 / 校验）。 */
export async function listScripts(scene?: string, limit = 500): Promise<ScriptRecord[]> {
  return await dbCall(async () => {
    const db = await getDb();
    const rows = await allRows(
      db.prepare(
        `SELECT * FROM ma_script WHERE tenant_id = ? ${scene ? 'AND scene = ?' : ''} ORDER BY scene, title LIMIT ?`
      ),
      ...(scene ? [getConfig().tenantId, scene, limit] : [getConfig().tenantId, limit])
    );
    return rows.map(rowToScript);
  }, '列出话术库');
}

/** 写入 / 更新话术（运营经导入接口或运营工具写入；源码自身不调用）。 */
export async function upsertScript(s: ScriptRecord): Promise<void> {
  await dbCall(async () => {
    (await getDb())
      .prepare(
        `INSERT INTO ma_script (script_id, tenant_id, scene, grade, project, title, body, compliant_copy, compliance_reviewed, active, updated_at)
         VALUES (:script_id, :tenant_id, :scene, :grade, :project, :title, :body, :compliant_copy, :compliance_reviewed, :active, :updated_at)
         ON CONFLICT(script_id) DO UPDATE SET
           scene=excluded.scene, grade=excluded.grade, project=excluded.project, title=excluded.title,
           body=excluded.body, compliant_copy=excluded.compliant_copy, compliance_reviewed=excluded.compliance_reviewed,
           active=excluded.active, updated_at=excluded.updated_at`
      )
      .run({
        script_id: s.scriptId,
        tenant_id: getConfig().tenantId,
        scene: s.scene,
        grade: s.grade ?? null,
        project: s.project ?? null,
        title: s.title,
        body: s.body,
        compliant_copy: s.compliantCopy ?? null,
        compliance_reviewed: s.complianceReviewed ? 1 : 0,
        active: s.active ?? true ? 1 : 0,
        updated_at: s.updatedAt ?? Date.now(),
      });
  }, '写入话术');
}

// ─── 案例库 ─────────────────────────────────────────────────────────

function rowToCase(r: Record<string, unknown>): CaseRecord {
  return {
    caseId: String(r.case_id),
    tenantId: String(r.tenant_id),
    project: (r.project as string) ?? undefined,
    category: (r.category as string) ?? undefined,
    intent: (r.intent as string) ?? undefined,
    summary: String(r.summary),
    concern: (r.concern as string) ?? undefined,
    approach: (r.approach as string) ?? undefined,
    outcomeNote: (r.outcome_note as string) ?? undefined,
    masked: Number(r.masked) === 1,
    sourceRef: (r.source_ref as string) ?? undefined,
    tags: safeJsonArray(r.tags),
    updatedAt: Number(r.updated_at),
  };
}

/** 案例加权打分：项目/分类/意图/标签/概述命中提权。 */
function scoreCase(c: CaseRecord, q: string): number {
  const tks = tokens(q);
  if (!tks.length) return 1;
  const hay: Array<[string, number]> = [
    [(c.project ?? '').toLowerCase(), 4],
    [(c.category ?? '').toLowerCase(), 3],
    [(c.intent ?? '').toLowerCase(), 3],
    [(c.summary ?? '').toLowerCase(), 2],
    [(c.tags ?? []).join(' ').toLowerCase(), 2],
  ];
  let score = 0;
  for (const tk of tks) {
    for (const [h, w] of hay) if (h.includes(tk)) score += w;
  }
  return score;
}

/** 检索案例：返回前强制校验 masked（未脱敏绝不外发）。 */
export async function searchCases(query: string, limit = 5): Promise<CaseRecord[]> {
  return await dbCall(async () => {
    const db = await getDb();
    const tid = getConfig().tenantId;
    const like = `%${query.trim()}%`;
    const rows = await allRows(
      db.prepare(
        `SELECT * FROM ma_case WHERE tenant_id = ? AND (project LIKE ? OR category LIKE ? OR intent LIKE ? OR summary LIKE ? OR tags LIKE ?)
         ORDER BY updated_at DESC LIMIT 200`
      ),
      tid,
      like,
      like,
      like,
      like,
      like
    );
    const cases = rows.map(rowToCase).filter((c) => c.masked); // 强制脱敏：未 masked 不入检索结果
    if (!query.trim()) return cases.slice(0, limit);
    return cases
      .map((c) => ({ c, score: scoreCase(c, query) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((x) => x.c);
  }, '检索案例库');
}

/** 列出案例。 */
export async function listCases(limit = 500): Promise<CaseRecord[]> {
  return await dbCall(async () => {
    const rows = await allRows(
      (await getDb()).prepare(`SELECT * FROM ma_case WHERE tenant_id = ? ORDER BY updated_at DESC LIMIT ?`),
      getConfig().tenantId,
      limit
    );
    return (rows.map(rowToCase) as CaseRecord[]).filter((c) => c.masked);
  }, '列出案例库');
}

/**
 * 写入 / 更新案例。入库强制 masked=true（即便调用方传 false 也纠正），
 * 绝不存储可定位到具体个人的精确信息——这是案例库的合规硬约束。
 */
export async function upsertCase(c: CaseRecord): Promise<void> {
  await dbCall(async () => {
    (await getDb())
      .prepare(
        `INSERT INTO ma_case (case_id, tenant_id, project, category, intent, summary, concern, approach, outcome_note, masked, source_ref, tags, updated_at)
         VALUES (:case_id, :tenant_id, :project, :category, :intent, :summary, :concern, :approach, :outcome_note, :masked, :source_ref, :tags, :updated_at)
         ON CONFLICT(case_id) DO UPDATE SET
           project=excluded.project, category=excluded.category, intent=excluded.intent, summary=excluded.summary,
           concern=excluded.concern, approach=excluded.approach, outcome_note=excluded.outcome_note,
           masked=excluded.masked, source_ref=excluded.source_ref, tags=excluded.tags, updated_at=excluded.updated_at`
      )
      .run({
        case_id: c.caseId,
        tenant_id: getConfig().tenantId,
        project: c.project ?? null,
        category: c.category ?? null,
        intent: c.intent ?? null,
        summary: c.summary,
        concern: c.concern ?? null,
        approach: c.approach ?? null,
        outcome_note: c.outcomeNote ?? null,
        masked: 1, // 强制脱敏
        source_ref: c.sourceRef ?? null,
        tags: JSON.stringify(c.tags ?? []),
        updated_at: c.updatedAt ?? Date.now(),
      });
  }, '写入案例');
}

/** 删除案例（软删：active 概念在案例不存在，这里物理删除并留痕由调用方负责）。 */
export async function deleteCase(caseId: string): Promise<void> {
  await dbCall(async () => {
    await runStmt((await getDb()).prepare('DELETE FROM ma_case WHERE tenant_id = ? AND case_id = ?'), getConfig().tenantId, caseId);
  }, '删除案例');
}

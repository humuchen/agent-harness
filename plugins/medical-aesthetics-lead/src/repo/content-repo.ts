/**
 * 内容仓储（D8/D9 先审后发流水线的持久层）。
 *
 * 语义：
 * - content_id 主键：模板批量生成用确定性 id（tpl_{platform}_{project}_{日期}）实现
 *   「同日同项目同平台只生成一次」的幂等；手动/LLM 草稿用随机 id。
 * - 状态机迁移在 service 层校验，本层只负责写入与查询。
 * - review_reason / publish_error 复用为驳回原因与发布失败记录（终态可追溯）。
 */

import { getDb, dbCall, allRows, getRow, runStmt } from '../infra/db';
import { getConfig } from '../config';

export type ContentPlatform = 'xiaohongshu' | 'douyin' | 'livestream';
export type ContentSource = 'manual' | 'template' | 'llm';
export type ContentState = 'draft' | 'review' | 'approved' | 'rejected' | 'published';

export interface ContentRow {
  contentId: string;
  platform: ContentPlatform;
  title: string;
  body: string;
  project?: string;
  source: ContentSource;
  state: ContentState;
  reviewReason?: string;
  reviewedBy?: string;
  reviewedAt?: number;
  publishedAt?: number;
  publishRef?: string;
  publishError?: string;
  createdAt: number;
  updatedAt: number;
}

function rowToContent(r: Record<string, unknown>): ContentRow {
  return {
    contentId: String(r.content_id),
    platform: String(r.platform) as ContentPlatform,
    title: String(r.title),
    body: String(r.body),
    project: (r.project as string) ?? undefined,
    source: String(r.source) as ContentSource,
    state: String(r.state) as ContentState,
    reviewReason: (r.review_reason as string) ?? undefined,
    reviewedBy: (r.reviewed_by as string) ?? undefined,
    reviewedAt: r.reviewed_at != null ? Number(r.reviewed_at) : undefined,
    publishedAt: r.published_at != null ? Number(r.published_at) : undefined,
    publishRef: (r.publish_ref as string) ?? undefined,
    publishError: (r.publish_error as string) ?? undefined,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

/**
 * 插入内容（content_id 冲突则忽略）。返回是否真正插入（false = 已存在，幂等去重）。
 */
export async function insertContent(input: {
  contentId: string;
  platform: ContentPlatform;
  title: string;
  body: string;
  project?: string;
  source: ContentSource;
  state: ContentState;
}): Promise<boolean> {
  return await dbCall(async () => {
    const r = await runStmt(
      (await getDb()).prepare(
        `INSERT INTO ma_content (content_id, tenant_id, platform, title, body, project, source, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(content_id) DO NOTHING`
      ),
      input.contentId,
      getConfig().tenantId,
      input.platform,
      input.title,
      input.body,
      input.project ?? null,
      input.source,
      input.state,
      Date.now(),
      Date.now()
    );
    return Number(r.changes) > 0;
  }, '插入内容草稿');
}

/** 按 id 取单条；不存在返回 null。 */
export async function getContent(contentId: string): Promise<ContentRow | null> {
  return await dbCall(async () => {
    const row = await getRow(
      (await getDb()).prepare('SELECT * FROM ma_content WHERE content_id = ? AND tenant_id = ?'),
      contentId,
      getConfig().tenantId
    );
    return row ? rowToContent(row) : null;
  }, '查询内容');
}

/** 列表查询（状态 / 平台过滤，按更新时间倒序）。 */
export async function listContent(filter: { state?: ContentState; platform?: ContentPlatform; limit?: number } = {}): Promise<ContentRow[]> {
  return await dbCall(async () => {
    const conds: string[] = ['tenant_id = ?'];
    const params: unknown[] = [getConfig().tenantId];
    if (filter.state) {
      conds.push('state = ?');
      params.push(filter.state);
    }
    if (filter.platform) {
      conds.push('platform = ?');
      params.push(filter.platform);
    }
    params.push(Math.min(Math.max(filter.limit ?? 50, 1), 200));
    const rows = await allRows(
      (await getDb()).prepare(
        `SELECT * FROM ma_content WHERE ${conds.join(' AND ')} ORDER BY updated_at DESC LIMIT ?`
      ),
      ...params
    );
    return rows.map(rowToContent);
  }, '查询内容列表');
}

/**
 * 状态机迁移写入（service 层已校验合法性，这里按 patch 精确更新对应列）。
 * publish 失败重试时只更新 publish_error，不重复清 reviewed 字段。
 */
export async function updateContentState(
  contentId: string,
  patch: {
    state?: ContentState;
    reviewReason?: string | null;
    reviewedBy?: string | null;
    reviewedAt?: number | null;
    publishedAt?: number | null;
    publishRef?: string | null;
    publishError?: string | null;
  }
): Promise<void> {
  await dbCall(async () => {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.state !== undefined) {
      sets.push('state = ?');
      params.push(patch.state);
    }
    if (patch.reviewReason !== undefined) {
      sets.push('review_reason = ?');
      params.push(patch.reviewReason === null ? null : String(patch.reviewReason).slice(0, 500));
    }
    if (patch.reviewedBy !== undefined) {
      sets.push('reviewed_by = ?');
      params.push(patch.reviewedBy === null ? null : String(patch.reviewedBy).slice(0, 100));
    }
    if (patch.reviewedAt !== undefined) {
      sets.push('reviewed_at = ?');
      params.push(patch.reviewedAt === null ? null : patch.reviewedAt);
    }
    if (patch.publishedAt !== undefined) {
      sets.push('published_at = ?');
      params.push(patch.publishedAt === null ? null : patch.publishedAt);
    }
    if (patch.publishRef !== undefined) {
      sets.push('publish_ref = ?');
      params.push(patch.publishRef === null ? null : String(patch.publishRef).slice(0, 200));
    }
    if (patch.publishError !== undefined) {
      sets.push('publish_error = ?');
      params.push(patch.publishError === null ? null : String(patch.publishError).slice(0, 500));
    }
    sets.push('updated_at = ?');
    params.push(Date.now());
    params.push(contentId);
    params.push(getConfig().tenantId);
    await runStmt(
      (await getDb()).prepare(`UPDATE ma_content SET ${sets.join(', ')} WHERE content_id = ? AND tenant_id = ?`),
      ...params
    );
  }, '更新内容状态');
}

/** 内容统计（按状态 / 按平台），看板与 /content 路由用。 */
export async function contentStats(): Promise<{
  byState: Record<string, number>;
  byPlatform: Record<string, number>;
  pendingReview: number;
}> {
  return await dbCall(async () => {
    const db = await getDb();
    const tid = getConfig().tenantId;
    const byState: Record<string, number> = {};
    for (const r of await allRows(db.prepare('SELECT state, COUNT(*) AS c FROM ma_content WHERE tenant_id = ? GROUP BY state'), tid)) {
      byState[String(r.state)] = Number(r.c);
    }
    const byPlatform: Record<string, number> = {};
    for (const r of await allRows(db.prepare('SELECT platform, COUNT(*) AS c FROM ma_content WHERE tenant_id = ? GROUP BY platform'), tid)) {
      byPlatform[String(r.platform)] = Number(r.c);
    }
    const pending = (await getRow(
      db.prepare(`SELECT COUNT(*) AS c FROM ma_content WHERE tenant_id = ? AND state = 'review'`),
      tid
    )) as Record<string, unknown> | undefined;
    return { byState, byPlatform, pendingReview: Number(pending?.c ?? 0) };
  }, '内容统计');
}

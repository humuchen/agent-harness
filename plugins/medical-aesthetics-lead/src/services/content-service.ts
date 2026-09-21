/**
 * 内容生产与先审后发服务（D8/D9）。
 *
 * 链路：知识库（真实数据）→ 平台模板骨架生成 / LLM 起草 / 运营手写
 *      → 医疗广告合规筛查（medicalAdRules）→ 人工审核（review）→ 过审（approved）
 *      → 发布（渠道网关 POST /v1/content/publish，幂等键 content:{contentId}）。
 *
 * 硬约束（fail-closed）：
 * - 知识库为空 → 生成直接报错，绝不回退内置语料；
 * - 模板文案只组装 KB 字段（科普 summary/compliantCopy、适合人群、恢复期、禁忌、价格区间），
 *   不生成任何疗效承诺；价格必须以「面诊为准」收口；
 * - 任何来源的文案入审前必过 medicalAdRules，命中即拒；
 * - 未过审（approved 之前）绝不发布；网关未配置 → 发布诚实失败（NOT_CONFIGURED），
 *   内容保持 approved 可重试，绝不假装已发布；
 * - 每条对客发布文案末尾统一追加风险提示（RISK_HINT）。
 */

import { medicalAdRules } from '@agent-harness/medical-ad-guard';
import { listKnowledge } from './kb-service';
import { OutreachClient } from './outreach-client';
import {
  insertContent,
  getContent,
  listContent,
  updateContentState,
  contentStats,
} from '../repo/content-repo';
import type { ContentRow, ContentPlatform, ContentState } from '../repo/content-repo';
import { MaError, toMaError } from '../infra/errors';

/** 平台白名单（防误传任意字符串进状态机）。 */
export const CONTENT_PLATFORMS: readonly ContentPlatform[] = ['xiaohongshu', 'douyin', 'livestream'] as const;

export function isContentPlatform(v: string): v is ContentPlatform {
  return (CONTENT_PLATFORMS as readonly string[]).includes(v);
}

/** 发布时统一追加的风险提示（与对客触达消息同一纪律）。 */
const PUBLISH_RISK_HINT = '医疗美容有风险，最终以面诊方案为准。';

// ---------------------------------------------------------------------------
// 合规筛查（入审闸门）
// ---------------------------------------------------------------------------

export interface AdViolation {
  matched: string;
  reason: string;
}

/** 对（标题+正文）跑医疗广告红线正则。返回全部命中；空数组 = 通过。 */
export function screenContent(title: string, body: string): AdViolation[] {
  const text = `${title}\n${body}`;
  const hits: AdViolation[] = [];
  for (const rule of medicalAdRules) {
    const m = rule.re.exec(text);
    if (m) hits.push({ matched: m[0], reason: rule.reason });
  }
  return hits;
}

/** 筛查不通过时统一抛 INVALID_ARGUMENT（列出全部命中，便于运营改稿）。 */
function assertCompliant(title: string, body: string): void {
  const hits = screenContent(title, body);
  if (hits.length) {
    throw new MaError(
      'INVALID_ARGUMENT',
      `医疗广告合规红线：文案命中 ${hits.length} 条违规模式，禁止进入发布流程。命中明细：${hits
        .map((h) => `「${h.matched}」(${h.reason})`)
        .join('；')}`,
      { violations: hits }
    );
  }
}

// ---------------------------------------------------------------------------
// 模板骨架生成（只组装 KB 字段，零编造）
// ---------------------------------------------------------------------------

/** 平台标题样式（只改框架词，不引入新的事实性表述）。 */
function buildTitle(platform: ContentPlatform, projectName: string): string {
  if (platform === 'xiaohongshu') return `${projectName}｜新手科普笔记`;
  if (platform === 'douyin') return `${projectName}：一分钟看懂`;
  return `【科普】${projectName} 常见问题梳理`;
}

/** 平台正文骨架：全部字段来自知识库，缺字段跳过该段，绝不补写。 */
function buildBody(platform: ContentPlatform, p: {
  name: string;
  summary: string;
  compliantCopy?: string;
  complianceReviewed: boolean;
  audience?: string;
  recovery?: string;
  contraindications?: string;
  priceRange?: string;
  faq?: { q: string; a?: string }[];
}): string {
  const parts: string[] = [];
  // 科普正文：过审条目用合规文案，未过审只用科普 summary（与 KB 对客视图同一纪律）
  const copy = (p.complianceReviewed && p.compliantCopy ? p.compliantCopy : p.summary).trim();
  parts.push(`关于${p.name}：${copy}`);
  if (p.audience) parts.push(`适合人群：${p.audience}`);
  if (p.recovery) parts.push(`恢复期提示：${p.recovery}`);
  if (p.contraindications) parts.push(`注意事项：${p.contraindications}`);
  if (p.priceRange) parts.push(`价格区间：${p.priceRange}（最终以面诊方案为准）`);
  if (p.complianceReviewed && p.faq && p.faq.length) {
    for (const f of p.faq.slice(0, 2)) {
      parts.push(f.a ? `Q：${f.q}\nA：${f.a}` : `Q：${f.q}`);
    }
  }
  parts.push('具体方案因人而异，请以到店面诊为准。');
  // 平台框架词差异（仅语气框架，不引入新事实）
  if (platform === 'douyin') return parts.join('\n');
  if (platform === 'livestream') return parts.join('\n');
  return parts.join('\n');
}

export interface GenerateResult {
  generated: number;
  skipped: { project: string; platform: ContentPlatform; reason: string }[];
  contentIds: string[];
}

/**
 * 从知识库批量生成平台内容（真实数据、同日幂等）。
 * - platform 缺省 → 三平台全量；projectName 缺省 → 全部在架项目；
 * - content_id = tpl_{platform}_{projectId}_{YYYY-MM-DD}：同日重复调用幂等去重；
 * - 生成后过合规筛查，意外命中的条目跳过并记录原因（不落库）。
 */
export async function generateTemplateContent(opts: { platform?: string; projectName?: string } = {}): Promise<GenerateResult> {
  const platforms = opts.platform ? [opts.platform] : [...CONTENT_PLATFORMS];
  for (const pf of platforms) {
    if (!isContentPlatform(pf)) {
      throw new MaError('INVALID_ARGUMENT', `platform 必须是 ${CONTENT_PLATFORMS.join('|')}，收到：${pf}`);
    }
  }
  const kb = await listKnowledge(true);
  let projects = kb;
  if (opts.projectName) {
    const key = opts.projectName.trim();
    projects = kb.filter((p) => p.name === key || p.projectId === key || (p.aliases ?? []).includes(key));
    if (!projects.length) {
      throw new MaError('NOT_FOUND', `知识库中不存在项目「${key}」，请先经 /kb/import 导入或修正项目名`);
    }
  }
  if (!projects.length) {
    throw new MaError('NOT_CONFIGURED', '知识库为空，无法生成内容（请先经 POST /kb/import 导入项目知识，绝不回退内置语料）');
  }
  const today = new Date().toISOString().slice(0, 10);
  const result: GenerateResult = { generated: 0, skipped: [], contentIds: [] };
  for (const p of projects) {
    for (const pf of platforms as ContentPlatform[]) {
      const title = buildTitle(pf, p.name);
      const body = buildBody(pf, {
        name: p.name,
        summary: p.summary,
        compliantCopy: p.compliantCopy,
        complianceReviewed: p.complianceReviewed === true,
        audience: p.audience,
        recovery: p.recovery,
        contraindications: p.contraindications,
        priceRange: p.priceRange,
        faq: p.faq,
      });
      const hits = screenContent(title, body);
      if (hits.length) {
        // 模板内容理论上是合规字段组装；意外命中（如导入语料本身含违规词）→ 跳过并记录
        result.skipped.push({ project: p.name, platform: pf, reason: hits.map((h) => h.reason).join('；') });
        continue;
      }
      const contentId = `tpl_${pf}_${p.projectId}_${today}`;
      const inserted = await insertContent({
        contentId,
        platform: pf,
        title,
        body,
        project: p.name,
        source: 'template',
        state: 'review',
      });
      if (inserted) {
        result.generated += 1;
        result.contentIds.push(contentId);
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// 手动草稿 / 送审 / 审核 / 发布（状态机）
// ---------------------------------------------------------------------------

/** 创建运营/LLM 手写草稿（过合规筛查后落库为 draft；送审走 submitContent）。source 区分人工与 LLM 起草。 */
export async function createManualDraft(input: {
  platform: string;
  title: string;
  body: string;
  project?: string;
  source?: 'manual' | 'llm';
}): Promise<{ contentId: string; state: ContentState }> {
  if (!isContentPlatform(input.platform)) {
    throw new MaError('INVALID_ARGUMENT', `platform 必须是 ${CONTENT_PLATFORMS.join('|')}，收到：${input.platform}`);
  }
  const title = input.title.trim();
  const body = input.body.trim();
  if (!title || !body) throw new MaError('INVALID_ARGUMENT', 'title 与 body 均不能为空');
  assertCompliant(title, body);
  const contentId = `c_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await insertContent({
    contentId,
    platform: input.platform,
    title,
    body,
    project: input.project?.trim() || undefined,
    source: input.source ?? 'manual',
    state: 'draft',
  });
  return { contentId, state: 'draft' };
}

const SUBMITABLE: readonly ContentState[] = ['draft', 'rejected'] as const;

/** 送审：draft / rejected → review。 */
export async function submitContent(contentId: string, operator?: string): Promise<ContentRow> {
  const c = await mustGet(contentId);
  if (!SUBMITABLE.includes(c.state)) {
    throw new MaError('CONFLICT', `当前状态 ${c.state} 不允许送审（仅 draft/rejected 可送审）`);
  }
  assertCompliant(c.title, c.body); // 送审前再跑一遍红线（防 DB 手改绕过）
  await updateContentState(contentId, {
    state: 'review',
    reviewReason: null,
    reviewedBy: null,
    reviewedAt: null,
    publishError: null,
  });
  return (await mustGet(contentId, operator)) as ContentRow;
}

/** 过审：review → approved（人工终审唯一放行点）。 */
export async function approveContent(contentId: string, reviewer: string): Promise<ContentRow> {
  const c = await mustGet(contentId);
  if (c.state !== 'review') {
    throw new MaError('CONFLICT', `当前状态 ${c.state} 不允许过审（仅 review 可过审）`);
  }
  await updateContentState(contentId, {
    state: 'approved',
    reviewedBy: reviewer.slice(0, 100) || 'operator',
    reviewedAt: Date.now(),
    reviewReason: null,
  });
  return mustGet(contentId);
}

/** 驳回：review → rejected（必须给原因，运营据此改稿）。 */
export async function rejectContent(contentId: string, reviewer: string, reason: string): Promise<ContentRow> {
  const c = await mustGet(contentId);
  if (c.state !== 'review') {
    throw new MaError('CONFLICT', `当前状态 ${c.state} 不允许驳回（仅 review 可驳回）`);
  }
  if (!reason.trim()) throw new MaError('INVALID_ARGUMENT', '驳回必须给出原因（reviewReason）');
  await updateContentState(contentId, {
    state: 'rejected',
    reviewedBy: reviewer.slice(0, 100) || 'operator',
    reviewedAt: Date.now(),
    reviewReason: reason.slice(0, 500),
  });
  return mustGet(contentId);
}

/**
 * 发布：approved → 渠道网关 POST /v1/content/publish → published。
 * - 网关未配置 → NOT_CONFIGURED，内容保持 approved（可重试），绝不假装已发布；
 * - 网关失败 → 保持 approved，publish_error 记录原因，重试安全（幂等键 content:{contentId}）；
 * - 发布文案末尾统一追加风险提示。
 */
export async function publishContent(contentId: string): Promise<ContentRow> {
  const c = await mustGet(contentId);
  if (c.state !== 'approved') {
    throw new MaError('CONFLICT', `当前状态 ${c.state} 不允许发布（仅 approved 可发布，先审后发是硬约束）`);
  }
  const text = `${c.title}\n\n${c.body}\n\n${PUBLISH_RISK_HINT}`;
  try {
    const client = new OutreachClient();
    const res = await client.publishContent(
      {
        contentId: c.contentId,
        platform: c.platform,
        title: c.title,
        text,
        project: c.project,
      },
      `content:${c.contentId}`
    );
    await updateContentState(contentId, {
      state: 'published',
      publishedAt: Date.now(),
      publishRef: res.ref ?? null,
      publishError: null,
    });
  } catch (e) {
    const me = toMaError(e);
    // 失败不留脏终态：保持 approved，记录 publish_error 供重试与排障
    await updateContentState(contentId, { publishError: me.message });
    throw me;
  }
  return mustGet(contentId);
}

async function mustGet(contentId: string, _?: string): Promise<ContentRow> {
  const c = await getContent(contentId);
  if (!c) throw new MaError('NOT_FOUND', `内容不存在：${contentId}`);
  return c;
}

// ---------------------------------------------------------------------------
// 快照（看板 / GET /content）
// ---------------------------------------------------------------------------

/** 内容流水线快照：统计 + 各状态队列样本。 */
export async function contentSnapshot(filter: { state?: ContentState; platform?: ContentPlatform; limit?: number } = {}): Promise<{
  stats: Awaited<ReturnType<typeof contentStats>>;
  items: ContentRow[];
}> {
  const [stats, items] = await Promise.all([contentStats(), listContent(filter)]);
  return { stats, items };
}

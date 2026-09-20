/**
 * 计划桥产物归档（P4.6）。
 *
 * 背景：plan 模式 DAG 各 step 的产出此前只写共享黑板与执行摘要文本，
 * 没有落成可下载的文件；结论里也就没有「交付文件」可打开/可下载。
 * 本模块在 plan 来源工作流终态时，把每个 done step 的产出文本归档进
 * 既有 artifact-store（kind=plan-step-output、runId=workflowId），
 * 前端经 GET /api/artifacts?runId=<wfId> 拉回并在结论末尾渲染
 * 「📎 交付文件」区（打开 /api/artifacts/<id>?preview=1 + 下载 ?download=1）。
 *
 * 纪律：
 * - **仅 plan 桥**：def.failOnInvalidOutput === true（planToWorkflowDef 默认开启；
 *   手工 WorkflowDef 缺省 false → 零回归）；
 * - **仅全成功**：run.state === 'done' 才归档（failed/awaiting 的 run 无「最终交付物」）；
 * - **无效产出不归档**：inspectStepOutput 判 empty/partial/fallback 的 step 跳过
 *   （与 P4.5 闸门同语义——假成功不落盘）；
 * - **幂等**：按 runId + note(stepId) 去重，resume 重放不重复归档；
 * - **旁路不阻断**：归档失败仅 console.warn，绝不影响 SSE 执行链路；
 * - **体积护栏**：单产出超 512KB 截断（防 Render free 盘膨胀，R5 同款纪律）。
 */
import type { WorkflowDef, WorkflowRun, StepDef } from '@agent-harness/core';
import { inspectStepOutput } from '@agent-harness/core';
import { getArtifactStore, type ArtifactMeta } from './artifact-store';

/** 归档 kind 常量（前端/服务端共用语义，写死防漂移）。 */
export const PLAN_ARTIFACT_KIND = 'plan-step-output';
/** 归档 mime（step 产出均为 markdown 文本摘要）。 */
export const PLAN_ARTIFACT_MIME = 'text/markdown';
/** 单产物体积上限（截断落盘，防 store 膨胀）。 */
export const PLAN_ARTIFACT_MAX_BYTES = 512 * 1024;

/** 归档结果：archived=本次新写入的 meta；skipped=按纪律跳过/去重跳过的 stepId。 */
export interface ArchivePlanArtifactsResult {
  archived: ArtifactMeta[];
  skipped: string[];
}

/**
 * 由 plan step 的 StepDef.inputMapping.taskMeta（JSON 字符串 {id,title,...}）生成
 * 人类可读文件名；解析失败回落 `task-<stepId>.md`。纯函数（便于单测）。
 */
export function buildPlanArtifactName(stepDef: StepDef | undefined, stepId: string): string {
  const raw: string | undefined = stepDef?.inputMapping?.taskMeta;
  let title = '';
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as { title?: unknown };
      if (parsed && typeof parsed.title === 'string') title = parsed.title.trim();
    } catch {
      title = ''; // taskMeta 非法不阻断归档（P4.5 同款纪律）
    }
  }
  // 文件名安全化：去分隔符 / 保留中英文数字与少量标点，限长 60。
  const safe = (title || `task-${stepId}`)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 60)
    .trim();
  return safe ? `${safe}.md` : `task-${stepId}.md`;
}

/**
 * plan 来源工作流终态归档入口（server.ts 三端点共用：run / resume / approve）。
 * 见模块头纪律；任何异常仅 warn，返回已完成的归档结果（绝不 throw 阻断链路）。
 */
export async function archivePlanArtifacts(params: {
  def: WorkflowDef;
  run: WorkflowRun;
  owner: string;
}): Promise<ArchivePlanArtifactsResult> {
  const { def, run, owner } = params;
  const result: ArchivePlanArtifactsResult = { archived: [], skipped: [] };
  // 仅 plan 桥（手工 def 缺省 failOnInvalidOutput=undefined → 零回归）。
  if (def.failOnInvalidOutput !== true) return result;
  // 仅全成功 run 归档「最终交付物」。
  if (run.state !== 'done') return result;

  const stepDefById = new Map<string, StepDef>();
  for (const s of def.steps) stepDefById.set(s.id, s);

  // 幂等：本 runId 已归档的 stepId 集合（note 字段即 stepId）。
  let existing = new Set<string>();
  try {
    const metas = await getArtifactStore().list(def.id);
    existing = new Set(
      metas.filter((m) => m.kind === PLAN_ARTIFACT_KIND).map((m) => m.note ?? '')
    );
  } catch {
    existing = new Set(); // list 失败保守按「无既有」处理，最坏重复一条
  }

  for (const [stepId, sr] of Object.entries(run.steps ?? {})) {
    if (sr.state !== 'done') continue;
    if (existing.has(stepId)) {
      result.skipped.push(stepId);
      continue;
    }
    const insp = inspectStepOutput(sr.output);
    if (insp.issue !== 'ok') {
      // 无效产出（空 / 中断 / 兜底话术）不落盘——与 P4.5 闸门同语义。
      result.skipped.push(stepId);
      continue;
    }
    let body: string;
    if (typeof sr.output === 'string') body = sr.output;
    else {
      try {
        body = JSON.stringify(sr.output, null, 2) ?? '';
      } catch {
        body = String(sr.output);
      }
    }
    let content: Buffer = Buffer.from(body, 'utf-8');
    if (content.length > PLAN_ARTIFACT_MAX_BYTES) {
      content = Buffer.from(
        body.slice(0, PLAN_ARTIFACT_MAX_BYTES) + '\n\n（产物过大已截断，完整内容见该任务执行详情）\n',
        'utf-8'
      );
    }
    try {
      const meta = await getArtifactStore().save({
        name: buildPlanArtifactName(stepDefById.get(stepId), stepId),
        kind: PLAN_ARTIFACT_KIND,
        mimeType: PLAN_ARTIFACT_MIME,
        content,
        owner,
        runId: def.id,
        note: stepId
      });
      result.archived.push(meta);
    } catch (e) {
      console.warn(
        `[plan-artifacts] 归档 step ${stepId} 失败（不阻断执行）：${e instanceof Error ? e.message : String(e)}`
      );
    }
  }
  return result;
}

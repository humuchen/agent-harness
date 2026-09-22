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
 * 合并交付文档在 artifact-store 里的 note 标记（幂等键）：
 * 与前端 `chat.ts` 的 `attachPlanDeliverables` 共用同一语义（PLAN_FINAL_ARTIFACT_NOTE）。
 * 同一 runId 下至多一份合并文档 —— 后端（本模块）与前端（buildPlanFinalReport）
 * 谁先落盘谁生效，另一方经 note 去重跳过，确保「📎 交付文件」区只有**一份**
 * 可阅读的交付文档，而非每个 step 一个散落文件（解决「文件混乱、无法梳理」）。
 */
export const PLAN_FINAL_ARTIFACT_NOTE = '__plan_final__';

/** 文件名安全化：去文件系统/URL 非法字符，限长，空则回落固定名。 */
function sanitizeArtifactName(s: string, fallback: string): string {
  const safe = s
    .replace(/[\\/:*?"<>|\u0000-\u001f#%&{}$!'@+=`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
  return safe || fallback;
}

/**
 * 由 plan step 的 StepDef.inputMapping.taskMeta（JSON 字符串 {id,title,...}）解析
 * 人类可读标题；解析失败回落 stepId。纯函数。
 */
function stepTitle(stepDef: StepDef | undefined, stepId: string): string {
  const raw: string | undefined = stepDef?.inputMapping?.taskMeta;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as { title?: unknown };
      if (parsed && typeof parsed.title === 'string' && parsed.title.trim()) {
        return parsed.title.trim();
      }
    } catch {
      /* taskMeta 非法不阻断归档（P4.5 同款纪律） */
    }
  }
  return stepId;
}

/**
 * plan 来源工作流终态归档入口（server.ts 多端点共用：run / resume / approve）。
 *
 * 行为收口：**不再为每个 step 落一个独立文件**，而是把所有已完成、产出有效的
 * step 合成**一份**合并交付文档（markdown）归档，note=`__plan_final__`。
 * 与前端 `attachPlanDeliverables` 同源 note 去重，保证「📎 交付文件」区只有这一份
 * 可阅读文档，彻底消除「多个散落文件、无法梳理」的问题。
 *
 * 纪律（沿用模块头）：仅 plan 桥（failOnInvalidOutput===true）、仅全成功 run、
 * 无效产出不归档、幂等、旁路不阻断、单任务产出超 512KB 截断。
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

  // 幂等：本 runId 已存在合并交付文档（含前端 buildPlanFinalReport 同源 note）则跳过。
  try {
    const metas = await getArtifactStore().list(def.id);
    if (
      metas.some(
        (m) => m.kind === PLAN_ARTIFACT_KIND && m.note === PLAN_FINAL_ARTIFACT_NOTE
      )
    ) {
      result.skipped.push(PLAN_FINAL_ARTIFACT_NOTE);
      return result;
    }
  } catch {
    /* list 失败保守按「无既有」处理 */
  }

  const lines: string[] = [];
  const doneTotal = def.steps.filter((s) => run.steps?.[s.id]?.state === 'done').length;
  lines.push('# 计划交付文档');
  lines.push('');
  lines.push(
    `> 由计划模式自动合并归档 · 工作流 \`${def.id}\` · 共 ${def.steps.length} 个任务，完成 ${doneTotal} 个 · 生成于 ${new Date().toISOString()}`
  );
  lines.push('');
  lines.push('## 执行状态');
  lines.push('');
  for (const s of def.steps) {
    const st = run.steps?.[s.id]?.state ?? 'pending';
    const mark = st === 'done' ? '✅' : st === 'failed' ? '❌' : '⏭';
    lines.push(`- ${mark} **${s.id}** ${stepTitle(stepDefById.get(s.id), s.id)}（${st}）`);
  }
  lines.push('');
  lines.push('## 任务产出');
  for (const s of def.steps) {
    lines.push('');
    const title = stepTitle(stepDefById.get(s.id), s.id);
    lines.push(`### ${s.id} · ${title}`);
    lines.push('');
    const sr = run.steps?.[s.id];
    if (!sr || sr.state !== 'done') {
      lines.push(`（该任务状态为 ${sr?.state ?? 'pending'}，无产出。）`);
      continue;
    }
    const insp = inspectStepOutput(sr.output);
    if (insp.issue !== 'ok') {
      // 无效产出（空 / 中断 / 兜底话术）不落盘——与 P4.5 闸门同语义。
      lines.push('（该任务产出无效 / 为空，未归档。）');
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
    if (!body.trim()) {
      lines.push('（该任务已完成，但未产出可归档的内容。）');
      continue;
    }
    if (body.length > PLAN_ARTIFACT_MAX_BYTES) {
      body =
        body.slice(0, PLAN_ARTIFACT_MAX_BYTES) +
        '\n\n（单个任务产出过大已截断，完整内容见该任务执行详情）\n';
    }
    lines.push(body);
  }
  lines.push('');

  const content: Buffer = Buffer.from(lines.join('\n'), 'utf-8');
  try {
    const meta = await getArtifactStore().save({
      name: `计划交付文档-${sanitizeArtifactName(def.id, '执行结果')}.md`,
      kind: PLAN_ARTIFACT_KIND,
      mimeType: PLAN_ARTIFACT_MIME,
      content,
      owner,
      runId: def.id,
      note: PLAN_FINAL_ARTIFACT_NOTE
    });
    result.archived.push(meta);
  } catch (e) {
    console.warn(
      `[plan-artifacts] 合并归档失败（不阻断执行）：${e instanceof Error ? e.message : String(e)}`
    );
  }
  return result;
}

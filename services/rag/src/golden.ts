/**
 * golden.ts — 检索质量回归套件（P6 方案三二期，对齐 evals 生态的最小可用形态）。
 *
 * 设计要点：
 * - 数据集 = 版本化 JSON 文件（`{ version, description?, cases }`），随仓库演进可 diff。
 * - 批跑：逐 case 检索（可经 mode/llm 启用 multi-query / HyDE）→ 断言
 *   `expect_contains`（结果正文须包含的关键词，全部命中才算通过）。
 * - 报告：`GoldenReport`（通过率 / 失败明细 / 平均延迟），可序列化落盘；
 *   `diffGoldenReports(base, target)` 输出 markdown 逐项对比（新增失败 / 修复用例 /
 *   通过率变化），供 CI 门禁与版本间回归对比。
 * - 判定语义刻意保守：只要有一处关键词缺失即 fail —— golden 的意义是「不许变坏」，
 *   宁可误报让人工确认，不做模糊通过。
 */

import { readFileSync } from 'node:fs';
import { retrieve, type RetrieveRequest } from './retrieve';
import { multiQueryRetrieve, hydeRetrieve } from './advanced-retrieval';
import type { VectorStore } from './store';
import type { EmbeddingProvider } from './embed';
import type { LLMProvider } from './generate';

export interface GoldenCase {
  /** 查询文本。 */
  q: string;
  /** 结果正文必须包含的关键词（全部命中才通过）。 */
  expect_contains: string[];
  /** 租户（缺省用 opts.tenantId ?? 'default'）。 */
  tenant_id?: string;
}

export interface GoldenDataset {
  /** 数据集版本号（语义化或日期，报告引用）。 */
  version: string;
  description?: string;
  cases: GoldenCase[];
}

export interface GoldenReport {
  version: string;
  ts: number;
  total: number;
  passed: number;
  passRate: number;
  latencyAvgMs: number;
  mode: string;
  failed: Array<{ q: string; reason: string }>;
}

/** 加载并校验数据集文件（结构非法明确报错，不静默吞）。 */
export function loadGoldenDataset(file: string): GoldenDataset {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<GoldenDataset>;
  if (!raw || typeof raw !== 'object') throw new Error(`[rag-golden] 数据集非对象：${file}`);
  if (typeof raw.version !== 'string' || !raw.version.trim()) {
    throw new Error(`[rag-golden] 数据集缺 version：${file}`);
  }
  if (!Array.isArray(raw.cases) || raw.cases.length === 0) {
    throw new Error(`[rag-golden] 数据集 cases 为空：${file}`);
  }
  for (const c of raw.cases) {
    if (!c || typeof c.q !== 'string' || !c.q.trim() || !Array.isArray(c.expect_contains)) {
      throw new Error(`[rag-golden] 数据集 case 结构非法（需 q + expect_contains[]）：${file}`);
    }
  }
  return { version: raw.version, description: raw.description, cases: raw.cases };
}

export interface GoldenSuiteOptions {
  /** 提供时启用高级检索（mode: 'multi-query' | 'hyde'）。 */
  llm?: LLMProvider;
  mode?: 'chunk' | 'multi-query' | 'hyde';
  topK?: number;
  /** 缺省租户（case 未显式指定 tenant_id 时使用）。 */
  tenantId?: string;
}

/** 批跑 golden 数据集：逐 case 检索 + 关键词全命中断言。 */
export async function runGoldenSuite(
  store: VectorStore,
  provider: EmbeddingProvider,
  dataset: GoldenDataset,
  opts: GoldenSuiteOptions = {}
): Promise<GoldenReport> {
  const mode = opts.mode ?? 'chunk';
  const tenantDefault = opts.tenantId ?? 'default';
  const topK = opts.topK ?? 5;
  const t0 = Date.now();
  const failed: GoldenReport['failed'] = [];
  let latencySum = 0;
  for (const c of dataset.cases) {
    const req: RetrieveRequest = {
      query: c.q,
      tenant_id: c.tenant_id ?? tenantDefault,
      top_k: topK,
    };
    const caseT0 = Date.now();
    let joined = '';
    try {
      const resp =
        mode === 'multi-query' && opts.llm
          ? await multiQueryRetrieve(store, provider, opts.llm, req)
          : mode === 'hyde' && opts.llm
            ? await hydeRetrieve(store, provider, opts.llm, req)
            : await retrieve(store, provider, req);
      joined = resp.results.map((r) => r.content).join('\n');
    } catch (e) {
      failed.push({
        q: c.q,
        reason: `检索异常：${e instanceof Error ? e.message : String(e)}`,
      });
      latencySum += Date.now() - caseT0;
      continue;
    }
    latencySum += Date.now() - caseT0;
    const missing = c.expect_contains.filter((k) => !joined.includes(k));
    if (missing.length > 0) {
      failed.push({
        q: c.q,
        reason: `结果正文缺失关键词：${missing.join('、')}`,
      });
    } else if (!joined.trim()) {
      failed.push({ q: c.q, reason: '检索结果为空' });
    }
  }
  const total = dataset.cases.length;
  const passed = total - failed.length;
  return {
    version: dataset.version,
    ts: Date.now(),
    total,
    passed,
    passRate: total > 0 ? passed / total : 0,
    latencyAvgMs: total > 0 ? Math.round(latencySum / total) : 0,
    mode,
    failed,
  };
}

/** 两份报告的 markdown 逐项对比（CI 门禁 / 版本间回归对比用）。 */
export function diffGoldenReports(base: GoldenReport, target: GoldenReport): string {
  const lines: string[] = [];
  lines.push(`## Golden 回归对比：${base.version} → ${target.version}`);
  lines.push('');
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  lines.push(
    `- 通过率：${pct(base.passRate)}（${base.passed}/${base.total}） → ${pct(target.passRate)}（${target.passed}/${target.total}）` +
      `${target.passRate >= base.passRate ? ' ✅' : ' ⚠️ 回归'}`
  );
  lines.push(`- 平均延迟：${base.latencyAvgMs}ms → ${target.latencyAvgMs}ms`);
  lines.push(`- 检索模式：${base.mode} → ${target.mode}`);
  const baseFailed = new Set(base.failed.map((f) => f.q));
  const targetFailed = new Map(target.failed.map((f) => [f.q, f.reason]));
  const newlyFailed = target.failed.filter((f) => !baseFailed.has(f.q));
  const fixed = base.failed.filter((f) => !targetFailed.has(f.q));
  if (newlyFailed.length > 0) {
    lines.push('');
    lines.push('### ⚠️ 新增失败');
    for (const f of newlyFailed) lines.push(`- ${f.q}：${f.reason}`);
  }
  if (fixed.length > 0) {
    lines.push('');
    lines.push('### ✅ 已修复');
    for (const f of fixed) lines.push(`- ${f.q}`);
  }
  const stillFailing = target.failed.filter((f) => baseFailed.has(f.q));
  if (stillFailing.length > 0) {
    lines.push('');
    lines.push('### 持续失败（基线既有，非本次回归）');
    for (const f of stillFailing) lines.push(`- ${f.q}：${f.reason}`);
  }
  return lines.join('\n');
}

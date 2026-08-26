/**
 * chat.ts 拆分 · 调用链追踪树渲染与「关键信息」提炼（纯函数，无组件状态）。
 * 从 chat.ts 原样迁出：countTraceNodes / renderTraceNode / buildInsights /
 * parseCostBreakdown / renderInsights 及 Insights 类型。
 */
import { html, nothing, type TemplateResult } from 'lit';
import type { TraceNode } from '@agent-harness/client';
import { escapeHtml } from './markdown';
import { renderJsonHtml } from './utils/json-view';

/** 从调用链路提炼出的「关键信息」结构化摘要，用于深度思考区的复盘视图。 */
export interface Insights {
  model?: string;
  agent?: string;
  mode?: string;
  steps: number;
  toolCount: number;
  costTokens?: string;
  costValue?: string;
  /** 'true'=命中定价表（cost 为 0 表示模型免费），'false'=未命中（按默认价 0 估算）。 */
  costPriced?: string;
  cacheHitRate?: string;
  cacheHits?: string;
  /** Token 拆解（系统 / 工具 / 历史 / 输出）占比，用于「关键信息」区可视化固定开销来源。 */
  costBreakdown?: Array<{ label: string; tokens: number; pct: number }>;
  retrievals: Array<{ label: string; result: string }>;
}

export function countTraceNodes(trace: TraceNode[]): number {
  let n = 0;
  const walk = (ns: TraceNode[]) =>
    ns.forEach((x) => {
      n++;
      walk(x.children);
    });
  walk(trace);
  return n;
}

/** 递归渲染单个追踪节点（details 天然形成树状层级，可逐层展开）。 */
export function renderTraceNode(n: TraceNode): TemplateResult {
  const hasDetail = !!n.detail && n.detail.trim().length > 0;
  const hasResult = n.result != null && n.result.trim().length > 0;
  const isRetrieval = n.kind === 'retrieval';
  // run/step/llm 默认展开，叶子节点（工具/检索/成本）默认收起。
  const defaultOpen = n.kind === 'run' || n.kind === 'step' || n.kind === 'llm';
  return html`
    <details
      class="tnode kind-${n.kind} status-${n.status}"
      ?open=${defaultOpen}
    >
      <summary class="tnode-head">
        <span class="tdot"></span>
        <span class="tlabel">${escapeHtml(n.label)}</span>
        ${n.status === 'error'
          ? html`<span class="tbadge err">失败</span>`
          : nothing}
        ${n.status === 'pending'
          ? html`<span class="tbadge pend">进行中</span>`
          : nothing}
        ${n.meta
          ? html`<span class="tchips"
              >${Object.entries(n.meta).map(
                ([k, v]) =>
                  html`<span class="tchip"
                    ><b>${escapeHtml(k)}</b> ${escapeHtml(v)}</span
                  >`
              )}</span
            >`
          : nothing}
      </summary>
      ${hasDetail
        ? html`<pre class="tdetail">${renderJsonHtml(n.detail!)}</pre>`
        : nothing}
      ${hasResult
        ? isRetrieval
          ? html`<details
              class="tresult retrieval tres-fold"
              ?open=${n.result!.length <= 240}
            >
              <summary title="点击展开 / 收起">
                <span class="tres-title">检索内容</span>
                <span class="tres-meta">${n.result!.length} 字</span>
              </summary>
              <div class="tres-body">${renderJsonHtml(n.result!)}</div>
            </details>`
          : html`<div class="tresult">${renderJsonHtml(n.result!)}</div>`
        : nothing}
      ${n.children.length
        ? html`<div class="tchildren">
            ${n.children.map((c) => renderTraceNode(c))}
          </div>`
        : nothing}
    </details>
  `;
}

/** 遍历追踪树，提炼「关键信息」结构化摘要。 */
export function buildInsights(trace: TraceNode[]): Insights {
  const root = trace[0];
  const flat: TraceNode[] = [];
  const walk = (ns: TraceNode[]): void => {
    ns.forEach((x) => {
      flat.push(x);
      walk(x.children);
    });
  };
  walk(root.children);
  const steps = flat.filter((n) => n.kind === 'step').length;
  // 「工具调用」计数只统计真实执行的工具节点；被去重复用（meta.reused）的请求不计入，
  // 以免 UI 数字虚高（但 trace 树里仍保留这些复用节点供复盘）。
  const tools = flat.filter(
    (n) => n.kind === 'tool' && !(n.meta && n.meta.reused)
  );
  const retrievals = flat.filter((n) => n.kind === 'retrieval');
  const cost = flat.find((n) => n.kind === 'cost');
  const cacheNode = flat.find((n) => n.kind === 'tokencache');
  const meta = root.meta ?? {};
  return {
    model: meta.model,
    agent: meta.agent,
    mode: meta.mode,
    steps,
    toolCount: tools.length + retrievals.length,
    costTokens: cost?.meta?.tokens,
    costValue: cost?.meta?.cost,
    costPriced: cost?.meta?.priced,
    cacheHitRate: cacheNode?.meta?.命中率,
    cacheHits: cacheNode?.meta?.命中,
    costBreakdown: parseCostBreakdown(cost?.meta),
    retrievals: retrievals.map((n) => ({
      label: n.label,
      result: n.result ?? ''
    }))
  };
}

/**
 * 从 cost 节点的 meta 解析「系统 / 工具 / 历史 / 输出」四项 token 占比。
 * meta 中 工具/历史 的值形如 "320 (45%)"，系统/输出 为纯数字；这里统一提取数字与百分比。
 * 容错：值可能为 number 或 string；百分比缺失时按各项 tokens 占和兜底计算；
 * 全部不可解析时返回 undefined（调用方据此展示降级文案而非静默消失）。
 */
export function parseCostBreakdown(
  meta?: Record<string, unknown>
): Insights['costBreakdown'] {
  if (!meta) return undefined;
  const order: Array<[string, string]> = [
    ['系统', 'system'],
    ['工具', 'tools'],
    ['历史', 'history'],
    ['输出', 'completion']
  ];
  const out: Array<{ label: string; tokens: number; pct: number }> = [];
  for (const [cn] of order) {
    const raw = meta[cn];
    if (raw == null) continue;
    // parseInt 对 "320 (45%)" 取前缀数字，与纯数字字符串/数值统一兼容。
    const num = parseInt(String(raw), 10);
    if (!Number.isFinite(num)) continue;
    const pctMatch = String(raw).match(/\((\d+(?:\.\d+)?)%\)/);
    out.push({
      label: cn,
      tokens: num,
      pct: pctMatch ? Number(pctMatch[1]) : 0
    });
  }
  if (!out.length) return undefined;
  // 百分比缺失的项按「该项 tokens ÷ 已解析各项之和」兜底，保证进度条始终有意义。
  const sum = out.reduce((s, b) => s + b.tokens, 0);
  for (const b of out) {
    if (!b.pct && sum > 0) b.pct = Math.round((b.tokens / sum) * 100);
  }
  return out;
}

/** 渲染「关键信息」结构化洞察区（模型/步骤/工具/用量/检索内容）。 */
export function renderInsights(ins: Insights) {
  const stats: Array<[string, string]> = [];
  const push = (k: string, v: string | undefined) => {
    if (v != null) stats.push([k, v]);
  };
  push('模型', ins.model);
  push('Agent', ins.agent);
  push('模式', ins.mode);
  push('步骤', ins.steps ? String(ins.steps) : undefined);
  push('工具调用', ins.toolCount ? String(ins.toolCount) : undefined);
  push('Token', ins.costTokens);
  push('缓存命中率', ins.cacheHitRate);
  // cost=0 时区分「已定价的免费模型」与「未定价模型」，避免 UI 上 $0.0000 看起来像 bug。
  const costRaw = ins.costValue ?? '';
  const priced = ins.costPriced === 'true';
  const isZero =
    costRaw === '$0.0000' || costRaw === '$0.00' || costRaw === '$0';
  push(
    '成本',
    costRaw ? (isZero ? (priced ? '免费' : '未定价') : costRaw) : undefined
  );
  return html`
    <div class="insights-title">关键信息</div>
    <div class="ins-grid">
      ${stats.map(
        ([k, v]) => html`<div class="ins-item">
          <span class="ins-k">${escapeHtml(k)}</span
          ><span class="ins-v">${escapeHtml(v)}</span>
        </div>`
      )}
    </div>
    ${ins.costBreakdown
      ? html`<div class="ins-breakdown">
          <div class="ins-bd-title">Token 拆解</div>
          <div class="ins-bd-bars">
            ${ins.costBreakdown.map(
              (b) => html`<div class="ins-bd-row">
                <div class="ins-bd-head">
                  <span class="ins-bd-name">${escapeHtml(b.label)}</span>
                  <span class="ins-bd-val"
                    >${escapeHtml(String(b.tokens))} tok ·
                    ${escapeHtml(String(b.pct))}%</span
                  >
                </div>
                <div class="ins-bd-track">
                  <div
                    class="ins-bd-fill"
                    style=${`width:${Math.max(2, b.pct)}%`}
                  ></div>
                </div>
              </div>`
            )}
          </div>
        </div>`
      : // 稳定降级：已有 Token 总量但分项缺失（旧落盘 trace / 事件未带 estTokens）时，
      // 展示占位说明而非静默消失，避免模块「时有时无」的观感；完全无用量数据（如 mock）
      // 才整体隐藏。
      ins.costTokens
      ? html`<div class="ins-breakdown">
          <div class="ins-bd-title">Token 拆解</div>
          <div class="ins-bd-bars">
            <div class="ins-bd-empty">
              暂无分项数据（本次运行未返回拆解明细）
            </div>
          </div>
        </div>`
      : nothing}
    ${ins.retrievals.length
      ? html`<div class="ins-retrieval">
          <div class="ins-ret-title">检索内容</div>
          ${ins.retrievals.map(
            (r) => html`<details
              class="ins-ret-card ins-ret-fold"
              ?open=${r.result.length <= 240}
            >
              <summary title="点击展开 / 收起">
                <span class="ins-ret-name">${escapeHtml(r.label)}</span>
                <span class="ins-ret-meta">${r.result.length} 字</span>
              </summary>
              <pre class="ins-ret-body">${renderJsonHtml(r.result)}</pre>
            </details>`
          )}
        </div>`
      : nothing}
  `;
}

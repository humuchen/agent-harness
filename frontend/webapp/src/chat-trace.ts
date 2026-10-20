/**
 * chat.ts 拆分 · 调用链追踪树渲染与「关键信息」提炼（纯函数，无组件状态）。
 * 从 chat.ts 原样迁出：countTraceNodes / buildInsights /
 * parseCostBreakdown / collapseEntireTrace / buildConfidence 及相关类型。
 *
 * Lit → Svelte 5 迁移：renderConfidence / renderTraceNode / renderInsights
 * 三个模板函数已拆到 `chat-trace.svelte`（markup 级 {#snippet} 导出），
 * 本文件只保留纯函数与类型（chat-trace.test.ts 依赖）。
 */
import type { TraceNode, TraceKind } from '@agent-harness/client';

/** 从调用链路提炼出的「关键信息」结构化摘要，用于深度思考区的复盘视图。 */
export interface Insights {
  model?: string;
  agent?: string;
  mode?: string;
  steps: number;
  toolCount: number;
  /**
   * 整轮累计 token（provider 实测）：取所有 cost 节点的累计峰值，即最后一步的 cumulativeTokens。
   * 注意不是「某一步」的用量，也不包含 Jev 旁路调用（jev:call 单独统计）。
   */
  costTokens?: string;
  /** 整轮累计成本（provider 单价表估算，累计峰值）。 */
  costValue?: string;

  /** 'true'=命中定价表（cost 为 0 表示模型免费），'false'=未命中（按默认价 0 估算）。 */
  costPriced?: string;
  cacheHitRate?: string;
  cacheHits?: string;

  /**
   * TypeSafe Jev 决策模型直连调用摘要（'N' 或 'N · M tok'）。
   * 来源为 jev:call 旁路事件（注入门禁/上下文压缩等子系统路径）；工具路径（builtin__jev_decide）
   * 已计入工具调用数，不在此重复统计。
   */
  jevCalls?: string;

  /**
   * Token 拆解（系统 / 工具 / 历史 / 输出）占比，用于「关键信息」区可视化 token 大头来源。
   * 口径：各步估算**跨步求和**（与整轮 Token 同为整轮视角），百分比分母是四项之和。
   */
  costBreakdown?: Array<{ label: string; tokens: number; pct: number }>;
  retrievals: Array<{ label: string; result: string }>;
}

/** 每条助手消息内容区的 Tab 键。 */
export type MsgTab = 'answer' | 'thinking' | 'trace' | 'confidence';

/**
 * 「链路信心」Tab 的渲染数据源：
 * - 后端启用自检（AGENT_AUTO_VERIFY）时，优先采用 verify 节点的 score / 通过结论；
 * - 未启用自检时，回退到由调用链合成的信心（工具成功率、错误节点、缓存命中率）。
 */
export interface Confidence {
  hasVerify: boolean;
  verifyScore?: string;
  verifyPassed?: boolean;
  verifyReasons?: string;
  toolTotal: number;
  toolErrors: number;
  errorNodes: number;
  cacheHitRate?: string;
  /** 0–100 综合信心分。 */
  score: number;
  level: 'high' | 'mid' | 'low';
  levelLabel: string;
}

/** 从调用链路提炼「链路信心」：verify 自检分优先，否则基于 trace 信号合成。 */
export function buildConfidence(trace: TraceNode[]): Confidence {
  const flat: TraceNode[] = [];
  const walk = (ns: TraceNode[]) =>
    ns.forEach((x) => {
      flat.push(x);
      walk(x.children);
    });
  walk(trace);
  const verify = flat.find((n) => n.kind === 'verify');
  // Jev 决策节点（meta.jev）不是常规工具：其失败会兜底回落基线，不计入工具成功率。
  const tools = flat.filter(
    (n) => n.kind === 'tool' && n.meta?.jev !== 'true'
  );
  const toolErrors = tools.filter((n) => n.status === 'error').length;
  const errorNodes = flat.filter(
    (n) => n.status === 'error' || n.kind === 'error'
  ).length;
  const ins = buildInsights(trace);
  const hasVerify = !!verify;
  let score: number;
  let level: Confidence['level'];
  if (verify) {
    const raw = Number(String(verify.meta?.score ?? '').replace(/[^\d.]/g, ''));
    score =
      Number.isFinite(raw) && raw > 0 ? Math.min(100, Math.round(raw)) : 0;
  } else {
    // 合成：工具成功率为主，错误节点扣分，缓存命中率加分。
    const toolTotal = tools.length;
    const successRate =
      toolTotal > 0 ? (toolTotal - toolErrors) / toolTotal : 1;
    const errPenalty = Math.min(40, errorNodes * 12);
    let cacheBonus = 0;
    if (ins.cacheHitRate) {
      const cpct = Number(String(ins.cacheHitRate).replace(/[^\d.]/g, ''));
      if (Number.isFinite(cpct)) cacheBonus = Math.min(10, cpct / 5);
    }
    score = Math.max(
      0,
      Math.min(
        100,
        Math.round(100 * (0.55 + 0.45 * successRate) - errPenalty + cacheBonus)
      )
    );
  }
  level = score >= 80 ? 'high' : score >= 60 ? 'mid' : 'low';
  const levelLabel = level === 'high' ? '高' : level === 'mid' ? '中' : '低';
  return {
    hasVerify,
    verifyScore: verify ? String(verify.meta?.score ?? '?') : undefined,
    verifyPassed: verify ? String(verify.meta?.passed) !== '未通过' : undefined,
    verifyReasons: verify?.result || undefined,
    toolTotal: tools.length,
    toolErrors,
    errorNodes,
    cacheHitRate: ins.cacheHitRate,
    score,
    level,
    levelLabel
  };
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

/** 可被「折叠全部」按钮统一收敛的节点种类白名单。
 *  排除 run/step/llm —— run 是入口容器，step/llm 由用户点击头部切换，不由助手操作。 */
const FOLDABLE_KINDS: ReadonlyArray<TraceKind> = [
  'tool',
  'retrieval',
  'cost',
  'tokencache',
  'verify',
  'guardrail',
  'budget',
  'error'
];

/** 折叠整条调用链路：消息上下文、LLM 容器体、以及所有「可折叠」子节点全部收起。
 *  供「折叠全部」按钮（抽屉级）调用，使整个 trace 树回到最紧凑的默认折叠态，
 *  与工具/检索/成本/自检等子节点初次进入调用链路时的展示一致。 */
export function collapseEntireTrace(trace: TraceNode[]): void {
  const walk = (ns: TraceNode[]): void => {
    for (const n of ns) {
      if (n.messages) n.messages.forEach((m) => (m.expanded = false));
      // LLM 容器体（含消息上下文与工具调用列表）也一并收起。
      if (n.kind === 'llm') n.expanded = false;
      if (FOLDABLE_KINDS.includes(n.kind)) n.expanded = false;
      if (n.children.length) walk(n.children);
    }
  };
  walk(trace);
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
  walk(root?.children ?? []);
  const steps = flat.filter((n) => n.kind === 'step').length;
  // jev 节点（meta.jev==='true'）是 Jev 决策模型的子系统直连调用，不是常规工具：
  // 不计入「工具调用」（避免虚高），也不参与链路信成的工具成功率（门禁失败会兜底回落，
  // 不代表回答质量下降）；单独聚合成「Jev 调用」指标展示。
  const isJevNode = (n: TraceNode): boolean => n.meta?.jev === 'true';
  // 「工具调用」计数只统计真实执行的工具节点；被去重复用（meta.reused）的请求不计入，
  // 以免 UI 数字虚高（但 trace 树里仍保留这些复用节点供复盘）。
  const tools = flat.filter(
    (n) => n.kind === 'tool' && !(n.meta && n.meta.reused) && !isJevNode(n)
  );
  const retrievals = flat.filter((n) => n.kind === 'retrieval');
  // 成本 / 用量节点：harness 每步发一条 run:cost，节点里的 tokens / cost 是**该步结束时的累计值**
  // （cost.cumulativeTokens / cumulativeCost），因此整轮口径必须取「累计峰值」而不是第一个节点 ——
  // 此前用 find() 取 DFS 首节点，实际显示的是第 1 步的累计（5 步运行只显示第 1 步用量，明显偏小）。
  const costNodes = flat.filter((n) => n.kind === 'cost');
  // 缓存节点同理取最后一个：其 meta 来自进程级累计快照（getTokenCacheStats），越靠后的节点样本越完整。
  const cacheNode = flat.filter((n) => n.kind === 'tokencache').pop();
  const meta = root?.meta ?? {};
  // Jev 直连调用聚合：次数 + tokens（meta.tokens 形如 "120+30"，input+output）。
  const jevNodes = flat.filter(isJevNode);
  let jevTokensTotal = 0;
  for (const jn of jevNodes) {
    const m = /^(\d+)\+(\d+)$/.exec(String(jn.meta?.tokens ?? ''));
    if (m) jevTokensTotal += Number(m[1]) + Number(m[2]);
  }
  const jevCalls = jevNodes.length
    ? jevTokensTotal > 0
      ? `${jevNodes.length} · ${jevTokensTotal} tok`
      : String(jevNodes.length)
    : undefined;
  return {
    model: meta.model,
    agent: meta.agent,
    mode: meta.mode,
    steps,
    toolCount: tools.length + retrievals.length,
    costTokens: peakMetaValue(costNodes, 'tokens'),
    costValue: peakMetaValue(costNodes, 'cost'),
    costPriced: lastMetaValue(costNodes, 'priced'),
    cacheHitRate: cacheNode?.meta?.命中率,
    cacheHits: cacheNode?.meta?.命中,
    jevCalls,
    costBreakdown: aggregateCostBreakdown(costNodes),
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

/** 四项固定展示顺序（与 parseCostBreakdown 一致，聚合时保证不跳位）。 */
const BREAKDOWN_ORDER = ['系统', '工具', '历史', '输出'] as const;

/**
 * 聚合整轮「系统 / 工具 / 历史 / 输出」四项估算（跨步求和）。
 *
 * 为什么需要聚合：每个 cost 节点的四项只是**该步**发出的 payload 估算，而面板上的 Token 是整轮累计；
 * 直接沿用某一步的分项会让「总量是整轮、拆解是单步」两个基准打架。这里把各步四项分别相加，
 * 百分比分母为四项之和（不是面板 Token —— 后者来自 provider 实测，两者本就不同基准）。
 * 全部节点都没有分项数据（旧落盘 trace / 未带 estTokens）时返回 undefined，由调用方展示降级文案。
 */
function aggregateCostBreakdown(
  nodes: TraceNode[]
): Insights['costBreakdown'] {
  const sums = new Map<string, number>();
  for (const n of nodes) {
    const bd = parseCostBreakdown(n.meta);
    if (!bd) continue;
    for (const b of bd) sums.set(b.label, (sums.get(b.label) ?? 0) + b.tokens);
  }
  if (!sums.size) return undefined;
  // 固定项按既有顺序在前，采集端新增的未知项追加在后（UI 不空白、不跳位）。
  const labels = [
    ...BREAKDOWN_ORDER.filter((l) => sums.has(l)),
    ...[...sums.keys()].filter(
      (l) => !(BREAKDOWN_ORDER as readonly string[]).includes(l)
    )
  ];
  const total = [...sums.values()].reduce((s, v) => s + v, 0);
  return labels.map((label) => {
    const tokens = sums.get(label) ?? 0;
    return {
      label,
      tokens,
      pct: total > 0 ? Math.round((tokens / total) * 100) : 0
    };
  });
}

/**
 * 从一组 cost 节点里取某个「累计型」数值 meta 的峰值（tokens / cost）。
 * run:cost 的两个数值都是累计量且单调不减，故最大值即整轮合计；对乱序、缺字段、'?' 均安全。
 * 全部不可解析时返回 undefined（UI 隐藏该格，而不是显示 NaN）。
 */
function peakMetaValue(nodes: TraceNode[], key: string): string | undefined {
  let best = Number.NEGATIVE_INFINITY;
  let bestRaw: string | undefined;
  for (const n of nodes) {
    const raw = n.meta?.[key];
    if (raw == null) continue;
    const num = Number.parseFloat(String(raw).replace(/[^\d.]/g, ''));
    if (!Number.isFinite(num)) continue;
    if (num >= best) {
      best = num;
      bestRaw = String(raw);
    }
  }
  return bestRaw;
}

/** 取最后一个携带该 meta 键的节点的值（非数值语义，如 priced 标志）。 */
function lastMetaValue(nodes: TraceNode[], key: string): string | undefined {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const raw = nodes[i]?.meta?.[key];
    if (raw != null) return String(raw);
  }
  return undefined;
}

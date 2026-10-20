/**
 * chat-context-usage：上下文用量（Context Usage）相关的纯逻辑。
 *
 * 从 AhChat 单体内抽离，便于独立测试与维护，不依赖组件 this.* 状态。
 * Svelte 迁移说明：圆环渲染部分（原 renderCtxRing 返回 lit TemplateResult）
 * 已拆到 chat-context-usage.svelte（CtxRing 组件，含 onToggle/onClose 事件绑定）；
 * 本文件只保留纯函数与类型。
 */
import type { ChatMsg } from './chat-types';

/** 单个用量维度项。 */
export interface CtxItem {
  key: string;
  label: string;
  tokens: number;
  pct: number;
  cls: string;
}

/** 上下文用量聚合结果（前端粗估 / 后端精确计数统一成此结构）。 */
export interface CtxUsage {
  totalPct: number;
  totalTokens: number;
  window: number;
  /** 自上次用量上报以来是否发生过上下文压缩（历史淘汰）。 */
  compressed: boolean;
  items: CtxItem[];
}

/** 后端精确用量（仅取选择逻辑所需字段，结构兼容 AhChat.backendUsage）。 */
export interface BackendUsageLike {
  window: number;
  promptTokens: number;
  /** 自上次用量上报以来是否发生过上下文压缩（历史淘汰）。 */
  compressed?: boolean;
  breakdown: {
    system: number;
    tools: number;
    messages: number;
    mcp: number;
    skills: number;
    cached?: number;
  };
}

/** 本运行累计 token 消耗（来自 run:cost 事件的 cumulativeTokens）。 */
export interface RunCumulative {
  tokens: number;
  cost: number;
}

const SYS_BASE = 1400; // 系统提示词 + Agent 卡片基线
const MCP_BASE = 60; // 连接器及 MCP 注册信息基线
const SKILL_BASE = 80; // 技能基线

/** token 数缩写 + 近似标记：78700 → "~78.7K"（hover 提示 / 弹层用）。 */
export function fmtK(n: number): string {
  return `~${(n / 1000).toFixed(1)}K`;
}

/**
 * 前端基于消息缓冲的粗估上下文占用：数据来自当前消息缓冲
 * （对话内容 / 推理 / 工具调用 / 附件），系统提示词与 MCP / 技能为基线粗估。
 * 注意：这是前端基于字符数的粗估（≈ 字符/3），仅用于趋势提示，并非后端精确 token 计数。
 * 分母仅使用已知真实窗口（服务端下发或模型目录官方 context_length）；
 * 拿不到窗口数据（serverCtxWindow<=0）时返回全 0，由调用方隐藏整个圆环。
 */
export function estimateContextUsage(opts: {
  serverCtxWindow: number;
  messages: ChatMsg[];
}): CtxUsage {
  if (opts.serverCtxWindow <= 0) {
    return {
      totalPct: 0,
      totalTokens: 0,
      window: 0,
      compressed: false,
      items: []
    };
  }
  const WINDOW = opts.serverCtxWindow;
  const tok = (s?: string) => (s ? Math.ceil([...s].length / 3) : 0);
  let msgTokens = 0;
  let toolTokens = 0;
  for (const m of opts.messages) {
    msgTokens += tok(m.content) + tok(m.reasoning);
    for (const a of m.attachments ?? []) msgTokens += 1200; // 每图约 1.2K token
    for (const t of m.tools ?? []) toolTokens += tok(t.args) + tok(t.result);
  }
  const items: CtxItem[] = [
    {
      key: 'sys',
      label: 'System Prompt',
      tokens: SYS_BASE,
      cls: 'c-sys',
      pct: 0
    },
    {
      key: 'tools',
      label: 'Tools',
      tokens: toolTokens,
      cls: 'c-tools',
      pct: 0
    },
    {
      key: 'msg',
      label: 'Conversation',
      tokens: msgTokens,
      cls: 'c-msg',
      pct: 0
    },
    { key: 'mcp', label: 'MCP', tokens: MCP_BASE, cls: 'c-mcp', pct: 0 },
    {
      key: 'skill',
      label: 'Skills',
      tokens: SKILL_BASE,
      cls: 'c-skill',
      pct: 0
    }
  ];
  const totalTokens = items.reduce((s, it) => s + it.tokens, 0);
  const totalPct = Math.min(100, (totalTokens / WINDOW) * 100);
  for (const it of items) it.pct = (it.tokens / WINDOW) * 100;
  return { totalPct, totalTokens, window: WINDOW, compressed: false, items };
}

/**
 * 选择上下文用量数据：优先用后端精确计数（llm:usage），
 * 未拿到后端数据（如 mock 模式、首屏）时回退到前端基于消息缓冲的粗估
 * （estimateContextUsage）。两种来源统一成相同结构，渲染层无需关心数据出处。
 * 窗口占用口径：totalTokens 取 promptTokens（仅输入，不含模型当轮输出 completion），
 * 因为下一轮上下文只由输入构成。
 */
export function selectContextUsage(opts: {
  backendUsage: BackendUsageLike | null;
  serverCtxWindow: number;
  messages: ChatMsg[];
}): CtxUsage {
  const u = opts.backendUsage;
  if (u) {
    const items: CtxItem[] = [
      {
        key: 'sys',
        label: 'System Prompt',
        tokens: u.breakdown.system,
        cls: 'c-sys',
        pct: 0
      },
      {
        key: 'tools',
        label: 'Tools',
        tokens: u.breakdown.tools,
        cls: 'c-tools',
        pct: 0
      },
      {
        key: 'msg',
        label: 'Conversation',
        tokens: u.breakdown.messages,
        cls: 'c-msg',
        pct: 0
      },
      {
        key: 'mcp',
        label: 'MCP',
        tokens: u.breakdown.mcp,
        cls: 'c-mcp',
        pct: 0
      },
      {
        key: 'skill',
        label: 'Skills',
        tokens: u.breakdown.skills,
        cls: 'c-skill',
        pct: 0
      }
    ];
    // 窗口占用只算输入（promptTokens），不含当轮输出 completion。
    const totalTokens = u.promptTokens;
    const totalPct = Math.min(100, (totalTokens / u.window) * 100);
    for (const it of items) it.pct = (it.tokens / u.window) * 100;
    return {
      totalPct,
      totalTokens,
      window: u.window,
      compressed: !!u.compressed,
      items
    };
  }
  // 后端精确计数暂未到位（mock 模式 / 首屏尚未触发 LLM）时，回退到前端粗估。
  return estimateContextUsage({
    serverCtxWindow: opts.serverCtxWindow,
    messages: opts.messages
  });
}

import { Message, messageText } from './types';
import { tokenize } from './tools';
import { estimateTokens } from './llm/token-estimator';
import {
  MemoryStore,
  PersistedMemory,
  VolatileMemoryStore,
  sanitizeKey,
} from './memory-store';

/**
 * 持久化记忆的数据形态：对话滚动窗口 + 长期笔记。
 * 这是「存储后端」与「Memory 运行时」之间的契约，与具体后端无关。
 */

/**
 * 记忆打分器：对消息 / 笔记进行重要性评估（0~1），
 * 驱动滑动窗口的淘汰优先级与长期记忆的相关性排序。
 * 零依赖实现 —— 沿用 selectToolsForInput 的分词打分模式。
 */
export interface MemoryScorer {
  /**
   * 对窗口内的每条消息打分（0~1）。
   * @param messages 当前窗口全部消息
   * @param context 当前用户输入（用于相关性计算）
   * @returns 每条消息对应的分数
   */
  scoreWindow(messages: Message[], context: string): number[] | Promise<number[]>;

  /**
   * 对长期记忆笔记打分（0~1）。
   * @param notes 全部长期笔记
   * @param context 当前用户输入
   * @returns 每条笔记对应的分数
   */
  scoreNotes(notes: string[], context: string): number[] | Promise<number[]>;
}

/**
 * 多维重要性打分器（零依赖）。
 *
 * - **相关性（relevanceWeight）**：与 context 的词重叠度（中文二元组 / 英文词）。
 * - **重要性（importanceWeight）**：user 问 > assistant 回 > tool 结果。
 * - **时效性（recencyWeight）**：越靠近最后一条消息权重越高。
 * - **篇幅（lengthWeight）**：内容越长、信息量越大，重要性越高。
 *
 * 各维度权重通过 env 配置，可动态调整。
 */
export class HeuristicMemoryScorer implements MemoryScorer {
  readonly relevanceWeight: number;
  readonly importanceWeights: { user: number; assistant: number; tool: number; system: number };
  readonly recencyWeight: number;
  readonly lengthWeight: number;
  readonly maxNoteLength: number; // 长期记忆最大注入字符数

  constructor(opts: {
    relevanceWeight?: number;
    importanceWeights?: Partial<{ user: number; assistant: number; tool: number; system: number }>;
    recencyWeight?: number;
    lengthWeight?: number;
    maxNoteLength?: number;
  } = {}) {
    this.relevanceWeight = opts.relevanceWeight ?? 0.4;
    this.importanceWeights = {
      user: opts.importanceWeights?.user ?? 0.3,
      assistant: opts.importanceWeights?.assistant ?? 0.15,
      tool: opts.importanceWeights?.tool ?? 0.1,
      system: opts.importanceWeights?.system ?? 0.05,
    };
    this.recencyWeight = opts.recencyWeight ?? 0.1;
    this.lengthWeight = opts.lengthWeight ?? 0.05;
    this.maxNoteLength = opts.maxNoteLength ?? 200;
  }

  /**
   * 对窗口内消息打分。
   * 相关性（0.4） + 重要性角色加成（0.1~0.3） + 时效性（0.1） + 篇幅（0.05）。
   */
  scoreWindow(messages: Message[], context: string): number[] {
    const contextGrams = new Set(tokenize(context));
    const n = messages.length;
    return messages.map((m, i) => {
      let score = 0;
      const text = messageText(m);

      // 1. 相关性
      if (contextGrams.size > 0 && text) {
        const grams = new Set(tokenize(text));
        let overlap = 0;
        for (const g of contextGrams) {
          if (grams.has(g)) overlap++;
        }
        score += (overlap / contextGrams.size) * this.relevanceWeight;
      }

      // 2. 重要性（角色权重）
      const roleWeight = this.importanceWeights[m.role] ?? 0.1;
      score += roleWeight;

      // 3. 时效性（越靠后权重越高）
      if (n > 1) {
        score += (i / (n - 1)) * this.recencyWeight;
      }

      // 4. 篇幅（内容越长信息量越大）
      const lenFactor = Math.min(text.length / 500, 0.1) * (this.lengthWeight / 0.1);
      score += lenFactor;

      return Math.min(score, 1.0);
    });
  }

  /**
   * 对长期记忆笔记打分。
   * 相关性（0.4） + 篇幅（0.2） + 基础权重（0.2）。
   */
  scoreNotes(notes: string[], context: string): number[] {
    const contextGrams = new Set(tokenize(context));
    return notes.map((note) => {
      let score = 0;
      const grams = new Set(tokenize(note));
      let overlap = 0;
      for (const g of contextGrams) {
        if (grams.has(g)) overlap++;
      }
      const relevance = contextGrams.size > 0
        ? overlap / contextGrams.size
        : 0;
      score += relevance * 0.4;

      // 篇幅因子
      const lengthFactor = Math.min(note.length / this.maxNoteLength, 0.2);
      score += lengthFactor * 0.2;

      // 基础权重
      score += 0.2;

      return Math.min(score, 1.0);
    });
  }
}

/**
 * 工厂函数：根据环境变量创建 HeuristicMemoryScorer。
 * 支持通过 env 变量调整权重：
 *   MEMORY_SCORE_RELEVANCE（默认 0.4）
 *   MEMORY_SCORE_IMPORTANCE_USER（默认 0.3）
 *   MEMORY_SCORE_IMPORTANCE_ASSISTANT（默认 0.15）
 *   MEMORY_SCORE_IMPORTANCE_TOOL（默认 0.1）
 *   MEMORY_SCORE_IMPORTANCE_SYSTEM（默认 0.05）
 *   MEMORY_SCORE_RECENCY（默认 0.1）
 *   MEMORY_SCORE_LENGTH（默认 0.05）
 *   MEMORY_NOTES_TOPK（默认 10）
 */
export function createHeuristicScorer(): HeuristicMemoryScorer {
  return new HeuristicMemoryScorer({
    relevanceWeight: Number(process.env.MEMORY_SCORE_RELEVANCE ?? 0.4),
    importanceWeights: {
      user: Number(process.env.MEMORY_SCORE_IMPORTANCE_USER ?? 0.3),
      assistant: Number(process.env.MEMORY_SCORE_IMPORTANCE_ASSISTANT ?? 0.15),
      tool: Number(process.env.MEMORY_SCORE_IMPORTANCE_TOOL ?? 0.1),
      system: Number(process.env.MEMORY_SCORE_IMPORTANCE_SYSTEM ?? 0.05),
    },
    recencyWeight: Number(process.env.MEMORY_SCORE_RECENCY ?? 0.1),
    lengthWeight: Number(process.env.MEMORY_SCORE_LENGTH ?? 0.05),
    maxNoteLength: Number(process.env.MEMORY_NOTES_MAXLEN ?? 200),
  });
}

/**
 * 上下文压缩摘要器：当滑动窗口溢出、需要淘汰旧轮次时调用。
 * - `evicted`：本次被淘汰的轮次（user/assistant/tool 消息序列）。
 * - `previous`：上一次压缩得到的摘要（首次为 null），可用于增量合并。
 * 约定：返回**有界**字符串（建议 < 400 字符），否则压缩本身会变成新的 token 负担；
 * 返回空串表示放弃本次摘要。允许返回 `Promise<string>`（如调用 LLM 做摘要），
 * 此时 `Memory.add()` 不会阻塞，摘要会在下一轮 `flushSummary()`（harness 循环顶部）
 * 调用前落地，从而在不改动主循环同步结构的前提下支持异步摘要器。
 */
export type MemorySummarizer = (ctx: {
  previous: string | null;
  evicted: Message[];
}) => string | Promise<string>;

export interface MemoryOptions {
  // 发送给 LLM 的对话历史滚动窗口大小。
  maxWindow?: number;
  // 显式存储后端（P1-9）。
  store?: MemoryStore;
  // 租户/会话标识：记忆按 key 隔离。不传则归到 'anonymous'。
  sessionKey?: string;
  // 可选上下文压缩：滑动窗口溢出淘汰旧轮次时，将其压缩为一条
  // system 摘要固定保留，根治「每步重发全部历史」导致的 token 平方增长。
  // 未提供则沿用原有「直接丢弃」行为。必须同步、返回有界字符串。
  summarizer?: MemorySummarizer;
  /**
   * 可选记忆打分器：驱动滑动窗口溢出时的淘汰优先级与长期记忆的相关性排序。
   * 未提供则退化为 FIFO 淘汰（向后兼容）。
   */
  scorer?: MemoryScorer;
  /** 启用记忆打分时的相关性上下文（当前用户输入），用于打分计算。 */
  scoringContext?: string;
  /** 长期记忆注入系统提示词时的最大笔记数（按分数排序后裁剪）。默认 10。 */
  notesTopK?: number;
  /**
   * token 级压缩触发阈值（0~1）：最近一次 LLM 调用的 promptTokens / contextWindow
   * 越过该比例即触发历史淘汰。独立于 CONTEXT_COMPRESSION 特性开关，作为兜底护栏——
   * 即便未开启摘要，也会触发 FIFO 淘汰，避免上下文撑爆（原问题根因）。默认 0.8。
   */
  compressThreshold?: number;
}

/** 判断一条消息是否为「历史摘要」节点（role 为 system，且内容以标记前缀开头）。 */
export const isSummaryNode = (m: Message): boolean =>
  m.role === 'system' &&
  typeof m.content === 'string' &&
  m.content.startsWith('【历史摘要】');

/** 内容瘦身标记：被打过标记的消息不再二次瘦身（幂等）。 */
const SHRUNK_MARK = '【上下文压缩·原内容已省略】';
/** 瘦身时保留的正文开头字符数（保留一点语义，不整条抹掉）。 */
const SHRINK_KEEP_HEAD = 120;
/** 小于该 token 数的消息不值得瘦身（省下的还不够标记本身）。 */
const SHRINK_MIN_TOKENS = 64;
/** 单次 add() 内最多瘦身多少条（防御性上限，避免极端情况下的长循环）。 */
const MAX_SHRINK_PASSES = 24;

/**
 * 把消息序列切分为「原子组」：返回每条消息所属的组号（从 0 递增）。
 *
 * 分组规则：`assistant`（带 tool_calls）必须与其后随的全部 `tool` 结果同属一组。
 * 这是 LLM 请求的硬约束 —— OpenAI 兼容协议要求每个 tool_call 都紧跟对应结果、
 * 每个 tool 结果都能回溯到一个 tool_call；任何一侧缺失都会被 provider 以 400
 * 拒绝（invalid_request_error：tool result 的 tool id 未找到）。
 * 因此淘汰历史时只能整组丢弃，绝不能从组中间切。
 */
export function groupIndexOf(msgs: Message[]): number[] {
  const out: number[] = new Array(msgs.length);
  let g = 0;
  let pending = 0; // 当前 assistant 还缺几个 tool 结果
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i] as Message;
    if (pending > 0 && m.role === 'tool') {
      out[i] = g;
      pending -= 1;
      if (pending === 0) g += 1;
      continue;
    }
    // 还欠着 tool 结果却来了别的消息：说明历史本身已断裂，就地闭合该组，
    // 避免把后面的消息错误地并入「欠结果」的组。
    if (pending > 0) {
      g += 1;
      pending = 0;
    }
    out[i] = g;
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      pending = m.tool_calls.length;
    } else {
      g += 1;
    }
  }
  return out;
}

/** 最后一组（当前轮次）的起始下标：淘汰时该组必须整体保留。 */
function lastGroupStart(msgs: Message[]): number {
  const g = groupIndexOf(msgs);
  if (g.length === 0) return 0;
  const last = g[g.length - 1];
  let i = g.length - 1;
  while (i > 0 && g[i - 1] === last) i -= 1;
  return i;
}

const alreadyShrunk = (m: Message): boolean =>
  typeof m.content === 'string' && m.content.includes(SHRUNK_MARK);

/**
 * 内容瘦身：保留消息本体（尤其 tool 消息的 tool_call_id 与 name），只把正文
 * 替换为一段有界说明。与「整条淘汰」不同，它不改变消息条数与配对关系，
 * 因此永远不会制造孤儿 tool 结果 / 孤儿 tool_call。
 */
function shrinkMessage(m: Message): Message {
  const text = typeof m.content === 'string' ? m.content : '';
  const head = text.slice(0, SHRINK_KEEP_HEAD).replace(/\s+/g, ' ').trim();
  const label =
    m.role === 'tool' ? '工具结果' : m.role === 'assistant' ? '助手回复' : '用户输入';
  return {
    ...m,
    content: `${SHRUNK_MARK}${label}共 ${text.length} 字符，已压缩以释放上下文，开头摘要：${head}`
  };
}

export class Memory {
  private window: Message[] = [];
  private longTerm: string[] = [];
  private longTermScores: number[] = [];
  private windowScores: number[] = [];
  private opts: {
    maxWindow: number;
    summarizer?: MemorySummarizer;
    scorer?: MemoryScorer;
    notesTopK: number;
    compressThreshold: number;
  };
  private store: MemoryStore;
  private sessionKey: string;
  // 标记：lastInput 用于打分时的 context
  private lastInput: string = '';
  // 上下文压缩摘要（有界字符串）；为 null 表示尚未发生压缩。
  private summaryText: string | null = null;
  // 异步摘要器（如 LLM）返回的待落地摘要；hasPendingSummary=true 时窗口暂不含摘要节点，
  // 待 flushSummary() 后再补入，保证下一轮 history() 已包含压缩结果。
  private pendingSummary: Promise<string> | null = null;
  private hasPendingSummary = false;
  // token 级压缩护栏：最近一次 LLM 调用的真实上下文占用（由 harness 在发射
  // llm:usage 时经 setContextUsage 喂入），用于按占用率触发历史淘汰。
  private lastPromptTokens = 0;
  private lastWindow = 0;
  // 累计压缩（淘汰）次数：任一触发条件命中即 +1，供前端「已压缩」指示与运维观测。
  private _compactCount = 0;
  /**
   * 自上次用量上报以来是否发生过压缩（淘汰/瘦身）。
   *
   * 与 `_compactCount` 的区别：本字段带「per-report 清零」语义——每次被 harness
   * 经 `consumeCompressed()` 读取上报后归零，因此只反映「自上次上报以来是否压缩过」，
   * 而 `_compactCount` 是会话级累计。二者都会因「条数超 maxWindow 的常规滑动淘汰」
   * 或「token 占用越过阈值的清理」而置位，但本字段不会常亮：一旦用量回落、若干轮
   * 上报不再发生压缩，徽标便会熄灭，从而根治「显示已压缩、实际用量纹丝不动」的假象。
   */
  private _compressedSinceReport = false;
  // 本轮 token 护栏需要削减的 token 数（在触发时算一次，避免淘汰后目标漂移）。
  private _tokenOvershoot = 0;

  constructor(opts: MemoryOptions = {}) {
    this.opts = {
      maxWindow: opts.maxWindow ?? 20,
      summarizer: opts.summarizer,
      scorer: opts.scorer,
      notesTopK: opts.notesTopK ?? 10,
      compressThreshold: opts.compressThreshold ?? 0.8,
    };
    // 解析后端：显式 store > 旧版 persistencePath（单文件）> 纯内存（默认）。
    if (opts.store) {
      this.store = opts.store;
      this.sessionKey = sanitizeKey(opts.sessionKey);
    } else {
      this.store = new VolatileMemoryStore();
      this.sessionKey = sanitizeKey(opts.sessionKey);
    }
    this.lastInput = opts.scoringContext ?? '';
  }

  /** 是否配置了持久化后端（volatile 之外）。驱动 harness 的 load/save。 */
  get hasPersistence(): boolean {
    return this.store.kind !== 'volatile';
  }

  /** 后端类型（volatile / file / sqlite），供运维视图与日志使用。 */
  get backend(): string {
    return this.store.kind;
  }

  /** 当前绑定的会话/租户 key。 */
  get key(): string {
    return this.sessionKey;
  }

  /** 更新当前用户输入上下文（用于打分）。 */
  setScoringContext(input: string): void {
    this.lastInput = input;
  }

  /**
   * 喂入最近一次 LLM 调用的真实上下文占用，驱动 token 级压缩触发。
   * harness 在发射 llm:usage 时调用：promptTokens 为输入 token，window 为上下文窗口上限。
   * 仅需调用一次（每次 LLM 返回 usage 时），Memory 据此判断是否需要淘汰历史。
   */
  setContextUsage(promptTokens: number, window: number): void {
    this.lastPromptTokens = promptTokens;
    this.lastWindow = window;
  }

  /** 当前 token 占用率（lastPromptTokens / lastWindow），无数据时为 0。供运维视图与测试观测。 */
  get usageRatio(): number {
    return this.lastWindow > 0 ? this.lastPromptTokens / this.lastWindow : 0;
  }

  /** 会话级累计：是否发生过任意压缩（淘汰）。注意前端「已压缩」指示改走 per-report 的 consumeCompressed()，本 getter 仅用于运维视图/测试观测。 */
  get compressed(): boolean {
    return this.compactCount > 0;
  }

  /** 累计压缩（淘汰）次数，供运维视图与测试观测。 */
  get compactCount(): number {
    return this._compactCount;
  }

  /**
   * 取回并清零「自上次用量上报以来是否发生过上下文压缩」。
   *
   * 供 harness 在发射 `llm:usage` 时读取 —— 与前端注释里的语义
   * （「自上次用量上报以来是否发生过压缩」）保持一致。此前直接用会话级
   * sticky 的 `compressed`，导致徽标一旦亮起就永不消失，与真实用量脱钩。
   */
  consumeCompressed(): boolean {
    const v = this._compressedSinceReport;
    this._compressedSinceReport = false;
    return v;
  }

  /**
   * 本轮 token 护栏需要削减的 token 数：把占用从当前值压到
   * 「阈值 × 余量系数」以下所需的绝对削减量。0 表示无需削减。
   *
   * 余量系数（0.85）用于消除「压完立刻又越界」的抖动 —— 此前目标就是一个
   * 固定比例，压完往往刚好卡在阈值附近，下一轮加上新消息又立刻越界，
   * 表现就是压缩反复触发而用量在阈值上下横跳。
   */
  private computeOvershoot(): number {
    if (this.lastWindow <= 0 || this.lastPromptTokens <= 0) return 0;
    const targetRatio = Math.max(0.05, this.opts.compressThreshold * 0.85);
    return Math.max(0, this.lastPromptTokens - this.lastWindow * targetRatio);
  }

  /**
   * token 级压缩目标：历史部分应被压缩到多少 token。
   *
   * 修正此前的缺陷：原实现拿「窗口 × (阈值 − 固定 25% 预留)」当历史预算，
   * 完全不扣减系统提示 / 工具 schema 的真实固定开销。于是当越阈值是由固定
   * 开销（大模型工具集 + 长系统提示）造成时，历史永远「低于预算」，压缩彻底
   * 空转 —— 这正是「显示已压缩、实际用量没有变化」的根因之一。
   * 这里改为按超出量反推：目标历史 = 当前历史 − 需削减量。
   */
  private tokenTarget(rest: Message[]): number {
    let histNow = 0;
    for (const m of rest) histNow += estimateTokens(messageText(m));
    return Math.max(0, histNow - this._tokenOvershoot);
  }

  /** 历史（不含真实系统提示）当前占用的估算 token 数。 */
  historyTokens(): number {
    let t = 0;
    for (const m of this.window) {
      if (m.role === 'system' && !isSummaryNode(m)) continue;
      t += estimateTokens(messageText(m));
    }
    return t;
  }

  /**
   * 从最近（末尾）向最旧（开头）贪心保留历史消息，直到估算 token 累计超过目标预算；
   * 返回应保留的消息条数。若整窗历史估算已低于目标（超阈值源于固定开销而非历史），
   * 返回 rest.length（不淘汰）。否则至少保留 1 条、且留 1 条可淘汰空间以保证有进展。
   */
  private keepWithinTokenBudget(rest: Message[], targetHist: number): number {
    // 估算整窗历史 token；若已低于目标，无需淘汰（避免裁掉合法上下文）。
    let total = 0;
    for (const m of rest) total += estimateTokens(messageText(m));
    if (total <= targetHist) return rest.length;

    let keptTokens = 0;
    let keepCount = 0;
    for (let i = rest.length - 1; i >= 0; i--) {
      const t = estimateTokens(messageText(rest[i]));
      if (keepCount > 0 && keptTokens + t > targetHist) break;
      keptTokens += t;
      keepCount++;
    }
    return Math.max(1, Math.min(keepCount, rest.length - 1));
  }

  /**
   * 把「期望淘汰条数」对齐到原子组边界，返回实际可安全淘汰的条数。
   *
   * 两条硬约束：
   *  1. 绝不从 assistant(tool_calls) 与其 tool 结果之间切 —— 那会留下孤儿 tool
   *     结果，provider 会以 400「tool result 的 tool id 未找到」拒绝整个请求；
   *  2. 最后一组（当前轮次）永不淘汰 —— 否则刚拿到的工具结果会被自己挤掉。
   * 切点若落在旧组中间，则整组淘汰（多释放一点，安全且更简单）。
   */
  private alignEvictionCut(rest: Message[], want: number): number {
    if (want <= 0 || rest.length === 0) return 0;
    const groups = groupIndexOf(rest);
    const lastStart = lastGroupStart(rest);
    let cut = Math.min(want, lastStart);
    if (cut <= 0) return 0;
    // 只能淘汰到当前轮次之前；恰好落在边界上则直接采用。
    if (cut >= lastStart) return lastStart;
    const g = groups[cut];
    if (groups[cut - 1] === g) {
      // 切点落在组中间：推进到组末，整组丢弃。
      while (cut < lastStart && groups[cut] === g) cut += 1;
    }
    return cut;
  }

  /**
   * token 兜底清理：对大体积消息做内容瘦身，直到历史占用降到目标以下。
   *
   * 存在的意义：组对齐淘汰受「当前轮次不可切」限制，可能压不到目标（例如最后一组
   * 本身就是若干条大工具结果）。此时不能靠继续切来达标（会破坏配对），只能瘦身。
   * 瘦身保留消息本体与 tool_call_id，只压缩正文，因此既能真实降低上下文占用，
   * 又绝对不会产生配对断裂。返回是否真的改动过。
   *
   * @param target 历史 token 目标
   * @param protectLastGroup 是否保护当前轮次。默认先保护（优先保住刚拿到的工具
   *   结果）；若保护状态下压不到目标，调用方会再放行一次 —— 因为上下文超窗会让
   *   下一次请求直接失败，此时压缩当前轮次是唯一出路。
   */
  private shrinkToTokenBudget(target: number, protectLastGroup = true): boolean {
    if (!(target >= 0)) return false;
    let changed = false;
    for (let pass = 0; pass < MAX_SHRINK_PASSES; pass++) {
      if (this.historyTokens() <= target) break;
      const limit = protectLastGroup
        ? lastGroupStart(this.window) // 当前轮次暂不瘦身
        : this.window.length;
      let idx = -1;
      for (let i = 0; i < limit; i++) {
        const m = this.window[i] as Message;
        if (m.role === 'system' && !isSummaryNode(m)) continue;
        if (typeof m.content !== 'string') continue; // 多模态内容不改写
        if (alreadyShrunk(m)) continue;
        if (estimateTokens(messageText(m)) < SHRINK_MIN_TOKENS) continue;
        idx = i;
        break;
      }
      if (idx < 0) break; // 没有可再瘦身的消息了
      this.window[idx] = shrinkMessage(this.window[idx] as Message);
      changed = true;
    }
    return changed;
  }

  add(msg: Message): void {
    this.window.push(msg);
    // 更新对应消息的分数
    if (this.opts.scorer && msg.role !== 'system') {
      // 异步打分不阻塞 add()
      const scores = this.opts.scorer.scoreWindow(this.window, this.lastInput);
      if (scores instanceof Promise) {
        void scores.then((s) => {
          this.windowScores = s;
        });
      } else {
        this.windowScores = scores;
      }
    }
    // 触发条件：消息条数溢出 或 token 占用率越过压缩阈值。
    // token 级触发是独立于 CONTEXT_COMPRESSION 特性开关的安全护栏——
    // 即便未开启摘要，也会触发 FIFO 淘汰，避免上下文撑爆（原问题根因）。
    // 注意：rest 保留各自在 window 中的原始下标，供打分器对齐（此前直接用
    // windowScores[i] 与 rest[i] 对应，sys 消息被过滤后索引整体错位）。
    const restIdx: number[] = [];
    const sys: Message[] = [];
    const rest: Message[] = [];
    this.window.forEach((m, i) => {
      if (m.role === 'system' && !isSummaryNode(m)) sys.push(m);
      else {
        restIdx.push(i);
        rest.push(m);
      }
    });

    const overCount = this.window.length > this.opts.maxWindow;
    const overTokens =
      this.lastWindow > 0 &&
      this.lastPromptTokens / this.lastWindow >= this.opts.compressThreshold;

    if (!overCount && !overTokens) return;

    // 本轮需要削减的 token 数只在此处算一次：淘汰会改变历史体积，
    // 若淘汰后再算目标，目标会跟着变小，导致过度淘汰 / 无限瘦身。
    this._tokenOvershoot = overTokens ? this.computeOvershoot() : 0;
    const target = this.tokenTarget(rest);

    // 若配置了 summarizer，为其预留 1 个槽位（压缩摘要一旦产生便长期固定保留）。
    const g = this.opts.summarizer ? 1 : 0;
    // 条数预算与 token 预算取交集，二者任一触发都要满足。
    const countBudget = overCount
      ? Math.max(0, this.opts.maxWindow - sys.length - g)
      : rest.length;
    const tokenBudget = overTokens
      ? this.keepWithinTokenBudget(rest, target)
      : rest.length;
    const budget = Math.min(countBudget, tokenBudget);

    // 淘汰切点必须落在原子组边界上（见 alignEvictionCut 注释）。
    const cut = this.alignEvictionCut(rest, rest.length - budget);

    if (cut > 0) {
      this._compactCount++;
      // 只要本次真的发生了淘汰（无论条数还是 token 驱动），就按 per-report 点亮，
      // 上报后由 consumeCompressed() 清零。这样既修掉「低用量时 sticky 误报」，
      // 又不会漏报真正的压缩活动：每次上报只反映「自上次上报以来是否压缩过」，
      // 压缩发生时用量确实下降了（或条数被裁掉），与 UI 指示保持一致。
      this._compressedSinceReport = true;
      // 仅淘汰超出预算的最旧轮次（含旧的过期摘要），并将其压缩为最新摘要。
      const evicted = rest.slice(0, cut);
      const keptRest = rest.slice(cut);
      if (this.opts.summarizer) {
        const result = this.opts.summarizer({ previous: this.summaryText, evicted });
        if (result instanceof Promise) {
          // 异步摘要器：暂存 pending，窗口先不含摘要节点；flushSummary() 落地后补入。
          // 一个 step 内可能连续多次 add()（assistant + N 条 tool 结果），
          // 此处必须与上一次尚未落地的 pending 合并，否则前一次淘汰的轮次摘要
          // 会被直接覆盖丢失。
          this.hasPendingSummary = true;
          const next = Promise.resolve(result)
            .then((s) => (s && typeof s === 'string' ? s : ''))
            .catch(() => this.summaryText ?? '');
          const prev = this.pendingSummary;
          this.pendingSummary = prev
            ? Promise.all([prev, next]).then(([a, b]) =>
                [a, b].filter(Boolean).join(' ').slice(-400)
              )
            : next;
          this.window = [...sys, ...keptRest];
        } else {
          this.summaryText = result;
          const summaryNode = this.summaryText
            ? [{ role: 'system' as const, content: `【历史摘要】\n${this.summaryText}` }]
            : [];
          this.window = [...sys, ...summaryNode, ...keptRest];
        }
      } else if (
        this.opts.scorer &&
        this.windowScores.length === this.window.length
      ) {
        // 按分数淘汰：以「原子组」为单位取分（组内最高分），保留高分整组，
        // 再按原始顺序还原。此前直接按分数排序会同时打乱时间顺序、
        // 并把 assistant 与其 tool 结果拆散，制造孤儿 tool 消息（provider 400）。
        const groups = groupIndexOf(rest);
        const groupScore = new Map<number, number>();
        rest.forEach((m, j) => {
          const key = groups[j] ?? 0;
          const s = this.windowScores[restIdx[j] ?? j] ?? 0;
          groupScore.set(key, Math.max(groupScore.get(key) ?? 0, s));
        });
        const ranked = [...groupScore.entries()].sort((a, b) => b[1] - a[1]);
        const keepGroups = new Set<number>();
        let keptCount = 0;
        for (const [key] of ranked) {
          if (keptCount >= budget) break;
          keepGroups.add(key);
          keptCount += groups.reduce((n, x) => n + (x === key ? 1 : 0), 0);
        }
        // 当前轮次（最后一组）无条件保留，避免刚产出的工具结果被自己挤掉。
        keepGroups.add(groups[groups.length - 1] ?? 0);
        this.window = [
          ...sys,
          ...rest.filter((m, j) => keepGroups.has(groups[j] ?? 0))
        ];
      } else {
        // 回退到原有 FIFO 淘汰（切点已按组对齐）
        this.window = [...sys, ...keptRest];
      }
    } else {
      // 仅 system + 摘要占位导致窗口看似溢出，或组对齐后无可安全淘汰的整组，重排即可。
      this.window = [...sys, ...rest];
    }

    // token 护栏兜底：组对齐淘汰受「当前轮次不可切」限制，可能压不到目标。
    // 此时对大体积消息做内容瘦身 —— 保留消息与 tool_call_id，只压缩正文，
    // 既真实降低上下文占用，又绝不破坏 tool 配对。
    // 分两级：先保住当前轮次（刚拿到的工具结果最有价值）；仍不达标则说明
    // 上下文已经超窗，下一次请求必然失败，此时放行瘦身当前轮次以自救。
    if (overTokens) {
      if (this.shrinkToTokenBudget(target)) {
        this._compactCount++;
        this._compressedSinceReport = true;
      }
      if (this.historyTokens() > target && this.shrinkToTokenBudget(target, false)) {
        this._compactCount++;
        this._compressedSinceReport = true;
      }
    }
  }

  /**
   * 主动把对话历史压缩到 maxTokens（估计 token）以内。应在「发送前」调用，
   * 不依赖 LLM 回传 usage——这正是各家主流压缩（Claude 自动压缩 /
   * LangChain trimMessages）的核心：按真实 payload 估算做预算封顶，而非被动等
   * 调用失败才补救。返回是否真发生了压缩（供「已压缩」指示）。
   *
   * 升级策略（均保持 tool_call ↔ tool 结果配对不破）：
   *  1) 整组淘汰最旧轮次（atomic group），若配了同步 summarizer 则并入摘要；
   *  2) 内容瘦身最大消息（保留 tool_call_id / name，只压正文）；
   *  3) 极端情况下硬性截断超长单条（保证 payload 一定能落回预算）。
   */
  fitToBudget(maxTokens: number): boolean {
    if (!(maxTokens > 0)) return false;
    if (this.historyTokens() <= maxTokens) return false;
    let changed = false;

    // 1) 整组淘汰最旧轮次，直到历史落回预算或仅剩当前轮次（无可安全整组淘汰）。
    //    当前轮次（最后一组）不可淘汰，否则刚拿到的工具结果被自己挤掉。
    let guard = 0;
    while (this.historyTokens() > maxTokens && guard++ < 64) {
      const sys: Message[] = [];
      const rest: Message[] = [];
      this.window.forEach((m) => {
        if (m.role === 'system' && !isSummaryNode(m)) sys.push(m);
        else rest.push(m);
      });
      const cut = this.alignEvictionCut(rest, rest.length);
      if (cut <= 0) break; // 仅剩当前轮次，无整组可淘汰
      const evicted = rest.slice(0, cut);
      const keptRest = rest.slice(cut);
      if (this.opts.summarizer) {
        const result = this.opts.summarizer({ previous: this.summaryText, evicted });
        if (!(result instanceof Promise)) {
          this.summaryText = result;
          const summaryNode = this.summaryText
            ? [{ role: 'system' as const, content: `【历史摘要】\n${this.summaryText}` }]
            : [];
          this.window = [...sys, ...summaryNode, ...keptRest];
        } else {
          // 异步摘要无法在同步语境等待：直接丢弃，避免阻塞；其正确落地点仍在
          // flushSummary（由 harness 循环顶部调用）。
          this.window = [...sys, ...keptRest];
        }
      } else {
        this.window = [...sys, ...keptRest];
      }
      changed = true;
    }

    // 2) 内容瘦身兜底（保留配对）：先保护当前轮次，仍不达标则放行瘦身当前轮次。
    if (this.historyTokens() > maxTokens) {
      if (this.shrinkToTokenBudget(maxTokens)) changed = true;
      if (this.historyTokens() > maxTokens && this.shrinkToTokenBudget(maxTokens, false))
        changed = true;
    }

    // 3) 硬性截断超长单条：仅在上述都无效时（例如单条消息本身就超过预算）才触发，
    //    截断只缩短正文，不动 tool_call_id / name，绝不破坏 tool 配对。
    if (this.historyTokens() > maxTokens) {
      let idx = -1;
      let largest = 0;
      this.window.forEach((m, i) => {
        if (m.role === 'system' && !isSummaryNode(m)) return;
        if (typeof m.content !== 'string') return;
        const t = estimateTokens(messageText(m));
        if (t > largest) {
          largest = t;
          idx = i;
        }
      });
      if (idx >= 0) {
        const m = this.window[idx] as Message;
        const text = messageText(m);
        // 粗估 1 token ≈ 3.5 字符，留出标记余量。
        const allowChars = Math.max(200, Math.floor(maxTokens * 3.5));
        const truncated = text.slice(0, allowChars);
        this.window[idx] = {
          ...m,
          content: `${truncated}\n…[已截断，超出上下文预算]`
        };
        changed = true;
      }
    }

    if (changed) {
      this._compactCount++;
      this._compressedSinceReport = true;
    }
    return changed;
  }

  /** 当前上下文压缩摘要（无则 null），供运维视图与测试观测。 */
  get summary(): string | null {
    return this.summaryText;
  }

  /** 是否存在尚未落地的异步摘要（测试/运维观测用）。 */
  get summaryPending(): boolean {
    return this.hasPendingSummary;
  }

  /**
   * 落地待处理的异步（LLM）摘要：等待 pendingSummary 完成后写入 summaryText 并重建
   * 窗口里的摘要节点。同步摘要器不会触发 pending，此步为 no-op。必须在下一次
   * `history()` 读取之前调用（harness 循环顶部已接入），以保证喂给模型的上下文已压缩。
   */
  async flushSummary(): Promise<void> {
    if (!this.hasPendingSummary || !this.pendingSummary) return;
    const s = await this.pendingSummary;
    this.summaryText = s || null;
    this.pendingSummary = null;
    this.hasPendingSummary = false;
    const isSummary = (m: Message): boolean =>
      m.role === 'system' &&
      typeof m.content === 'string' &&
      m.content.startsWith('【历史摘要】');
    const sys = this.window.filter((m) => m.role === 'system' && !isSummary(m));
    const rest = this.window.filter((m) => !(m.role === 'system' && !isSummary(m)));
    const summaryNode = this.summaryText
      ? [{ role: 'system' as const, content: `【历史摘要】\n${this.summaryText}` }]
      : [];
    this.window = [...sys, ...summaryNode, ...rest];
  }

  history(): Message[] {
    return [...this.window];
  }

  remember(note: string): void {
    this.longTerm.push(note);
    // 初始分数为 0，稍后在 save 时重新计算
    this.longTermScores.push(0);
  }

  notes(): string[] {
    return [...this.longTerm];
  }

  /** 获取长期记忆笔记及其分数。 */
  notesWithScores(): Array<{ note: string; score: number }> {
    return this.longTerm.map((note, i) => ({
      note,
      score: this.longTermScores[i] ?? 0,
    }));
  }

  // 注入到系统提示词中，使模型能够看到跨运行的上下文。
  systemContext(): string {
    return this.longTerm.length
      ? `Long-term memory:\n- ${this.longTerm.join('\n- ')}`
      : '';
  }

  /**
   * 按相关性排序并裁剪长期记忆，注入到系统提示词中。
   * 若配置了 scorer，则按与 context 的相关性排序，只注入 Top-K。
   * 否则回退到注入全部笔记（向后兼容）。
   */
  async systemContextWithScoring(context: string): Promise<string> {
    if (!this.opts.scorer || this.longTerm.length === 0) {
      return this.systemContext();
    }
    const scores = await this.opts.scorer.scoreNotes(this.longTerm, context);
    this.longTermScores = scores;
    const indexed = this.longTerm.map((note, i) => ({
      note,
      score: scores[i] ?? 0,
    }));
    indexed.sort((a, b) => b.score - a.score);
    const topK = Math.min(this.opts.notesTopK, indexed.length);
    const top = indexed.slice(0, topK).map((x) => x.note);
    return top.length
      ? `Long-term memory:\n- ${top.join('\n- ')}`
      : '';
  }

  /** 持久化当前记忆到后端（按 sessionKey）。 */
  async save(): Promise<void> {
    await this.flushSummary();
    // 若有 scorer，重新计算 longTerm scores
    if (this.opts.scorer && this.longTerm.length > 0) {
      const scores = await this.opts.scorer.scoreNotes(this.longTerm, this.lastInput);
      this.longTermScores = scores;
    }
    const data: PersistedMemory = {
      window: this.window,
      longTerm: this.longTerm,
      ...(this.summaryText ? { summary: this.summaryText } : {}),
      ...(this.longTermScores.length > 0 ? { longTermScores: this.longTermScores } : {}),
      ...(this.windowScores.length > 0 ? { windowScores: this.windowScores } : {}),
    };
    await this.store.save(this.sessionKey, data);
  }

  /** 从后端载入记忆（按 sessionKey）。无存档则保持空。 */
  async load(): Promise<void> {
    const data = await this.store.load(this.sessionKey);
    if (data) {
      this.window = Array.isArray(data.window) ? data.window : [];
      this.longTerm = Array.isArray(data.longTerm) ? data.longTerm : [];
      this.summaryText = typeof data.summary === 'string' ? data.summary : null;
      this.longTermScores = Array.isArray(data.longTermScores) ? data.longTermScores as number[] : [];
      this.windowScores = Array.isArray(data.windowScores) ? data.windowScores as number[] : [];
      // 如果持久化的 scores 长度不匹配，重置
      if (this.longTermScores.length !== this.longTerm.length) {
        this.longTermScores = [];
      }
      if (this.windowScores.length !== this.window.length) {
        this.windowScores = [];
      }
    }
  }

  /** 清空当前会话记忆（运行时 + 后端）。 */
  async clear(): Promise<void> {
    this.window = [];
    this.longTerm = [];
    this.longTermScores = [];
    this.windowScores = [];
    this._compactCount = 0;
    this._compressedSinceReport = false;
    this._tokenOvershoot = 0;
    this.summaryText = null;
    this.pendingSummary = null;
    this.hasPendingSummary = false;
    await this.store.delete(this.sessionKey);
  }
}

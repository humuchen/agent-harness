import { Message, messageText } from './types';
import { tokenize } from './tools';
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
}

export class Memory {
  private window: Message[] = [];
  private longTerm: string[] = [];
  private longTermScores: number[] = [];
  private windowScores: number[] = [];
  private opts: { maxWindow: number; summarizer?: MemorySummarizer; scorer?: MemoryScorer; notesTopK: number };
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

  constructor(opts: MemoryOptions = {}) {
    this.opts = {
      maxWindow: opts.maxWindow ?? 20,
      summarizer: opts.summarizer,
      scorer: opts.scorer,
      notesTopK: opts.notesTopK ?? 10,
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
    if (this.window.length > this.opts.maxWindow) {
      // 区分「真实 system 提示词」与「历史摘要」（摘要也是 role:'system'）：前者始终
      // 保留在最前，后者随压缩回收、只保留最新生成的一条，避免多次压缩堆积多条摘要。
      const isSummary = (m: Message): boolean =>
        m.role === 'system' &&
        typeof m.content === 'string' &&
        m.content.startsWith('【历史摘要】');
      // 真实 system 提示词永远在最前
      const sys = this.window.filter((m) => m.role === 'system' && !isSummary(m));
      const rest = this.window.filter((m) => !(m.role === 'system' && !isSummary(m)));
      // 若配置了 summarizer，为其预留 1 个槽位（压缩摘要一旦产生便长期固定保留）。
      const g = this.opts.summarizer ? 1 : 0;
      const budget = Math.max(0, this.opts.maxWindow - sys.length - g);
      if (rest.length > budget) {
        // 仅淘汰超出预算的最旧轮次（含旧的过期摘要），并将其压缩为最新摘要。
        const evicted = rest.slice(0, rest.length - budget);
        const keptRest = rest.slice(rest.length - budget);
        if (this.opts.summarizer) {
          const _summarizer = this.opts.summarizer;
          // 若有 scorer，且 evicted 中有高分条目，额外通过 summarizer 压缩而非直接丢弃
          const result = _summarizer({ previous: this.summaryText, evicted });
          if (result instanceof Promise) {
            // 异步摘要器：暂存 pending，窗口先不含摘要节点；flushSummary() 落地后补入。
            this.hasPendingSummary = true;
            this.pendingSummary = Promise.resolve(result)
              .then((s) => (s && typeof s === 'string' ? s : ''))
              .catch(() => this.summaryText ?? '');
            this.window = [...sys, ...keptRest];
          } else {
            this.summaryText = result;
            const summaryNode = this.summaryText
              ? [{ role: 'system' as const, content: `【历史摘要】\n${this.summaryText}` }]
              : [];
            this.window = [...sys, ...summaryNode, ...keptRest];
          }
        } else if (this.opts.scorer && this.windowScores.length > 0) {
          // 按分数排序，保留高分条目
          const scored = rest.map((m, i) => ({ msg: m, score: this.windowScores[i] ?? 0 }));
          scored.sort((a, b) => b.score - a.score);
          const kept = scored.slice(0, budget).map((s) => s.msg);
          this.window = [...sys, ...kept];
        } else {
          // 回退到原有 FIFO 淘汰
          this.window = [...sys, ...keptRest];
        }
      } else {
        // 仅 system + 摘要占位导致窗口看似溢出，无需淘汰。
        this.window = [...sys, ...rest];
      }
    }
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
    this.summaryText = null;
    this.pendingSummary = null;
    this.hasPendingSummary = false;
    await this.store.delete(this.sessionKey);
  }
}

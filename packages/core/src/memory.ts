import { Message } from './types';
import {
  MemoryStore,
  VolatileMemoryStore,
  FileMemoryStore,
  PersistedMemory,
  sanitizeKey,
} from './memory-store';

/**
 * 上下文压缩摘要器：当滑动窗口溢出、需要淘汰旧轮次时调用。
 * - `evicted`：本次被淘汰的轮次（user/assistant/tool 消息序列）。
 * - `previous`：上一次压缩得到的摘要（首次为 null），可用于增量合并。
 * 约定：返回**有界**字符串（建议 < 400 字符），否则压缩本身会变成新的 token 负担；
 * 返回空串表示放弃本次摘要。允许返回 `Promise<string>`（如调用 LLM 做高质量摘要），
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
  // 跨运行持久化记忆的可选路径（旧版单文件模式，向后兼容）。
  // 设置后等效于 FileMemoryStore({ path })，仅支持单一会话（key=''）。
  persistencePath?: string;
  // 显式存储后端（P1-9）。提供后覆盖 persistencePath。
  store?: MemoryStore;
  // 租户/会话标识：记忆按 key 隔离。不传则归到 'anonymous'。
  // 配合 FileMemoryStore/ SqliteMemoryStore 即可实现多租户记忆持久化。
  sessionKey?: string;
  // 可选上下文压缩：滑动窗口溢出淘汰旧轮次时，用它将 evicted 轮次压缩为一条
  // system 摘要固定保留，根治「每步重发全部历史」导致的 token 平方增长。
  // 未提供则沿用原有「直接丢弃」行为。必须同步、返回有界字符串。
  summarizer?: MemorySummarizer;
}

export class Memory {
  private window: Message[] = [];
  private longTerm: string[] = [];
  private opts: { maxWindow: number; summarizer?: MemorySummarizer };
  private store: MemoryStore;
  private sessionKey: string;
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
    };
    // 解析后端：显式 store > 旧版 persistencePath（单文件）> 纯内存（默认）。
    if (opts.store) {
      this.store = opts.store;
      this.sessionKey = sanitizeKey(opts.sessionKey);
    } else if (opts.persistencePath) {
      this.store = new FileMemoryStore({ path: opts.persistencePath });
      this.sessionKey = ''; // 旧单文件模式：单一会话
    } else {
      this.store = new VolatileMemoryStore();
      this.sessionKey = sanitizeKey(opts.sessionKey);
    }
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

  add(msg: Message): void {
    this.window.push(msg);
    if (this.window.length > this.opts.maxWindow) {
      // 区分「真实 system 提示词」与「历史摘要」（摘要也是 role:'system'）：前者始终
      // 保留在最前，后者随压缩回收、只保留最新生成的一条，避免多次压缩堆积多条摘要。
      const isSummary = (m: Message): boolean =>
        m.role === 'system' &&
        typeof m.content === 'string' &&
        m.content.startsWith('【历史摘要】');
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
          const result = this.opts.summarizer({ previous: this.summaryText, evicted });
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
        } else {
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
  }

  notes(): string[] {
    return [...this.longTerm];
  }

  // 注入到系统提示词中，使模型能够看到长期上下文。
  systemContext(): string {
    return this.longTerm.length
      ? `Long-term memory:\n- ${this.longTerm.join('\n- ')}`
      : '';
  }

  /** 持久化当前记忆到后端（按 sessionKey）。 */
  async save(): Promise<void> {
    await this.flushSummary();
    const data: PersistedMemory = {
      window: this.window,
      longTerm: this.longTerm,
      ...(this.summaryText ? { summary: this.summaryText } : {}),
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
    }
  }

  /** 清空当前会话记忆（运行时 + 后端）。 */
  async clear(): Promise<void> {
    this.window = [];
    this.longTerm = [];
    this.summaryText = null;
    this.pendingSummary = null;
    this.hasPendingSummary = false;
    await this.store.delete(this.sessionKey);
  }
}

import { Message } from './types';
import {
  MemoryStore,
  VolatileMemoryStore,
  FileMemoryStore,
  PersistedMemory,
  sanitizeKey,
} from './memory-store';

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
}

export class Memory {
  private window: Message[] = [];
  private longTerm: string[] = [];
  private opts: { maxWindow: number };
  private store: MemoryStore;
  private sessionKey: string;

  constructor(opts: MemoryOptions = {}) {
    this.opts = {
      maxWindow: opts.maxWindow ?? 20,
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
      this.window = this.window.slice(this.window.length - this.opts.maxWindow);
    }
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
    const data: PersistedMemory = { window: this.window, longTerm: this.longTerm };
    await this.store.save(this.sessionKey, data);
  }

  /** 从后端载入记忆（按 sessionKey）。无存档则保持空。 */
  async load(): Promise<void> {
    const data = await this.store.load(this.sessionKey);
    if (data) {
      this.window = Array.isArray(data.window) ? data.window : [];
      this.longTerm = Array.isArray(data.longTerm) ? data.longTerm : [];
    }
  }

  /** 清空当前会话记忆（运行时 + 后端）。 */
  async clear(): Promise<void> {
    this.window = [];
    this.longTerm = [];
    await this.store.delete(this.sessionKey);
  }
}

import { Message } from './types';

export interface MemoryOptions {
  // 发送给 LLM 的对话历史滚动窗口大小。
  maxWindow?: number;
  // 跨运行持久化记忆的可选路径（JSON 格式）。
  persistencePath?: string;
}

export class Memory {
  private window: Message[] = [];
  private longTerm: string[] = [];
  private opts: Required<MemoryOptions>;

  constructor(opts: MemoryOptions = {}) {
    this.opts = {
      maxWindow: opts.maxWindow ?? 20,
      persistencePath: opts.persistencePath ?? '',
    };
  }

  /** 是否配置了跨运行持久化路径（save/load 因此生效）。 */
  get hasPersistence(): boolean {
    return !!this.opts.persistencePath;
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

  async save(): Promise<void> {
    if (!this.opts.persistencePath) return;
    const fs = await import('node:fs/promises');
    await fs.writeFile(
      this.opts.persistencePath,
      JSON.stringify({ window: this.window, longTerm: this.longTerm }, null, 2),
      'utf-8'
    );
  }

  async load(): Promise<void> {
    if (!this.opts.persistencePath) return;
    const fs = await import('node:fs/promises');
    try {
      const raw = await fs.readFile(this.opts.persistencePath, 'utf-8');
      const data = JSON.parse(raw);
      this.window = Array.isArray(data.window) ? data.window : [];
      this.longTerm = Array.isArray(data.longTerm) ? data.longTerm : [];
    } catch {
      // 没有之前的记忆；从头开始
    }
  }
}

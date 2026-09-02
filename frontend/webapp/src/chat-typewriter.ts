/**
 * chat.ts 打字机引擎抽离（Phase 3）。
 *
 * 原 AhChat 内的「逐字揭示」能力（缓冲 pending / 已收标记 received / 兜底全文 finalBy +
 * typedTimer + tick* 方法）与其余 run 生命周期（ingest / dispatch / resumeLost）强共享
 * 同一组缓冲，故无法孤立抽成纯函数。这里收为一个轻量控制器 `ChatTypewriter`，由 AhChat
 * 持有为 `this.typewriter`；ingest / dispatchPrompt / resumeLost 仍直接读写其
 * pending / received / finalBy 缓冲（经 `this.typewriter.xxx`），打字机 tick 与 run 收尾
 * 的 flush/drain 经 `this.typewriter.xxx()` 调用。行为与原实现逐字一致，只是宿主从
 * AhChat 自身切换为其持有的控制器实例。
 *
 * 与宿主的耦合通过构造期传入的回调（caps）解耦：AhChat 把 patchSession / curSession /
 * isAnyStreaming / requestUpdate 包成箭头函数传入，控制器不依赖 AhChat 类型可见性。
 */
import type { ChatMsg } from './chat-types';

/** 控制器所需的宿主能力回调（由 AhChat 在构造期以箭头函数注入）。 */
export interface TypewriterCaps {
  /** 把流式增量写回某会话的可见消息。 */
  patchSession(sid: string, p: Partial<ChatMsg>): void;
  /** 取某会话当前流式消息快照。 */
  curSession(sid: string): ChatMsg | null;
  /** 当前是否仍有任何会话在流式（打字机定时器停启判定）。 */
  isAnyStreaming(): boolean;
  /** 触发组件重渲染。 */
  requestUpdate(): void;
}

export class ChatTypewriter {
  /** 每会话的打字机缓冲（content / reasoning 分开）。 */
  pending: Record<string, { content: string; reasoning: string }> = {};
  /** 每会话是否已收到 llm:token 增量（防止 llm:response 整段覆盖打字机效果）。 */
  received: Record<string, boolean> = {};
  /** run:end 携带的权威全文（仅在打字机未产生任何可见文本时作兜底）。 */
  finalBy: Record<string, string> = {};

  private typedTimer: ReturnType<typeof setInterval> | null = null;
  private caps: TypewriterCaps;

  constructor(caps: TypewriterCaps) {
    this.caps = caps;
  }

  /**
   * 计算本 tick 应揭示的字符数：自适应速度。
   * 缓冲越大揭示越快（保证长文在 ~1.5s 内揭示完），但最小 2 字/tick 保留打字质感，
   * 最大 28 字/tick 防止对超长文本揭示过慢。真流式（小 delta 频繁到达）时缓冲始终很小，
   * 故以最小速度揭示，呈现自然打字节奏。
   */
  private typeStep(n: number): number {
    if (n <= 0) return 0;
    return Math.min(28, Math.max(2, Math.ceil(n / 70)));
  }

  /** 启动打字机定时器（已运行则跳过）。 */
  ensureTypewriter() {
    if (this.typedTimer) return;
    this.typedTimer = setInterval(() => this.tickTypewriter(), 24);
  }

  /** 停止打字机定时器并清空缓冲状态。 */
  stopTypewriter() {
    if (this.typedTimer) {
      clearInterval(this.typedTimer);
      this.typedTimer = null;
    }
  }

  /** 把某会话缓冲中的待揭示文本一次性落到 content / reasoning（运行结束时调用，避免文本滞留）。 */
  flushTypewriter(sid: string) {
    const buf = this.pending[sid];
    if (!buf) return;
    const c = this.caps.curSession(sid);
    if (c) {
      if (buf.content)
        this.caps.patchSession(sid, { content: c.content + buf.content });
      if (buf.reasoning)
        this.caps.patchSession(sid, {
          reasoning: (c.reasoning ?? '') + buf.reasoning
        });
    }
    buf.content = '';
    buf.reasoning = '';
    if (!this.caps.isAnyStreaming()) this.stopTypewriter();
  }

  /**
   * 运行结束后，接替 interval 把剩余缓冲按打字节奏（与 tick 一致的步长/间隔）逐步揭示，
   * 直到缓冲清空再 resolve。这样即使后端把整段塞进单个 token，用户也能看到逐字打字效果，
   * 而不是 run:end 的 final 文本一次性覆盖。
   */
  drainTypewriter(sid: string): Promise<void> {
    return new Promise((resolve) => {
      const step = () => {
        const buf = this.pending[sid];
        if (!buf || (!buf.content.length && !buf.reasoning.length)) {
          if (!this.caps.isAnyStreaming()) this.stopTypewriter();
          resolve();
          return;
        }
        this.tickSession(sid);
        setTimeout(step, 24);
      };
      step();
    });
  }

  /** 单个定时器 tick：遍历所有会话缓冲，逐步揭示；无缓冲且均无流式时停定时器。 */
  private tickTypewriter() {
    let any = false;
    for (const sid in this.pending) {
      const buf = this.pending[sid];
      if (!buf || (!buf.content.length && !buf.reasoning.length)) continue;
      this.tickSession(sid);
      any = true;
    }
    if (!any && !this.caps.isAnyStreaming()) this.stopTypewriter();
  }

  /** 揭示某会话的一小段缓冲到可见文本。 */
  private tickSession(sid: string) {
    const buf = this.pending[sid];
    if (!buf) return;
    const c = this.caps.curSession(sid);
    if (!c) return;
    if (buf.content.length) {
      const step = this.typeStep(buf.content.length);
      const move = buf.content.slice(0, step);
      buf.content = buf.content.slice(step);
      this.caps.patchSession(sid, { content: c.content + move });
    }
    if (buf.reasoning.length) {
      const step = this.typeStep(buf.reasoning.length);
      const move = buf.reasoning.slice(0, step);
      buf.reasoning = buf.reasoning.slice(step);
      this.caps.patchSession(sid, { reasoning: (c.reasoning ?? '') + move });
    }
  }
}

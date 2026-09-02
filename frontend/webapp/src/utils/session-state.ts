/**
 * session-state：会话状态机（Session State Machine）。
 *
 * SVG 架构图中「前端应用层 · 会话状态机」的落地：把一次 agent 会话的生命周期
 * 从「一堆散落的 boolean 标志」收敛为显式状态迁移，非法迁移直接抛错，
 * 避免出现 running=true 且 finished=true 这类自相矛盾的 UI 状态。
 *
 * 用法：
 *   const sm = new SessionStateMachine();
 *   sm.transition('start');            // idle → running
 *   sm.can('approve');                 // false（只有 running 才能审批）
 *   sm.subscribe((p) => console.log(p));
 *
 * 状态：
 *   idle —— 初始 / 新会话
 *   running —— 运行中
 *   awaiting_approval —— 等待人工审批（工具确认）
 *   finished —— 正常结束
 *   error —— 出错终止
 *   aborted —— 用户停止
 */

export type SessionPhase =
  | 'idle'
  | 'running'
  | 'awaiting_approval'
  | 'finished'
  | 'error'
  | 'aborted';

export type SessionEvent =
  | 'start'
  | 'approve'
  | 'finish'
  | 'error'
  | 'abort'
  | 'reset';

/** 每个状态允许的下一个事件（白名单）。 */
const TRANSITIONS: Record<SessionPhase, SessionEvent[]> = {
  idle: ['start'],
  running: ['approve', 'finish', 'error', 'abort'],
  awaiting_approval: ['approve', 'error', 'abort'],
  finished: ['start', 'reset'],
  error: ['start', 'reset'],
  aborted: ['start', 'reset'],
};

/** 事件 → 目标状态映射。 */
const NEXT: Record<SessionEvent, SessionPhase> = {
  start: 'running',
  approve: 'awaiting_approval',
  finish: 'finished',
  error: 'error',
  abort: 'aborted',
  reset: 'idle',
};

export class SessionStateMachine {
  private phase: SessionPhase = 'idle';
  private listeners = new Set<(p: SessionPhase) => void>();

  /** 当前状态。 */
  get state(): SessionPhase {
    return this.phase;
  }

  /** 该状态是否「运行中/等待审批」这类未结束态。 */
  get active(): boolean {
    return this.phase === 'running' || this.phase === 'awaiting_approval';
  }

  /** 是否允许触发某事件（不改变状态，只做查询）。 */
  can(event: SessionEvent): boolean {
    return TRANSITIONS[this.phase].includes(event);
  }

  /**
   * 触发事件，迁移到下一状态。非法迁移抛错（调用方应先用 can() 判断或 catch）。
   * 返回迁移后的新状态，便于链式使用。
   */
  transition(event: SessionEvent): SessionPhase {
    if (!this.can(event)) {
      throw new Error(
        `session: 非法迁移 ${this.phase} --${event}--> ${NEXT[event] ?? '?'}`
      );
    }
    const next = NEXT[event];
    this.phase = next;
    for (const fn of this.listeners) {
      try {
        fn(this.phase);
      } catch {
        /* 订阅者异常不影响状态机 */
      }
    }
    return this.phase;
  }

  /** 订阅状态变化；返回解绑函数。 */
  subscribe(fn: (p: SessionPhase) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** 回退到初始态（等价 transition('reset')，但允许从任何状态调用）。 */
  reset(): void {
    if (this.phase !== 'idle') {
      this.phase = 'idle';
      for (const fn of this.listeners) {
        try {
          fn(this.phase);
        } catch {
          /* 忽略 */
        }
      }
    }
  }

  /** 便捷方法：把 UI 上的按钮动作映射为受控迁移。 */
  start(): void {
    this.transition('start');
  }
  requestApproval(): void {
    this.transition('approve');
  }
  finish(): void {
    this.transition('finish');
  }
  fail(): void {
    this.transition('error');
  }
  abort(): void {
    this.transition('abort');
  }
}

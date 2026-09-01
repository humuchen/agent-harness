/**
 * 备忘提醒调度器（进程内定时自触发 + 重启补发）。
 *
 * 背景：agent-harness 当前没有内置 cron / scheduling 子系统（见 examples/scheduled-trigger-plugin.ts）。
 * 备忘提醒用「进程内 setInterval + 重启补发」实现，要点：
 *   - 轮询粒度封顶 15s（避免 remindAt 过于稀疏时错过太久）。
 *   - 到期检测：每次 tick 取 pendingReminders(now)，逐条标记 notified 并触发回调（弹通知）。
 *   - 重启补发：进程重启后（如 Render 杀进程），尚未 notified 且 remindAt 已过的项会被
 *     pendingReminders 自然捞回（notified 持久化在 notes.json，故重启不丢、不会重复提醒）。
 *   - 失败告警：单条提醒触发失败走 onAlert 通道（ctx.events.emit），由核心 alert 桥接 Webhook/日志。
 *   - 时区：remindAt 由调用方按 epoch ms 传入（工具层负责把「明早9点」换算成用户时区的 ms），
 *     调度器与时区无关。
 *
 * 与 scheduled-trigger-plugin 的差异：本调度器不「触发自己跑 agent」，而是「到点后通知用户」，
 * 因此不需要 slot 幂等 / runId 去重，只需按 note.id 的 notified 标志去重即可。
 */

import type { PluginEvent } from '@agent-harness/core';
import { pendingReminders, type MemoNote } from './store';

export interface ReminderFire {
  id: string;
  text: string;
  tag?: string;
  remindAt: number;
}

type FireFn = (r: ReminderFire) => void;
type AlertFn = (e: PluginEvent) => void;

const TICK_MS = 15_000;

export class ReminderScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  /** 本进程内已 fire 过的 id（去重，避免每 tick 反复刷告警）。前端 ack 才真正落盘 notified。 */
  private firedThisProcess = new Set<string>();

  constructor(
    private readonly fire: FireFn,
    private readonly alert: AlertFn,
    private readonly logger: { info: (m: string, f?: Record<string, unknown>) => void; warn: (m: string, f?: Record<string, unknown>) => void },
  ) {}

  /** 启动轮询。立即跑一次以处理「重启错过的提醒」，随后每 TICK_MS 轮询。 */
  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    // 不阻止进程退出（仅一个轻量定时器，无需 ref）。
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  /** 强制立即跑一次轮询（测试 / 手动触发用）。 */
  async triggerNow(): Promise<void> {
    await this.tick();
  }

  /** 停止并清理定时器（onStop 调用）。 */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    if (this.running) return; // 防止上一次没跑完就重叠
    this.running = true;
    try {
      const due = pendingReminders(Date.now());
      for (const n of due) {
        const note = n as MemoNote;
        // 本进程内已 fire 过的不再重复 fire（前端 ack 才落盘 notified，避免刷屏）。
        if (this.firedThisProcess.has(note.id)) continue;
        this.firedThisProcess.add(note.id);
        try {
          this.fire({
            id: note.id,
            text: note.text,
            tag: note.tag,
            remindAt: note.remindAt as number,
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          this.alert({
            type: 'plugin:alert',
            plugin: 'memo',
            reason: 'reminder_fire_failed',
            noteId: note.id,
            error: msg,
          });
          this.logger.warn('memo reminder fire failed', { id: note.id, error: msg });
        }
      }
    } finally {
      this.running = false;
    }
  }
}

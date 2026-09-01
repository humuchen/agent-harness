/**
 * 备忘提醒实时广播总线（进程内 fanout，单实例足够）。
 *
 * 与 chat-bus 同源范式但更轻：memo 数据是单租户全局的（notes.json 无 owner），
 * 提醒事件不需要按用户隔离，因此这里只用一条进程内订阅表，向所有在线连接广播。
 * 多实例部署时如需跨实例转发，可后续接 Redis（与 chat-bus 同款），当前保持零依赖。
 *
 * 事件形状（与 memo 插件 fire 回调约定）：
 *   { type: 'memo:reminder', plugin: 'memo', noteId, text, tag, remindAt }
 * 前端 /api/events SSE 订阅后实时收到，立即弹 ah-notification + 桌面通知。
 */

type ReminderSubscriber = (e: unknown) => void;

// 进程内订阅表：所有在线 SSE 连接。
const subscribers = new Set<ReminderSubscriber>();

/**
 * 广播一条提醒事件给所有订阅者。
 */
export function publishReminder(e: unknown): void {
  for (const fn of [...subscribers]) {
    try {
      fn(e);
    } catch {
      /* 单个订阅者异常不影响其他 */
    }
  }
}

/**
 * 订阅提醒事件流，返回取消订阅函数。
 */
export function subscribeReminders(fn: ReminderSubscriber): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

/** 当前在线连接数（可观测 / 调试用）。 */
export function reminderSubscriberCount(): number {
  return subscribers.size;
}

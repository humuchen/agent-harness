/**
 * 备忘提醒实时广播总线（进程内 fanout，单实例足够）。
 *
 * 与 chat-bus 同源范式但更轻：备忘数据已按 owner（登录用户）落库隔离，
 * 提醒事件携带 owner，只有同 owner 的在线 SSE 连接才收到——跨用户不互见。
 * 多实例部署时如需跨实例转发，可后续接 Redis（与 chat-bus 同款），当前保持零依赖。
 *
 * 事件形状（与 memo 插件 fire 回调约定）：
 *   { type: 'memo:reminder', plugin: 'memo', noteId, text, tag, remindAt, owner }
 * 前端 /api/events SSE 订阅后实时收到，立即弹 ah-notification + 桌面通知。
 */

type ReminderSubscriber = (e: unknown) => void;

interface ReminderConn {
  owner: string;
  /** 订阅者角色：'user' = 普通登录用户（备忘提醒），'service' = 客服（业务提醒）。 */
  role: 'user' | 'service';
  fn: ReminderSubscriber;
}

// 进程内订阅表：每条在线 SSE 连接记录其归属 owner + role，转发时按 owner/role 过滤。
const subscribers = new Set<ReminderConn>();

/**
 * 从事件中读取归属 owner（兼容早期无 owner 字段的事件：视为 'legacy'，
 * 仅推给同样标记为 legacy 的订阅方——即旧客户端/无登录态连接，正常登录用户不会收到）。
 */
function ownerOf(e: unknown): string {
  const o = (e as { owner?: unknown })?.owner;
  return typeof o === 'string' && o ? o : 'legacy';
}

/**
 * 向所有同 owner 订阅者转发一条提醒事件（备忘提醒，按 owner 隔离）。
 */
export function publishReminder(e: unknown): void {
  const owner = ownerOf(e);
  for (const conn of [...subscribers]) {
    if (conn.role !== 'user') continue; // 备忘提醒只推给普通用户
    if (conn.owner !== owner) continue; // 跨用户不互见
    try {
      conn.fn(e);
    } catch {
      /* 单个订阅者异常不影响其他 */
    }
  }
}

/**
 * 向所有指定角色的订阅者转发事件（业务提醒，如客服提醒）。
 * 事件不携带 owner 时推给该角色所有连接。
 */
export function publishToRole(role: 'user' | 'service', e: unknown): void {
  for (const conn of [...subscribers]) {
    if (conn.role !== role) continue;
    try {
      conn.fn(e);
    } catch {
      /* 单个订阅者异常不影响其他 */
    }
  }
}

/**
 * 订阅某 owner 的提醒事件流，返回取消订阅函数。
 * @param owner 归属用户
 * @param fn 回调
 * @param role 角色（默认 'user'）
 */
export function subscribeReminders(
  owner: string,
  fn: ReminderSubscriber,
  role: 'user' | 'service' = 'user'
): () => void {
  const conn: ReminderConn = { owner, role, fn };
  subscribers.add(conn);
  return () => {
    subscribers.delete(conn);
  };
}

/** 当前在线连接数（可观测 / 调试用）。 */
export function reminderSubscriberCount(): number {
  return subscribers.size;
}

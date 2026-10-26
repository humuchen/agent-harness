/**
 * 会话服务：会话生命周期（接待/转接/关闭）。
 * 增强坐席池：handoff 最闲优先自动指派在线坐席；关闭会话释放坐席负载；
 * 支持坐席认领（claim）未指派的 handoff 会话。
 */
import { upsertSession, setSessionStatus, getSession, assignSeat, releaseSeat, oldestUnassignedHandoff, type SessionRow } from '../repo/session-repo';
import { pickLeastBusySeat, getSeat } from '../repo/seat-repo';

/** 记录一次会话接待（幂等创建/更新）。 */
export function touchSession(input: {
  sessionId: string;
  channel?: string;
  customerId?: string;
}): SessionRow {
  return upsertSession(input);
}

/**
 * 转人工：状态置 handoff + 最闲优先自动指派在线坐席（并发上限内）。
 * 无可用坐席时仍转人工（assignedSeat=null，等待坐席上线后认领/手动指派）。
 */
export function handoff(input: { sessionId: string }): SessionRow | null {
  const row = setSessionStatus(input.sessionId, 'handoff');
  if (!row) return null;
  const seat = pickLeastBusySeat();
  if (seat) return assignSeat(input.sessionId, seat.seatId);
  return row;
}

/**
 * 坐席认领：sessionId 提供时指派该会话；缺省自动取最老的未指派 handoff 会话。
 * @throws 会话不存在 / 非 handoff 状态 / 坐席不存在或离线。
 */
export function claim(input: { sessionId?: string; seatId: string }): SessionRow {
  const seat = getSeat(input.seatId);
  if (!seat) throw new Error(`坐席不存在：${input.seatId}`);
  if (seat.status === 'offline') throw new Error(`坐席 ${input.seatId} 处于离线状态，请先上线`);
  const sessionId =
    input.sessionId?.trim() || oldestUnassignedHandoff()?.sessionId;
  if (!sessionId) throw new Error('当前没有等待认领的转人工会话');
  const sess = getSession(sessionId);
  if (!sess) throw new Error(`会话不存在：${sessionId}`);
  if (sess.status !== 'handoff') throw new Error(`会话 ${sessionId} 不在转人工状态（status=${sess.status}）`);
  return assignSeat(sessionId, input.seatId)!;
}

/** 关闭会话（释放坐席负载）。 */
export function close(input: { sessionId: string }): SessionRow | null {
  releaseSeat(input.sessionId);
  return setSessionStatus(input.sessionId, 'closed');
}

/** 取会话。 */
export function session(input: { sessionId: string }): SessionRow | null {
  return getSession(input.sessionId);
}

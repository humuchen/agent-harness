/**
 * 会话服务：会话生命周期（接待/转接/关闭）。
 * 增强坐席池：handoff 最闲优先自动指派在线坐席；关闭会话释放坐席负载。
 */
import { upsertSession, setSessionStatus, getSession, assignSeat, releaseSeat, type SessionRow } from '../repo/session-repo';
import { pickLeastBusySeat } from '../repo/seat-repo';

/** 记录一次会话接待（幂等创建/更新）。 */
export function touchSession(input: {
  sessionId: string;
  channel?: string;
  customerId?: string;
}): SessionRow {
  return upsertSession(input);
}

/**
 * 转人工：状态置 handoff + 最闲优先自动指派在线坐席。
 * 无在线坐席时仍转人工（assignedSeat=null，等待坐席上线后认领/手动指派）。
 */
export function handoff(input: { sessionId: string }): SessionRow | null {
  const row = setSessionStatus(input.sessionId, 'handoff');
  if (!row) return null;
  const seat = pickLeastBusySeat();
  if (seat) return assignSeat(input.sessionId, seat.seatId);
  return row;
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

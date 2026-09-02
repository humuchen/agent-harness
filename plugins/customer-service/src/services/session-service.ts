/**
 * 会话服务：会话生命周期（接待/转接/关闭）。
 */
import { upsertSession, setSessionStatus, getSession, type SessionRow } from '../repo/session-repo';

/** 记录一次会话接待（幂等创建/更新）。 */
export function touchSession(input: {
  sessionId: string;
  channel?: string;
  customerId?: string;
}): SessionRow {
  return upsertSession(input);
}

/** 转人工：将会话状态置为 handoff。 */
export function handoff(input: { sessionId: string }): SessionRow | null {
  return setSessionStatus(input.sessionId, 'handoff');
}

/** 关闭会话。 */
export function close(input: { sessionId: string }): SessionRow | null {
  return setSessionStatus(input.sessionId, 'closed');
}

/** 取会话。 */
export function session(input: { sessionId: string }): SessionRow | null {
  return getSession(input.sessionId);
}

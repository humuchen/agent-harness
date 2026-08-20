/**
 * 渠道入站消息仓储（webhook 落库，去重 + 可重放）。
 *
 * webhook 入口的核心：每条外部消息先落库（UNIQUE(tenant,channel,external_id) 防重放），
 * 再触发 agent。即使下游 agent 处理失败，消息不丢、可重试。
 */

import { getDb, dbCall } from '../infra/db';
import { getConfig } from '../config';

export type InboundState = 'received' | 'dispatched' | 'processed' | 'error';

export interface InboundMessage {
  id: number;
  channel: string;
  externalId: string;
  leadKey: string;
  text: string;
  state: InboundState;
  runId?: string;
  error?: string;
  receivedAt: number;
  processedAt?: number;
}

function rowToInbound(r: Record<string, unknown>): InboundMessage {
  return {
    id: Number(r.id),
    channel: String(r.channel),
    externalId: String(r.external_id),
    leadKey: String(r.lead_key),
    text: String(r.text),
    state: r.state as InboundState,
    runId: (r.run_id as string) ?? undefined,
    error: (r.error as string) ?? undefined,
    receivedAt: Number(r.received_at),
    processedAt: r.processed_at != null ? Number(r.processed_at) : undefined,
  };
}

/**
 * 落库一条入站消息。已存在相同 (channel, external_id) 则返回既有记录（天然去重防重放）。
 */
export function saveInbound(msg: {
  channel: string;
  externalId: string;
  leadKey: string;
  text: string;
}): InboundMessage {
  return dbCall(() => {
    const db = getDb();
    const tid = getConfig().tenantId;
    const existing = db
      .prepare('SELECT * FROM ma_inbound_message WHERE tenant_id = ? AND channel = ? AND external_id = ?')
      .get(tid, msg.channel, msg.externalId);
    if (existing) return rowToInbound(existing);
    db.prepare(
      `INSERT INTO ma_inbound_message (tenant_id, channel, external_id, lead_key, text, state, received_at)
       VALUES (?, ?, ?, ?, ?, 'received', ?)`
    ).run(tid, msg.channel, msg.externalId, msg.leadKey, msg.text, Date.now());
    const row = db
      .prepare('SELECT * FROM ma_inbound_message WHERE tenant_id = ? AND channel = ? AND external_id = ?')
      .get(tid, msg.channel, msg.externalId);
    return rowToInbound(row as Record<string, unknown>);
  }, '落库入站消息');
}

/** 更新入站消息状态机（dispatched→processed/error）。 */
export function markInboundState(id: number, state: InboundState, runId?: string, error?: string): void {
  dbCall(() => {
    const processedAt = state === 'processed' || state === 'error' ? Date.now() : null;
    getDb()
      .prepare(
        `UPDATE ma_inbound_message SET state = ?, run_id = COALESCE(?, run_id), error = ?, processed_at = COALESCE(?, processed_at) WHERE id = ?`
      )
      .run(state, runId ?? null, error ?? null, processedAt, id);
  }, '更新入站消息状态');
}

/**
 * CRM/HIS 同步发件箱 worker（后台轮询，至少一次投递）。
 *
 * 启动于插件 onStart，停止于 onStop/onUnload。每轮扫描到期待投递记录，真实出网投递：
 * - 成功 markSent + 回填线索 CRM 同步状态（synced + crmId）；
 * - 失败 markFailed（指数退避重排），达到上限标记 failed（线索同步状态同步为 failed）。
 * 上游未配置时跳过本轮（积压保留，待配置后 flush），绝不假装已同步。
 */

import { dueBatch, markSent, markFailed, outboxStats } from '../repo/outbox-repo';
import { markCrmSync } from '../repo/lead-repo';
import { setAppointmentExternal } from '../repo/schedule-repo';
import { getConfig } from '../config';
import { CrmClient } from './crm-client';
import { HisClient } from './his-client';
import { MaError } from '../infra/errors';

let timer: NodeJS.Timeout | null = null;

/** 指数退避（毫秒），带抖动。 */
function backoffMs(attempt: number): number {
  const base = Math.min(2000 * 2 ** attempt, 60000);
  return base + Math.floor(Math.random() * 500);
}

async function deliverOne(
  id: number,
  topic: string,
  idempotencyKey: string,
  payload: Record<string, unknown>
): Promise<void> {
  if (topic === 'lead.upsert') {
    const client = new CrmClient(); // 未配置会抛 NOT_CONFIGURED（被外层捕获为失败重试）
    const res = await client.upsertLead(payload as never, idempotencyKey);
    markSent(id);
    if (payload.leadId) markCrmSync(String(payload.leadId), 'synced', res.crmId || undefined);
  } else if (topic === 'appt.create') {
    const client = new HisClient();
    const res = await client.createAppointment(payload as never, idempotencyKey);
    markSent(id);
    // HIS 回执的外部单号 + 状态写回本地预约单（闭合外部同步链路）
    const apptId = (payload as Record<string, unknown>).appointmentId as string | undefined;
    if (res.externalId && apptId) {
      setAppointmentExternal(apptId, res.externalId, 'confirmed');
    }
  } else {
    // 未知 topic：直接标记已发送，避免卡死队列
    markSent(id);
  }
}

async function tick(): Promise<void> {
  const cfg = getConfig();
  if (!cfg.outbox.enabled) return;
  if (!cfg.crm.enabled && !cfg.his.enabled) return; // 无上游可投：跳过（积压保留）
  try {
    const due = dueBatch(cfg.outbox.batchSize, Date.now());
    for (const row of due) {
      try {
        await deliverOne(row.id, row.topic, row.idempotencyKey, row.payload as Record<string, unknown>);
      } catch (e) {
        const msg = e instanceof MaError ? e.message : String(e);
        markFailed(row.id, msg, cfg.outbox.maxAttempts, backoffMs(row.attempts));
        // 达到上限且为线索同步 → 标记线索同步失败
        if (row.attempts + 1 >= cfg.outbox.maxAttempts && row.payload && (row.payload as Record<string, unknown>).leadId) {
          markCrmSync(String((row.payload as Record<string, unknown>).leadId), 'failed');
        }
      }
    }
  } catch {
    /* 单轮异常不阻断下一轮 */
  }
}

/** 启动后台投递（幂等；unref 不阻塞进程退出）。 */
export function startOutboxWorker(): void {
  const cfg = getConfig();
  if (!cfg.outbox.enabled || timer) return;
  timer = setInterval(() => {
    void tick();
  }, cfg.outbox.intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
}

/** 停止后台投递。 */
export function stopOutboxWorker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/** 看板/运维快照：发件箱健康。 */
export function outboxSnapshot(): {
  enabled: boolean;
  crmEnabled: boolean;
  hisEnabled: boolean;
  stats: ReturnType<typeof outboxStats>;
} {
  const cfg = getConfig();
  return {
    enabled: cfg.outbox.enabled,
    crmEnabled: cfg.crm.enabled,
    hisEnabled: cfg.his.enabled,
    stats: outboxStats(),
  };
}

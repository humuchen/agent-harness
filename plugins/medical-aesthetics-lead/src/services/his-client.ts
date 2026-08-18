/**
 * HIS / 预约系统客户端（真实 REST，对应 MA_HIS_* 配置）。
 *
 * 把本地建好的预约单**真实同步**到 HIS（院区/号源/预约的权威来源）。未配置即 fail-closed。
 */

import { HttpClient } from '../infra/http';
import { getConfig } from '../config';
import { notConfigured } from '../infra/errors';

/** 同步到 HIS 的预约单载荷。 */
export interface HisAppointmentSync {
  appointmentId: string;
  tenantId: string;
  leadId: string;
  clinicId: string;
  slotId: string;
  date: string;
  time: string;
}

export class HisClient {
  private readonly client: HttpClient;

  constructor() {
    const cfg = getConfig().his;
    if (!cfg.enabled) throw notConfigured('HIS 预约同步', 'MA_HIS_BASE_URL / MA_HIS_TOKEN');
    this.client = new HttpClient(cfg, 'HIS');
  }

  /** 真实 POST 到 HIS 的 /v1/appointments；返回其侧外部单号。 */
  async createAppointment(payload: HisAppointmentSync, idempotencyKey: string): Promise<{ externalId: string }> {
    const res = await this.client.json<{ id?: string; externalId?: string; appointmentId?: string }>({
      method: 'POST',
      path: '/v1/appointments',
      body: payload,
      idempotencyKey,
    });
    return { externalId: res?.id ?? res?.externalId ?? res?.appointmentId ?? '' };
  }
}

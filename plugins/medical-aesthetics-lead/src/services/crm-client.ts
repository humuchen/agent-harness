/**
 * CRM 同步客户端（真实 REST，对应 MA_CRM_* 配置）。
 *
 * 仅负责把已落本地库的客资**真实投递**到业务主系统（CRM）。未配置即 fail-closed，
 * 由调用方据实标记同步状态，绝不假装成功。
 */

import { HttpClient } from '../infra/http';
import { getConfig } from '../config';
import { notConfigured } from '../infra/errors';

/** 投递到 CRM 的客资载荷（与 ma_lead 关键列对齐；不含对话原文，避免过量隐私出网）。 */
export interface CrmLeadSync {
  leadId: string;
  tenantId: string;
  channel: string;
  intent?: string;
  project?: string;
  budget?: string;
  city?: string;
  grade?: string;
  stage: string;
  name?: string;
  phone?: string;
  wechat?: string;
  clinicId?: string;
  clinicName?: string;
  bookingDate?: string;
  bookingTime?: string;
  appointmentId?: string;
  handedOff?: boolean;
  handoffReason?: string;
}

export class CrmClient {
  private readonly client: HttpClient;

  constructor() {
    const cfg = getConfig().crm;
    if (!cfg.enabled) throw notConfigured('CRM 同步', 'MA_CRM_BASE_URL / MA_CRM_TOKEN');
    this.client = new HttpClient(cfg, 'CRM');
  }

  /** 真实 POST 到 CRM 的 /v1/leads；返回其侧生成的线索 id（幂等键由发件箱保证重投安全）。 */
  async upsertLead(payload: CrmLeadSync, idempotencyKey: string): Promise<{ crmId: string }> {
    const res = await this.client.json<{ id?: string; crmId?: string; leadId?: string }>({
      method: 'POST',
      path: '/v1/leads',
      body: payload,
      idempotencyKey,
    });
    return { crmId: res?.id ?? res?.crmId ?? res?.leadId ?? '' };
  }
}

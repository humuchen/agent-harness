/** 客资域领域模型（与数据库列一一对应，供 repo / service / 看板共用）。 */

export type LeadStage =
  | 'new'
  | 'contacted'
  | 'qualified'
  | 'captured'
  | 'booked'
  | 'arrived'
  | 'deal'
  | 'lost';

export type LeadGrade = 'A' | 'B' | 'C' | 'D';

/** CRM 同步状态：pending 待投递 / synced 已同步 / failed 超过最大重试。 */
export type CrmSyncState = 'pending' | 'synced' | 'failed' | 'disabled';

/** 阶段顺序（漏斗单调方向）。lost 为独立沉淀，不在此序列内。 */
export const STAGE_ORDER: LeadStage[] = [
  'new',
  'contacted',
  'qualified',
  'captured',
  'booked',
  'arrived',
  'deal',
];

/** 阶段序号（用于 reached 单调推进与漏斗累计）。 */
export function stageRank(s: LeadStage): number {
  const i = STAGE_ORDER.indexOf(s);
  return i < 0 ? 0 : i;
}

export interface LeadRecord {
  leadId: string;
  tenantId: string;
  channel: string;
  intent?: string;
  project?: string;
  budget?: string;
  city?: string;
  grade?: LeadGrade;
  stage: LeadStage;
  reached: LeadStage;
  name?: string;
  phone?: string;
  wechat?: string;
  consentAt?: number;
  clinicId?: string;
  clinicName?: string;
  bookingDate?: string;
  bookingTime?: string;
  appointmentId?: string;
  handedOff: boolean;
  handoffReason?: string;
  consultedBy?: string;
  crmId?: string;
  crmSyncState: CrmSyncState;
  crmSyncedAt?: number;
  createdAt: number;
  updatedAt: number;
  /** 关联对话消息（仅明细查询时装载）。 */
  messages?: { role: string; text: string; t: number }[];
}

/** 可更新的线索字段（补丁式 upsert）。 */
export type LeadPatch = Partial<
  Pick<
    LeadRecord,
    | 'channel'
    | 'intent'
    | 'project'
    | 'budget'
    | 'city'
    | 'grade'
    | 'stage'
    | 'name'
    | 'phone'
    | 'wechat'
    | 'consentAt'
    | 'clinicId'
    | 'clinicName'
    | 'bookingDate'
    | 'bookingTime'
    | 'appointmentId'
    | 'handedOff'
    | 'handoffReason'
    | 'consultedBy'
    | 'crmId'
    | 'crmSyncState'
    | 'crmSyncedAt'
  >
>;

export interface LeadStats {
  total: number;
  /** 累计漏斗（reached 口径：booked 亦计入其经过的 qualified/captured）。 */
  funnel: Record<LeadStage, number>;
  channelDist: Record<string, number>;
  gradeDist: Record<string, number>;
  arrived: number;
  deal: number;
  arriveRate: number;
  dealRate: number;
  followupQueue: LeadRecord[];
  handoffQueue: LeadRecord[];
  /** CRM 同步健康（真实同步状态，非假成功）。 */
  crmSync: Record<CrmSyncState, number>;
}

/** 知识库项目条目。 */
export interface ProjectRecord {
  projectId: string;
  name: string;
  category?: string;
  aliases: string[];
  summary: string;
  indications?: string;
  contraindications?: string;
  recovery?: string;
  priceRange?: string;
  faq: { q: string; a?: string }[];
  source?: string;
  /** 是否启用（导入时可置否软删）。缺省 true。 */
  active?: boolean;
  updatedAt: number;
}

export interface ClinicRecord {
  clinicId: string;
  name: string;
  city?: string;
  address?: string;
  phone?: string;
  active: boolean;
}

export interface SlotRecord {
  slotId: string;
  clinicId: string;
  date: string;
  time: string;
  capacity: number;
  booked: number;
  status: 'open' | 'closed';
  doctor?: string;
  /** 剩余可约数。 */
  remaining: number;
}

export interface AppointmentRecord {
  appointmentId: string;
  leadId: string;
  clinicId: string;
  slotId: string;
  date: string;
  time: string;
  status: 'booked' | 'cancelled' | 'arrived' | 'completed';
  externalId?: string;
  externalStatus?: string;
  createdAt: number;
}

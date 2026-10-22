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
  /** 线索阶段最后变更时间戳（用于漏斗留存分析）。 */
  stageUpdatedAt?: number;
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
  /** 客户偏好记忆（P1-⑧ 数据闭环）：沟通渠道偏好 / 项目偏好 / 价格敏感度。 */
  preferences?: LeadPreferences;
  createdAt: number;
  updatedAt: number;
  /** 关联对话消息（仅明细查询时装载）。 */
  messages?: { role: string; text: string; t: number }[];
}

/**
 * 客户偏好记忆（P1-⑧）。
 * - channel：沟通渠道偏好（wecom/sms/phone）。
 * - projects：项目偏好列表（projectId）。
 * - priceSensitivity：价格敏感度 low/mid/high。
 * - notes：自由备注（咨询师填写，非 PII）。
 */
export interface LeadPreferences {
  channel?: string;
  projects?: string[];
  priceSensitivity?: 'low' | 'mid' | 'high';
  notes?: string;
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
    | 'preferences'
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

/** 知识库项目条目。
 *
 * 字段分三组：
 * - 科普描述（summary/indications/contraindications/recovery/priceRange/faq）：对客科普，不含疗效承诺。
 * - 经营/检索增强（intentTags/comboWith/audience/seasonality/durationMin/painLevel/downtimeDays/courseSessions/avgPriceTier）：
 *   用于线索分层、升单推荐与检索召回，内部使用。
 * - 合规与向量（compliantCopy/complianceReviewed/embedding）：合规内建与语义检索。
 */
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

  // —— 经营 / 检索增强字段（P0 结构化扩编） ——
  /** 诉求意图标签（如 面部年轻化 / 祛斑 / 瘦身），用于意图检索与升单组合。 */
  intentTags?: string[];
  /** 推荐联合项目（projectId 列表），用于升单建议。 */
  comboWith?: string[];
  /** 适合人群描述。 */
  audience?: string;
  /** 旺季 / 季节偏好提示。 */
  seasonality?: string;
  /** 单次时长（分钟）。 */
  durationMin?: number;
  /** 疼痛度 1-5（内部参考）。 */
  painLevel?: number;
  /** 停工期说明。 */
  downtimeDays?: string;
  /** 疗程次数说明（如 "3-5 次/疗程"）。 */
  courseSessions?: string;
  /** 客单价档位（如 "入门/中端/高端"），用于分层。 */
  avgPriceTier?: string;

  // —— 合规内建（P1） ——
  /** 对外合规文案：已去除疗效承诺/术前术后对比的合规表述，检索对客优先返回。 */
  compliantCopy?: string;
  /** 是否已过合规复核。未过审则对客不返回疗效类 FAQ，仅返回科普。 */
  complianceReviewed?: boolean;

  // —— 语义检索（P1 hybrid，可空） ——
  /** 项目摘要 embedding（JSON 数组文本列）。未配置嵌入服务时为 null。 */
  embedding?: number[] | null;
}

/** 意图 → 项目 映射条目（knowledge/domain/intent-map.json → ma_project_intent）。 */
export interface IntentMapping {
  intent: string;
  projectId: string;
  /** 命中权重（同意图多项目时排序用）。 */
  weight: number;
  /** 触发该意图的关键词/短语（用于查询时意图归一）。 */
  keywords: string[];
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
  /** 到院时间戳（用于到店转化率分析）。 */
  arrivedAt?: number;
  /** 完成/就诊时间戳（用于成交周期分析）。 */
  completedAt?: number;
  updatedAt: number;
  createdAt: number;
}

/**
 * 话术条目（话术库：场景化接待 / 异议应对话术，合规状态内建）。
 * 三层知识库（话术库 · 案例库 · 项目知识）中缺失的两层之一（P1-⑤）。
 */
export interface ScriptRecord {
  scriptId: string;
  tenantId: string;
  /** 场景：welcome（欢迎接待）/ price_objection（价格异议）/ effect_concern（效果担忧）/ arrival_guide（到院引导）/ post_op（术后关怀）/ generic（通用）。 */
  scene: string;
  /** 适用客户等级（A/B/C/D；空=通用）。 */
  grade?: LeadGrade;
  /** 适用项目（projectId；空=通用）。 */
  project?: string;
  /** 话术标题。 */
  title: string;
  /** 话术正文（合规表述，不含疗效承诺 / 术前术后对比 / 固定价）。 */
  body: string;
  /** 对外合规版本（去疗效承诺，对客优先返回）。 */
  compliantCopy?: string;
  /** 是否已过合规复核。未过审对客不返回疗效类表述。 */
  complianceReviewed: boolean;
  /** 是否启用（软删）。 */
  active: boolean;
  updatedAt: number;
}

/**
 * 案例条目（案例库：脱敏真实成交 / 咨询案例，强制脱敏字段）。
 * 三层知识库缺失的两层之一（P1-⑤）。入库强制 masked=true，绝不含姓名 / 电话 / 院区精确追溯。
 */
export interface CaseRecord {
  caseId: string;
  tenantId: string;
  /** 关联项目（projectId）。 */
  project?: string;
  /** 项目分类。 */
  category?: string;
  /** 诉求意图。 */
  intent?: string;
  /** 脱敏后的案例概述（不含 PII）。 */
  summary: string;
  /** 客户诉求（脱敏）。 */
  concern?: string;
  /** 方案思路（科普级，无疗效承诺 / 诊断）。 */
  approach?: string;
  /** 结果备注（脱敏，如「已完成面诊并制定方案」）。 */
  outcomeNote?: string;
  /** 是否已脱敏（入库强制 true；外发前再校验一次）。 */
  masked: boolean;
  /** 内部引用（如订单 / 线索 ID，仅内部用，绝不外发）。 */
  sourceRef?: string;
  /** 标签（如 术后护理 / 升单 / 复诊）。 */
  tags?: string[];
  updatedAt: number;
}

/**
 * 成交 / 消费订单（P1-⑧ 数据闭环：复购率与真实 ROI 的数据底座）。
 * 原架构缺口：服务履历截至到店，无成交后消费 / 订单表，导致复购率与 ROI 无数据支撑。
 */
export interface OrderRecord {
  orderId: string;
  tenantId: string;
  leadId: string;
  /** 成交项目（projectId）。 */
  project: string;
  /** 项目分类。 */
  category?: string;
  /** 成交金额（按元存储）。 */
  amount: number;
  /** 币种（默认 CNY）。 */
  currency: string;
  /** 订单状态。 */
  status: 'paid' | 'refunded' | 'partial';
  /** 成交院区。 */
  clinicId?: string;
  clinicName?: string;
  /** 成交咨询师。 */
  consultant?: string;
  /** 来源（SOP / 自然 / 转介绍 / 复购）。 */
  source?: string;
  /** 付款时间戳。 */
  paidAt?: number;
  createdAt: number;
  updatedAt: number;
}

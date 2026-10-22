/**
 * 运营分析领域模型。
 *
 * 所有类型都来自真实 SQL 聚合，零模拟数据。
 */

/** 漏斗阶段统计（各阶段人数 + 平均到达耗时）。 */
export interface FunnelAnalysis {
  stage: string;
  count: number;
  percentage: number;
  avgHoursToNext?: number;
}

/** 渠道业绩分析。 */
export interface ChannelPerformance {
  channel: string;
  leadCount: number;
  qualifiedCount: number;
  capturedCount: number;
  bookedCount: number;
  arrivedCount: number;
  dealCount: number;
  qualifyRate: number;
  captureRate: number;
  bookingRate: number;
  arrivalRate: number;
  dealRate: number;
}

/** 院区业绩分析。 */
export interface ClinicPerformance {
  clinicId: string;
  clinicName: string;
  city: string;
  bookedCount: number;
  arrivedCount: number;
  dealCount: number;
  arrivalRate: number;
  dealRate: number;
  slotUtilization: number;
}

/** 项目毛利估算（基于价格区间 + 成交记录）。 */
export interface ProjectProfitability {
  project: string;
  leadCount: number;
  bookedCount: number;
  dealCount: number;
  priceRange: string;
  estimatedRevenue: number;
}

/** 时间趋势（按日/按周）。 */
export interface TimeTrendPoint {
  period: string;
  leadCount: number;
  bookedCount: number;
  arrivedCount: number;
  dealCount: number;
}

/** 留存分析（阶段耗时分布）。 */
export interface StageRetention {
  stage: string;
  avgHours: number;
  p50Hours: number;
  p90Hours: number;
  count: number;
}

/** 分析查询参数。 */
export interface AnalyticsQuery {
  /** 分析类型。 */
  type: 'funnel' | 'channel' | 'clinic' | 'project' | 'trend' | 'retention' | 'inactive' | 'repurchase' | 'roi' | 'full';
  /** 租户 ID。 */
  tenantId?: string;
  /** 时间范围（毫秒时间戳）。 */
  startTime?: number;
  /** 时间范围（毫秒时间戳）。 */
  endTime?: number;
  /** 渠道过滤。 */
  channel?: string;
  /** 院区过滤。 */
  clinicId?: string;
  /** 项目过滤。 */
  project?: string;
  /** 聚合周期（trend 类型）。'day' | 'week' | 'month'。 */
  period?: 'day' | 'week' | 'month';
  /** 未活跃阈值天数（inactive 类型）。默认 14。 */
  daysThreshold?: number;
}

/** 分析结果（联合类型）。 */
export interface AnalyticsResult {
  query: AnalyticsQuery;
  generatedAt: number;
  data: FunnelAnalysis[] | ChannelPerformance[] | ClinicPerformance[] | ProjectProfitability[] | TimeTrendPoint[] | StageRetention[] | InactiveLead[] | RepurchaseAnalysis | RoiAnalysis | AnalyticsFullResult;
}

/** full 类型的结果（所有分析集合）。 */
export interface AnalyticsFullResult {
  funnel: FunnelAnalysis[];
  channel: ChannelPerformance[];
  clinic: ClinicPerformance[];
  project: ProjectProfitability[];
  trend: TimeTrendPoint[];
  retention: StageRetention[];
}

/** 未活跃线索（最后到院/咨询超过 N 天）。 */
export interface InactiveLead {
  leadId: string;
  name: string | null;
  phone: string | null;
  project: string | null;
  lastVisit: string | null;
  daysSince: number;
  activityTitle: string | null;
  activityId: string | null;
}

/** 复购率分析（P1-⑧：基于 ma_order 真实成交数据）。 */
export interface RepurchaseAnalysis {
  /** 成交客户数（去重 leadId）。 */
  customerCount: number;
  /** 订单总数（paid）。 */
  orderCount: number;
  /** 复购客户数（同一 leadId 多笔 paid 订单）。 */
  repurchaseCustomers: number;
  /** 复购率 = 复购客户数 / 成交客户数（%）。 */
  repurchaseRate: number;
  /** 分项目成交金额与订单数（用于交叉分析）。 */
  byProject: Array<{ project: string; revenue: number; orders: number }>;
}

/**
 * ROI 分析（P1-⑧/⑨）。
 * 成交金额来自 ma_order；广告花费来自 ma_ad_spend（P1-⑨ 落地：可经投放平台 API 拉取或
 * POST /ad-spend/import 手动导入）。在花费无数据时 roi/cpl 为 null 且 spendConnected=false，
 * 绝不虚构 ROI 数值（fail-closed 纪律）。
 */
export interface RoiAnalysis {
  /** 总成交金额（paid）。 */
  totalRevenue: number;
  orderCount: number;
  /** 复购率（%）。 */
  repurchaseRate: number;
  /** 是否有广告花费数据（true 时 adSpend/roi/cpl 为真实值）。 */
  spendConnected: boolean;
  /** 广告花费（元）。无数据为 null。 */
  adSpend: number | null;
  /** ROI = 总成交金额 / 广告花费。无花费数据为 null。 */
  roi: number | null;
  /** 单条留资成本 = 广告花费 / 转化数（元）。无花费或无转化为 null。 */
  cpl: number | null;
  /** 花费侧曝光/点击/转化合计（无数据时全 0）。 */
  spendMetrics: { impressions: number; clicks: number; conversions: number };
  /** 分渠道花费与转化（无数据时空数组）。 */
  byChannel: Array<{ channel: string; spend: number; clicks: number; conversions: number }>;
  note: string;
}

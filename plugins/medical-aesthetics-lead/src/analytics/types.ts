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
  type: 'funnel' | 'channel' | 'clinic' | 'project' | 'trend' | 'retention' | 'full';
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
}

/** 分析结果（联合类型）。 */
export interface AnalyticsResult {
  query: AnalyticsQuery;
  generatedAt: number;
  data: FunnelAnalysis[] | ChannelPerformance[] | ClinicPerformance[] | ProjectProfitability[] | TimeTrendPoint[] | StageRetention[] | AnalyticsFullResult;
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

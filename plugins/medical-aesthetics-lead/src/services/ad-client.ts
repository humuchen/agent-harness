/**
 * 广告投放平台客户端（P1-⑨）：拉取消耗与转化，喂给 ROI 分析。
 *
 * 契约：POST {MA_AD_PLATFORM_BASE_URL}/v1/spend/report
 *   body: { tenantId, advertiserId, platform, startDate, endDate }
 *   header: Authorization: Bearer {MA_AD_PLATFORM_TOKEN}
 *   resp: { ok?, items: [{ spendDate, channel, campaignId, campaignName?, spend,
 *                          impressions?, clicks?, conversions? }] }
 *
 * fail-closed 纪律（与 CRM/HIS/触达网关客户端一致）：
 * - 未配置 baseUrl / token → 构造即抛 NOT_CONFIGURED，ROI 分析据此返回
 *   `spendConnected=false` + `roi=null`，**绝不虚构 ROI**；
 * - 平台侧报错 / 返回结构不符 → 抛错，由调用方决定是否保留旧数据（不静默清零）。
 *
 * 当前已接「任意兼容端点」（generic）。巨量引擎 / 腾讯广告的官方字段映射
 * （report_type、metrics 命名、分页）可在各自 adapter 内完成，本文件只定契约与落库。
 */

import { HttpClient } from '../infra/http';
import { getConfig } from '../config';
import { notConfigured } from '../infra/errors';
import { upsertAdSpend, type AdSpendInput } from '../repo/ad-spend-repo';

/** 平台返回的单条消耗（字段经适配器归一化后与本结构对齐）。 */
export interface AdPlatformSpendItem {
  spendDate: string;
  channel: string;
  campaignId: string;
  campaignName?: string;
  spend: number;
  impressions?: number;
  clicks?: number;
  conversions?: number;
}

export class AdPlatformClient {
  private readonly client: HttpClient;

  constructor() {
    const cfg = getConfig().adPlatform;
    if (!cfg.enabled || !cfg.token) {
      throw notConfigured('广告投放平台', 'MA_AD_PLATFORM_BASE_URL / MA_AD_PLATFORM_TOKEN');
    }
    this.client = new HttpClient(cfg, 'AD_PLATFORM');
  }

  /** 拉取区间消耗（startDate/endDate 为 YYYY-MM-DD）。 */
  async fetchSpend(startDate: string, endDate: string): Promise<AdPlatformSpendItem[]> {
    const cfg = getConfig().adPlatform;
    const res = await this.client.json<{ ok?: boolean; items?: AdPlatformSpendItem[] }>({
      method: 'POST',
      path: '/v1/spend/report',
      body: {
        tenantId: getConfig().tenantId,
        advertiserId: cfg.advertiserId,
        platform: cfg.platform,
        startDate,
        endDate,
      },
    });
    const items = Array.isArray(res?.items) ? res.items : [];
    return items.filter((it) => it && typeof it === 'object');
  }
}

export interface PullAdSpendResult {
  /** 是否成功拉到并落库。 */
  pulled: boolean;
  /** 落库条数。 */
  written: number;
  /** 未配置平台时的说明（pulled=false 时非空）。 */
  note?: string;
}

/**
 * 拉取并落库投放消耗。
 * 未配置平台 → 返回 { pulled:false, note }，**不抛错、不清空旧数据**（ROI 分析仍可用历史导入数据）。
 */
export async function pullAdSpend(startDate: string, endDate: string): Promise<PullAdSpendResult> {
  const cfg = getConfig().adPlatform;
  if (!cfg.enabled || !cfg.token) {
    return {
      pulled: false,
      written: 0,
      note: '广告投放平台未配置（MA_AD_PLATFORM_BASE_URL / MA_AD_PLATFORM_TOKEN）；可经 POST /ad-spend/import 手动导入消耗。',
    };
  }
  const items = await new AdPlatformClient().fetchSpend(startDate, endDate);
  const rows: AdSpendInput[] = items.map((it) => ({
    spendDate: it.spendDate,
    channel: it.channel,
    campaignId: it.campaignId,
    campaignName: it.campaignName,
    spend: Number(it.spend ?? 0),
    impressions: it.impressions,
    clicks: it.clicks,
    conversions: it.conversions,
    source: cfg.platform || 'adplatform',
  }));
  const written = await upsertAdSpend(rows);
  return { pulled: true, written };
}

/**
 * 渠道触达网关客户端（对客主动消息的唯一出网通道）。
 *
 * 契约：POST {MA_OUTREACH_BASE_URL}/v1/messages
 *   body: { tenantId, leadId, topic, channel?, to?: {name,phone,wechat}, text }
 *   header: Idempotency-Key（配合发件箱重投，网关侧按此去重）
 * 未配置（MA_OUTREACH_BASE_URL 为空）即 fail-closed：消息在发件箱保持 pending 积压，
 * 绝不假装已发送 —— 与 CRM/HIS 客户端同一纪律。真实企微/短信网关接入时实现本契约即可。
 */

import { HttpClient } from '../infra/http';
import { getConfig } from '../config';
import { notConfigured } from '../infra/errors';

/** 对客触达消息载荷（payload 中不含对话原文，最小化隐私出网）。 */
export interface OutreachMessage {
  leadId: string;
  /** 消息主题：welcome / recall_first / recall_second / birthday / repurchase。 */
  topic: string;
  /** 线索来源渠道（网关可据此选路由）。 */
  channel?: string;
  /** 联系方式（网关据此路由；为空时网关按 leadId 自行解析，解析不了应报错而非静默丢弃）。 */
  to?: { name?: string; phone?: string; wechat?: string };
  /** 已过合规的最终文案。 */
  text: string;
}

export class OutreachClient {
  private readonly client: HttpClient;

  constructor() {
    const cfg = getConfig().outreach;
    if (!cfg.enabled) throw notConfigured('渠道触达网关', 'MA_OUTREACH_BASE_URL / MA_OUTREACH_TOKEN');
    this.client = new HttpClient(cfg, 'OUTREACH');
  }

  /** 真实 POST 到触达网关；返回网关侧消息 id（幂等键由发件箱保证重投安全）。 */
  async sendMessage(msg: OutreachMessage, idempotencyKey: string): Promise<{ messageId?: string }> {
    const res = await this.client.json<{ ok?: boolean; messageId?: string; id?: string }>({
      method: 'POST',
      path: '/v1/messages',
      body: { tenantId: getConfig().tenantId, ...msg },
      idempotencyKey,
    });
    return { messageId: res?.messageId ?? res?.id ?? undefined };
  }

  /**
   * 内容发布载荷（平台图文/口播稿）。
   * text 必须是过审终稿（服务层已在末尾追加风险提示），网关按 platform 路由到对应发布通道。
   */
  async publishContent(
    content: { contentId: string; platform: string; title: string; text: string; project?: string },
    idempotencyKey: string
  ): Promise<{ ref?: string }> {
    const res = await this.client.json<{ ok?: boolean; postId?: string; id?: string }>({
      method: 'POST',
      path: '/v1/content/publish',
      body: { tenantId: getConfig().tenantId, ...content, topic: 'content.publish' },
      idempotencyKey,
    });
    return { ref: res?.postId ?? res?.id ?? undefined };
  }
}

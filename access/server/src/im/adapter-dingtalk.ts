/**
 * 钉钉（DingTalk）IM 适配器。
 *
 * 覆盖：
 * 1) 签名校验：钉钉回调携带 `timestamp` + `sign` 头，
 *    `sign = base64(HMAC-SHA256(timestamp + "\n" + appSecret, appSecret))`。
 * 2) 消息解析：HTTP 回调体（conversationType 1=单聊 / 2=群聊），文本在 `text.content`。
 * 3) 回复：优先用事件自带的 `sessionWebhook`（临时 webhook，有效期约 1.5h）直接回，
 *    零 access_token 管理；webhook 缺失/过期时回落到机器人主动发消息 API。
 *
 * 注：钉钉 HTTP 回调无 URL 验证握手（与飞书不同），故 handleChallenge 恒为未命中。
 */

import { createHmac } from 'node:crypto';
import type { ImAdapter, ImChallengeResult, ImInboundMessage, ImProvider } from './types';

const DINGTALK_API = 'https://api.dingtalk.com';

/** 钉钉回调事件体（仅声明用到的字段）。 */
interface DingtalkEvent {
  msgId?: string;
  msgtype?: string;
  conversationId?: string;
  conversationType?: string; // '1' 单聊 | '2' 群聊
  senderId?: string;
  senderStaffId?: string;
  senderNick?: string;
  sessionWebhook?: string;
  sessionWebhookExpiredTime?: number;
  text?: { content?: string };
  isInAtList?: boolean;
  chatbotUserId?: string;
}

export interface DingtalkOptions {
  /** 应用 AppKey（Client ID）。 */
  clientId: string;
  /** 应用 AppSecret（Client Secret），同时用作回调签名密钥。 */
  clientSecret: string;
  /** 机器人编码（主动发消息 API 需要；仅 sessionWebhook 回复时可不填）。 */
  robotCode?: string;
  /** API base URL（默认官方 api.dingtalk.com；可覆盖以便私有化部署或端到端验证打桩）。 */
  baseUrl?: string;
}

export class DingtalkAdapter implements ImAdapter {
  readonly provider: ImProvider = 'dingtalk';
  private readonly opt: DingtalkOptions;
  private tokenCache: { value: string; expireAt: number } | null = null;

  constructor(opt: DingtalkOptions) {
    this.opt = opt;
  }

  /** 实际使用的 API base（env 覆盖优先）。 */
  private get base(): string {
    return this.opt.baseUrl || DINGTALK_API;
  }

  isConfigured(): boolean {
    return Boolean(this.opt.clientId && this.opt.clientSecret);
  }

  missingConfig(): string[] {
    const miss: string[] = [];
    if (!this.opt.clientId) miss.push('IM_DINGTALK_CLIENT_ID');
    if (!this.opt.clientSecret) miss.push('IM_DINGTALK_CLIENT_SECRET');
    return miss;
  }

  private headerValue(
    headers: Record<string, string | string[] | undefined>,
    name: string
  ): string {
    const v = headers[name] ?? headers[name.toLowerCase()];
    return Array.isArray(v) ? v[0] ?? '' : v ?? '';
  }

  verifyInbound(req: {
    headers: Record<string, string | string[] | undefined>;
    rawBody: string;
    url: URL;
  }): boolean {
    const timestamp = this.headerValue(req.headers, 'timestamp');
    const sign = this.headerValue(req.headers, 'sign');
    if (!timestamp || !sign) return false;
    const expected = createHmac('sha256', this.opt.clientSecret)
      .update(`${timestamp}\n${this.opt.clientSecret}`, 'utf8')
      .digest('base64');
    return safeEqual(expected, sign);
  }

  handleChallenge(): ImChallengeResult {
    // 钉钉 HTTP 回调无 challenge 握手。
    return { handled: false };
  }

  parseInbound(rawBody: string): ImInboundMessage | null {
    let ev: DingtalkEvent;
    try {
      ev = JSON.parse(rawBody) as DingtalkEvent;
    } catch {
      return null;
    }
    if (ev.msgtype !== 'text' || !ev.text?.content) return null;
    const senderId = ev.senderStaffId || ev.senderId || '';
    if (!senderId) return null;
    const isGroup = ev.conversationType === '2';
    return {
      provider: 'dingtalk',
      messageId: ev.msgId ?? '',
      senderId,
      senderName: ev.senderNick,
      chatId: ev.conversationId ?? senderId,
      isGroup,
      // 钉钉在事件里直接给出 isInAtList（群聊是否 @ 了机器人）；单聊恒为 true。
      mentionedBot: isGroup ? ev.isInAtList === true : true,
      text: ev.text.content.replace(/@\S+/g, '').trim(),
      raw: ev
    };
  }

  /** 取企业内部应用 access_token（仅 sessionWebhook 不可用时才需要）。 */
  private async accessToken(): Promise<string> {
    const now = Date.now();
    if (this.tokenCache && this.tokenCache.expireAt > now) return this.tokenCache.value;
    const res = await fetch(`${this.base}/v1.0/oauth2/accessToken`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appKey: this.opt.clientId, appSecret: this.opt.clientSecret })
    });
    const data = (await res.json()) as { accessToken?: string; expireIn?: number; message?: string };
    if (!data.accessToken) {
      throw new Error(`dingtalk: accessToken 获取失败：${data.message ?? res.status}`);
    }
    const ttl = ((data.expireIn ?? 7200) - 300) * 1000;
    this.tokenCache = { value: data.accessToken, expireAt: now + Math.max(ttl, 60_000) };
    return data.accessToken;
  }

  async sendText(target: ImInboundMessage, text: string): Promise<void> {
    const ev = (target.raw ?? {}) as DingtalkEvent;
    const webhook = ev.sessionWebhook;
    const notExpired =
      !ev.sessionWebhookExpiredTime || ev.sessionWebhookExpiredTime > Date.now();
    // 路径 1：sessionWebhook 直回（首选，免 token）。
    if (webhook && notExpired) {
      const res = await fetch(webhook, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ msgtype: 'text', text: { content: text } })
      });
      if (res.ok) return;
      // 落到路径 2。
    }
    // 路径 2：机器人主动发消息（需 robotCode）。
    if (!this.opt.robotCode) {
      throw new Error('dingtalk: sessionWebhook 不可用且未配置 IM_DINGTALK_ROBOT_CODE，无法主动回复');
    }
    const token = await this.accessToken();
    const res = await fetch(`${this.base}/v1.0/robot/oToMessages/batchSend`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-acs-dingtalk-access-token': token
      },
      body: JSON.stringify({
        robotCode: this.opt.robotCode,
        userIds: [target.senderId],
        msgKey: 'sampleText',
        msgParam: JSON.stringify({ content: text })
      })
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`dingtalk: 发送消息失败 ${res.status} ${body.slice(0, 200)}`);
    }
  }
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

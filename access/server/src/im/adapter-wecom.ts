/**
 * 企业微信（WeCom）IM 适配器。
 *
 * 覆盖：
 * 1) URL 验证握手：配置回调地址时企业微信发 GET `?msg_signature&timestamp&nonce&echostr`，
 *    需解密 echostr 后**原样返回明文**。
 * 2) 签名校验：`msg_signature = sha1(sort([token, timestamp, nonce, echostr|encrypt]).join(''))`。
 * 3) 消息解析：POST body 为 XML（`<Encrypt>` 密文），AES-256-CBC 解密后得
 *    `random(16) + msgLen(4, 大端) + msg(XML) + receiveId` 结构，再从 msg XML 取文本。
 * 4) 回复：`access_token` + `POST /cgi-bin/message/send`（主动发消息）。
 *
 * 加密细节与官方 SDK 一致：key = base64decode(EncodingAESKey + "=")（32 字节），
 * IV = key 前 16 字节，PKCS7 填充 —— 全部用 Node 内置 crypto，零新增依赖。
 */

import { createHash, createDecipheriv } from 'node:crypto';
import type { ImAdapter, ImChallengeResult, ImInboundMessage, ImProvider } from './types';

const WECOM_API = 'https://qyapi.weixin.qq.com/cgi-bin';

export interface WecomOptions {
  corpId: string;
  agentId: string;
  /** 应用 Secret（用于换 access_token）。 */
  secret: string;
  /** 回调配置里的 Token。 */
  token: string;
  /** 回调配置里的 EncodingAESKey（43 位）。 */
  aesKey: string;
}

export class WecomAdapter implements ImAdapter {
  readonly provider: ImProvider = 'wecom';
  private readonly opt: WecomOptions;
  private tokenCache: { value: string; expireAt: number } | null = null;

  constructor(opt: WecomOptions) {
    this.opt = opt;
  }

  isConfigured(): boolean {
    return Boolean(this.opt.corpId && this.opt.secret && this.opt.token && this.opt.aesKey);
  }

  missingConfig(): string[] {
    const miss: string[] = [];
    if (!this.opt.corpId) miss.push('IM_WECOM_CORP_ID');
    if (!this.opt.secret) miss.push('IM_WECOM_SECRET');
    if (!this.opt.token) miss.push('IM_WECOM_TOKEN');
    if (!this.opt.aesKey) miss.push('IM_WECOM_AES_KEY');
    if (!this.opt.agentId) miss.push('IM_WECOM_AGENT_ID');
    return miss;
  }

  /** 计算官方签名：sha1(sort([token, timestamp, nonce, payload]).join(''))。 */
  private signature(timestamp: string, nonce: string, payload: string): string {
    const arr = [this.opt.token, timestamp, nonce, payload].sort();
    return createHash('sha1').update(arr.join(''), 'utf8').digest('hex');
  }

  /** AES-256-CBC 解密（去 PKCS7 填充），返回明文串。 */
  private decrypt(encrypted: string): string {
    const key = Buffer.from(this.opt.aesKey + '=', 'base64');
    const iv = key.subarray(0, 16);
    const decipher = createDecipheriv('aes-256-cbc', key, iv);
    decipher.setAutoPadding(false);
    const buf = Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64')), decipher.final()]);
    const pad = buf[buf.length - 1] ?? 0;
    const unpadded = pad > 0 && pad <= 32 ? buf.subarray(0, buf.length - pad) : buf;
    // 企业微信明文结构：random(16) + msgLen(4, 大端) + msg + receiveId。
    const msgLen = unpadded.readUInt32BE(16);
    return unpadded.subarray(20, 20 + msgLen).toString('utf8');
  }

  handleChallenge(req: {
    headers: Record<string, string | string[] | undefined>;
    rawBody: string;
    url: URL;
  }): ImChallengeResult {
    const echostr = req.url.searchParams.get('echostr');
    if (!echostr) return { handled: false };
    const timestamp = req.url.searchParams.get('timestamp') ?? '';
    const nonce = req.url.searchParams.get('nonce') ?? '';
    const msgSignature = req.url.searchParams.get('msg_signature') ?? '';
    // 先验签，再解密——避免对伪造请求做无谓解密。
    if (!safeEqual(this.signature(timestamp, nonce, echostr), msgSignature)) {
      return { handled: false };
    }
    try {
      const plain = this.decrypt(echostr);
      return { handled: true, body: plain, contentType: 'text/plain; charset=utf-8' };
    } catch {
      return { handled: false };
    }
  }

  verifyInbound(req: {
    headers: Record<string, string | string[] | undefined>;
    rawBody: string;
    url: URL;
  }): boolean {
    const timestamp = req.url.searchParams.get('timestamp') ?? '';
    const nonce = req.url.searchParams.get('nonce') ?? '';
    const msgSignature = req.url.searchParams.get('msg_signature') ?? '';
    if (!timestamp || !nonce || !msgSignature) return false;
    const encrypt = extractXmlTag(req.rawBody, 'Encrypt');
    if (!encrypt) return false;
    return safeEqual(this.signature(timestamp, nonce, encrypt), msgSignature);
  }

  parseInbound(rawBody: string): ImInboundMessage | null {
    const encrypt = extractXmlTag(rawBody, 'Encrypt');
    if (!encrypt) return null;
    let xml: string;
    try {
      xml = this.decrypt(encrypt);
    } catch {
      return null;
    }
    const msgType = extractXmlTag(xml, 'MsgType');
    if (msgType !== 'text') return null;
    const content = extractXmlTag(xml, 'Content');
    const fromUser = extractXmlTag(xml, 'FromUserName');
    const msgId = extractXmlTag(xml, 'MsgId') || extractXmlTag(xml, 'MsgID');
    if (!fromUser || content == null) return null;
    // 群聊判定：企业微信群聊回调额外携带 <ChatId>（应用创建的群 / 应用所在群）。
    const chatId = extractXmlTag(xml, 'ChatId');
    const isGroup = Boolean(chatId);
    return {
      provider: 'wecom',
      messageId: msgId ?? '',
      senderId: fromUser,
      chatId: isGroup ? chatId! : fromUser,
      isGroup,
      // 企业微信回调**不提供 @ 标记**（与飞书 mentions / 钉钉 isInAtList 不同）：
      // 群聊消息能回调到应用本身即表示命中（平台侧已按 @ 过滤），故恒视为已 @，
      // 避免 IM_GROUP_REQUIRE_MENTION 误拦掉全部群聊消息。
      mentionedBot: true,
      text: content.trim(),
      raw: { msgType, fromUser, chatId }
    };
  }

  private async accessToken(): Promise<string> {
    const now = Date.now();
    if (this.tokenCache && this.tokenCache.expireAt > now) return this.tokenCache.value;
    const url =
      `${WECOM_API}/gettoken?corpid=${encodeURIComponent(this.opt.corpId)}` +
      `&corpsecret=${encodeURIComponent(this.opt.secret)}`;
    const res = await fetch(url);
    const data = (await res.json()) as { access_token?: string; expires_in?: number; errmsg?: string };
    if (!data.access_token) {
      throw new Error(`wecom: access_token 获取失败：${data.errmsg ?? res.status}`);
    }
    const ttl = ((data.expires_in ?? 7200) - 300) * 1000;
    this.tokenCache = { value: data.access_token, expireAt: now + Math.max(ttl, 60_000) };
    return data.access_token;
  }

  async sendText(target: ImInboundMessage, text: string): Promise<void> {
    const token = await this.accessToken();
    // 群聊 → appchat/send（按 chatid 发到群）；单聊 → message/send（按 touser 发给个人）。
    // 注意：企业微信「应用群聊」要求群由应用创建（appchat/create）；对普通客户群 / 内部群，
    // 平台不允许自建应用直接发言 —— 此时接口返回 errcode != 0，桥接记录告警（不影响主流程）。
    const isGroup = target.isGroup;
    const url = isGroup
      ? `${WECOM_API}/appchat/send?access_token=${token}`
      : `${WECOM_API}/message/send?access_token=${token}`;
    const body = isGroup
      ? { chatid: target.chatId, msgtype: 'text', text: { content: text } }
      : {
          touser: target.senderId,
          msgtype: 'text',
          agentid: Number(this.opt.agentId) || this.opt.agentId,
          text: { content: text }
        };
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body)
    });
    const data = (await res.json().catch(() => ({}))) as { errcode?: number; errmsg?: string };
    if (!res.ok || (data.errcode != null && data.errcode !== 0)) {
      throw new Error(
        `wecom: 发送消息失败（${isGroup ? '群聊 appchat' : '单聊 message'}）${res.status} ${data.errmsg ?? ''}`
      );
    }
  }
}

/** 从 XML 串里提取指定标签的文本内容（企业微信回调结构简单，正则足够且零依赖）。 */
export function extractXmlTag(xml: string, tag: string): string | null {
  // CDATA 与普通文本两种形态。
  const cdata = new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>`).exec(xml);
  if (cdata) return cdata[1] ?? '';
  const plain = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  return plain ? plain[1] ?? '' : null;
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

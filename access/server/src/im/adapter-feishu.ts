/**
 * 飞书（Lark）IM 适配器。
 *
 * 覆盖三件事：
 * 1) URL 验证握手：配置回调地址时飞书发 `{"type":"url_verification","challenge":"..."}`，
 *    需原样回 `{"challenge":"..."}` 才认为地址有效。
 * 2) 事件签名校验：`X-Lark-Signature = sha256(timestamp + nonce + encryptKey + rawBody)`
 *    （配了 Encrypt Key 时）；未配 Encrypt Key 时回落到校验 body 内的 verification token。
 *    这是 webhook 入口唯一安全闸门（IM 侧无用户登录态）。
 * 3) 主动发消息：`tenant_access_token` + `POST /open-apis/im/v1/messages`。
 *
 * 内容加密：飞书开启加密后 body 为 `{"encrypt":"<base64>"}`，用 AES-256-CBC 解密
 * （key = sha256(encryptKey)，IV = key[0:16]）—— 与官方 SDK 同算法，Node 内置 crypto 实现，
 * 零新增依赖。
 */

import { createHash, createDecipheriv } from 'node:crypto';
import type { ImAdapter, ImChallengeResult, ImInboundMessage, ImProvider } from './types';

const FEISHU_BASE = 'https://open.feishu.cn/open-apis';

/** 飞书事件信封（仅声明用到的字段）。 */
interface FeishuEnvelope {
  type?: string;
  challenge?: string;
  token?: string;
  encrypt?: string;
  schema?: string;
  header?: {
    event_id?: string;
    event_type?: string;
    token?: string;
    create_time?: string;
  };
  event?: {
    sender?: {
      sender_id?: { open_id?: string; user_id?: string; union_id?: string };
      sender_type?: string;
    };
    message?: {
      message_id?: string;
      chat_id?: string;
      chat_type?: string; // 'p2p' | 'group'
      message_type?: string; // 'text' | 'image' | ...
      content?: string; // JSON 字符串，text 时为 {"text":"..."}
      mentions?: Array<{ key?: string; name?: string; id?: { open_id?: string } }>;
    };
  };
}

export interface FeishuOptions {
  appId: string;
  appSecret: string;
  verificationToken: string;
  encryptKey?: string;
  /** 机器人自身 open_id（群聊 @ 判定用；缺省时用 mentions 是否存在兜底）。 */
  botOpenId?: string;
}

export class FeishuAdapter implements ImAdapter {
  readonly provider: ImProvider = 'feishu';
  private readonly opt: FeishuOptions;
  /** tenant_access_token 缓存（飞书有效期 2h，提前 5 分钟刷新）。 */
  private tokenCache: { value: string; expireAt: number } | null = null;

  constructor(opt: FeishuOptions) {
    this.opt = opt;
  }

  isConfigured(): boolean {
    return Boolean(this.opt.appId && this.opt.appSecret && this.opt.verificationToken);
  }

  missingConfig(): string[] {
    const miss: string[] = [];
    if (!this.opt.appId) miss.push('IM_FEISHU_APP_ID');
    if (!this.opt.appSecret) miss.push('IM_FEISHU_APP_SECRET');
    if (!this.opt.verificationToken) miss.push('IM_FEISHU_VERIFICATION_TOKEN');
    return miss;
  }

  /** 用 AES-256-CBC 解密 `{"encrypt": ...}` 信封，返回明文 JSON 串；未加密则原样返回。 */
  private decryptEnvelope(rawBody: string): string {
    let parsed: FeishuEnvelope;
    try {
      parsed = JSON.parse(rawBody) as FeishuEnvelope;
    } catch {
      return rawBody;
    }
    if (!parsed.encrypt) return rawBody;
    if (!this.opt.encryptKey) {
      // 收到加密体但未配 Encrypt Key：无法解密，交由上层按解析失败处理（并告警）。
      throw new Error('feishu: received encrypted event but IM_FEISHU_ENCRYPT_KEY is not configured');
    }
    const key = createHash('sha256').update(this.opt.encryptKey, 'utf8').digest();
    const iv = key.subarray(0, 16);
    const buf = Buffer.from(parsed.encrypt, 'base64');
    const decipher = createDecipheriv('aes-256-cbc', key, iv);
    decipher.setAutoPadding(false);
    const decrypted = Buffer.concat([decipher.update(buf), decipher.final()]);
    // 去除 PKCS7 padding（飞书沿用 16 字节块填充）。
    const pad = decrypted[decrypted.length - 1] ?? 0;
    const body = pad > 0 && pad <= 16 ? decrypted.subarray(0, decrypted.length - pad) : decrypted;
    return body.toString('utf8');
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
    const timestamp = this.headerValue(req.headers, 'x-lark-request-timestamp');
    const nonce = this.headerValue(req.headers, 'x-lark-request-nonce');
    const signature = this.headerValue(req.headers, 'x-lark-signature');
    // 1) 配了 Encrypt Key：用官方签名算法（sha256(timestamp + nonce + encryptKey + body)）。
    if (this.opt.encryptKey) {
      if (!timestamp || !nonce || !signature) return false;
      const expected = createHash('sha256')
        .update(timestamp + nonce + this.opt.encryptKey + req.rawBody, 'utf8')
        .digest('hex');
      return safeEqual(expected, signature);
    }
    // 2) 未配 Encrypt Key：回落到校验 body 内的 verification token（解密后）。
    try {
      const plain = this.decryptEnvelope(req.rawBody);
      const parsed = JSON.parse(plain) as FeishuEnvelope;
      const token = parsed.token ?? parsed.header?.token ?? '';
      return Boolean(token) && safeEqual(this.opt.verificationToken, token);
    } catch {
      return false;
    }
  }

  handleChallenge(req: {
    headers: Record<string, string | string[] | undefined>;
    rawBody: string;
    url: URL;
  }): ImChallengeResult {
    try {
      const plain = this.decryptEnvelope(req.rawBody);
      const parsed = JSON.parse(plain) as FeishuEnvelope;
      if (parsed.type === 'url_verification' && parsed.challenge) {
        return { handled: true, body: { challenge: parsed.challenge } };
      }
    } catch {
      /* 解密失败 → 非握手请求 */
    }
    return { handled: false };
  }

  parseInbound(rawBody: string): ImInboundMessage | null {
    let plain: string;
    try {
      plain = this.decryptEnvelope(rawBody);
    } catch {
      return null;
    }
    let env: FeishuEnvelope;
    try {
      env = JSON.parse(plain) as FeishuEnvelope;
    } catch {
      return null;
    }
    const ev = env.event;
    if (env.header?.event_type !== 'im.message.receive_v1' || !ev?.message) return null;
    const msg = ev.message;
    // 仅处理文本消息（图片/文件等暂不支持，桥接会回「暂不支持该消息类型」）。
    if (msg.message_type !== 'text') return null;
    const senderId = ev.sender?.sender_id?.open_id ?? ev.sender?.sender_id?.user_id ?? '';
    if (!senderId) return null;
    // 过滤机器人自身消息（sender_type 非 user 时忽略）。
    if (ev.sender?.sender_type && ev.sender.sender_type !== 'user') return null;

    let text = '';
    try {
      text = String((JSON.parse(msg.content ?? '{}') as { text?: string }).text ?? '');
    } catch {
      text = '';
    }
    // 剥离 @机器人 占位符（飞书在 text 里插入 @_user_N），再清首尾空白。
    text = text.replace(/@_user_\d+/g, '').trim();

    const isGroup = msg.chat_type === 'group';
    // 群聊 @ 判定：配了机器人 open_id 则精确匹配 mentions；否则只要 mentions 非空即视为 @ 了机器人。
    const mentions = msg.mentions ?? [];
    const mentionedBot = isGroup
      ? this.opt.botOpenId
        ? mentions.some((m) => m.id?.open_id === this.opt.botOpenId)
        : mentions.length > 0
      : true;
    return {
      provider: 'feishu',
      messageId: msg.message_id ?? env.header?.event_id ?? '',
      senderId,
      senderName: undefined,
      chatId: msg.chat_id ?? senderId,
      isGroup,
      mentionedBot,
      text,
      raw: env
    };
  }

  /** 取 tenant_access_token（带缓存）。 */
  private async tenantToken(): Promise<string> {
    const now = Date.now();
    if (this.tokenCache && this.tokenCache.expireAt > now) return this.tokenCache.value;
    const res = await fetch(`${FEISHU_BASE}/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ app_id: this.opt.appId, app_secret: this.opt.appSecret })
    });
    const data = (await res.json()) as { tenant_access_token?: string; expire?: number; msg?: string };
    if (!data.tenant_access_token) {
      throw new Error(`feishu: tenant_access_token 获取失败：${data.msg ?? res.status}`);
    }
    // 提前 5 分钟过期，避免边界失效。
    const ttl = ((data.expire ?? 7200) - 300) * 1000;
    this.tokenCache = { value: data.tenant_access_token, expireAt: now + Math.max(ttl, 60_000) };
    return data.tenant_access_token;
  }

  async sendText(target: ImInboundMessage, text: string): Promise<void> {
    const token = await this.tenantToken();
    const res = await fetch(`${FEISHU_BASE}/im/v1/messages?receive_id_type=chat_id`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        authorization: `Bearer ${token}`
      },
      body: JSON.stringify({
        receive_id: target.chatId,
        msg_type: 'text',
        content: JSON.stringify({ text })
      })
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`feishu: 发送消息失败 ${res.status} ${body.slice(0, 200)}`);
    }
  }
}

/** 常量时间字符串比较，避免签名比对时序侧信道。 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

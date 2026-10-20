/**
 * 推送投递层（P2-1 补齐：此前只有设备令牌注册 /api/devices + FileDeviceStore，
 * 缺「服务端向设备发送推送」的最后一跳 —— 移动端 REVIEW_CHECKLIST 宣称的
 * 「实时推送通知」因此虚标）。
 *
 * 设计（延续「接口 + 默认实现 + 组合工厂」）：
 * - `PushSender` 契约：向单个设备令牌投递一条通知，返回是否成功；
 * - `LogPushSender`（默认）：只记日志与指标，不外发 —— 无凭据时的安全兜底；
 * - `FcmPushSender`：FCM HTTP v1（OAuth2 服务账号 JWT，node:crypto RS256，
 *   零 npm 依赖）。配 `FIREBASE_SERVICE_ACCOUNT`（服务账号 JSON）后由工厂启用；
 * - `ApnsPushSender`：APNs token-based 认证（.p8 私钥 ES256 JWT + node:http2，
 *   零 npm 依赖）。配 `APNS_KEY_P8` / `APNS_KEY_ID` / `APNS_TEAM_ID` / `APNS_TOPIC`
 *   后由工厂启用（iOS 投递）；
 * - `PlatformRoutingSender`：按设备 platform 把投递路由到已配置的 sender
 *   （android→FCM，ios→APNs），未配置的平台降级日志兜底；
 * - `dispatchPushToOwner(owner, payload)`：查设备库 → 逐设备投递 → 失败只记数
 *   不抛错（推送是增强路径，绝不影响业务主流程）。
 *
 * 接线点：reminder-bus.publishReminder（备忘提醒到点时除 SSE 外同步投递推送）。
 */

import { createSign, sign as cryptoSign } from 'node:crypto';
import { connect as http2Connect, type ClientHttp2Session } from 'node:http2';
import { logError, structLog } from '@agent-harness/core';
import { getDeviceStore, type DeviceToken } from './device-store';

/** 一条待投递的通知（与 FCM notification 载荷对齐的最小子集）。 */
export interface PushPayload {
  title: string;
  body: string;
  /** 点击通知后唤起的 Deep Link（piagent://...）。 */
  deeplink?: string;
  /** 业务事件类型（memo:reminder 等），供端上路由。 */
  kind?: string;
}

/** 投递契约：向单个设备发一条通知，成功返回 true。实现必须自捕获网络错误。 */
export interface PushSender {
  readonly kind: 'log' | 'fcm' | 'apns' | 'routing';
  send(device: DeviceToken, payload: PushPayload): Promise<boolean>;
}

// ─── 计数（可观测）────────────────────────────────────────────────────────────

let pushCounters = { attempted: 0, sent: 0, failed: 0 };

export function pushStats(): { attempted: number; sent: number; failed: number } {
  return { ...pushCounters };
}

// ─── 默认实现：日志兜底 ──────────────────────────────────────────────────────

export class LogPushSender implements PushSender {
  readonly kind = 'log' as const;

  async send(device: DeviceToken, payload: PushPayload): Promise<boolean> {
    // 绝不记录完整 token（凭据脱敏纪律）：只打前 8 位指纹。
    structLog('info', 'push.dispatch.log_sender', {
      owner: device.owner,
      platform: device.platform,
      tokenFingerprint: device.token.slice(0, 8),
      title: payload.title,
      kind: payload.kind ?? ''
    });
    return true; // 「日志即成功」仅指投递语义被接受；真实外发需配置 FCM 凭据
  }
}

// ─── FCM HTTP v1 实现 ────────────────────────────────────────────────────────

interface ServiceAccount {
  client_email: string;
  private_key: string;
  project_id: string;
  token_uri?: string;
}

/** 解析服务账号 JSON（缺字段抛错，由工厂捕获降级）。 */
function parseServiceAccount(raw: string): ServiceAccount {
  const obj = JSON.parse(raw) as Partial<ServiceAccount>;
  if (!obj.client_email || !obj.private_key || !obj.project_id) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT 缺少 client_email / private_key / project_id');
  }
  return {
    client_email: obj.client_email,
    private_key: obj.private_key,
    project_id: obj.project_id,
    token_uri: obj.token_uri || 'https://oauth2.googleapis.com/token',
  };
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** 构造 OAuth2 断言 JWT（RS256，1 小时有效期）。 */
function buildAssertionJwt(sa: ServiceAccount, scope: string, now: number): string {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(
    JSON.stringify({
      iss: sa.client_email,
      scope,
      aud: sa.token_uri,
      iat: now,
      exp: now + 3600,
    })
  );
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  const sig = signer.sign(sa.private_key.replace(/\\n/g, '\n'));
  return `${header}.${claims}.${b64url(sig)}`;
}

/** OAuth2 access token 缓存（提前 60s 失效）。 */
let cachedToken: { token: string; expiresAt: number } | null = null;
let mockFetchImpl: typeof fetch | null = null;

/** 仅供测试注入 fetch 替身（传 null 还原真实 fetch）。 */
export function setFcmFetchForTest(impl: typeof fetch | null): void {
  mockFetchImpl = impl;
}

async function getAccessToken(sa: ServiceAccount, now: number): Promise<string> {
  if (cachedToken && cachedToken.expiresAt - 60_000 > now) return cachedToken.token;
  const assertion = buildAssertionJwt(
    sa,
    'https://www.googleapis.com/auth/firebase.messaging',
    now
  );
  const doFetch = mockFetchImpl ?? fetch;
  const res = await doFetch(sa.token_uri as string, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }).toString(),
  });
  if (!res.ok) {
    throw new Error(`FCM OAuth2 token 获取失败：HTTP ${res.status}`);
  }
  const data = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) throw new Error('FCM OAuth2 响应缺少 access_token');
  cachedToken = {
    token: data.access_token,
    expiresAt: now + (Number(data.expires_in) || 3600) * 1000,
  };
  return cachedToken.token;
}

export class FcmPushSender implements PushSender {
  readonly kind = 'fcm' as const;
  private readonly sa: ServiceAccount;

  constructor(serviceAccountJson: string) {
    this.sa = parseServiceAccount(serviceAccountJson);
  }

  async send(device: DeviceToken, payload: PushPayload): Promise<boolean> {
    // FCM 令牌仅适用于 Android；iOS 走 APNs（后续按同一契约实现）。
    if (device.platform !== 'android') {
      structLog('warn', 'push.dispatch.unsupported_platform', {
        platform: device.platform,
        owner: device.owner
      });
      return false;
    }
    const now = Date.now();
    const accessToken = await getAccessToken(this.sa, now);
    const doFetch = mockFetchImpl ?? fetch;
    const res = await doFetch(
      `https://fcm.googleapis.com/v1/projects/${this.sa.project_id}/messages:send`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          message: {
            token: device.token,
            notification: { title: payload.title, body: payload.body },
            data: {
              ...(payload.deeplink ? { deeplink: payload.deeplink } : {}),
              ...(payload.kind ? { kind: payload.kind } : {}),
            },
            android: { priority: 'high' },
          },
        }),
      }
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`FCM 发送失败：HTTP ${res.status} ${detail.slice(0, 200)}`);
    }
    return true;
  }
}

// ─── APNs 实现（iOS；token-based 认证，.p8 + ES256 JWT + node:http2）──────────

interface ApnsOptions {
  keyP8: string; // .p8 私钥（PKCS#8 PEM，或 base64 内联）
  keyId: string; // Apple Key ID（10 位）
  teamId: string; // Apple Team ID
  topic: string; // App bundle id（apns-topic）
  production?: boolean; // true → api.push.apple.com；false/缺省 → 沙箱 api.development.push.apple.com
}

/** 内联 .p8 兼容：支持原始 PEM（含 \n 转义）或 base64 编码的 PEM。 */
function normalizeP8(raw: string): string {
  const trimmed = raw.trim().replace(/\\n/g, '\n');
  if (trimmed.includes('BEGIN PRIVATE KEY')) return trimmed;
  return Buffer.from(trimmed, 'base64').toString('utf-8');
}

/** APNs 提供方令牌缓存：Apple 建议 1 小时内复用，过期重签（无 exp 声明，按 iat 自管）。 */
let apnsToken: { jwt: string; iat: number } | null = null;

/** 构造 APNs provider token（ES256：P-256 ECDSA，签名取 raw r||s —— ieee-p1363）。 */
export function buildApnsJwt(opts: { keyP8: string; keyId: string; teamId: string }, now: number): string {
  const b64 = (s: string) => b64url(s);
  const header = b64(JSON.stringify({ alg: 'ES256', kid: opts.keyId }));
  const claims = b64(JSON.stringify({ iss: opts.teamId, iat: now }));
  const sig = cryptoSign('sha256', Buffer.from(`${header}.${claims}`), {
    key: normalizeP8(opts.keyP8),
    dsaEncoding: 'ieee-p1363', // JWT 要求 64 字节 raw r||s，而非 ASN.1 DER
  });
  return `${header}.${claims}.${b64url(sig)}`;
}

/** 供测试注入 http2 传输替身（传 null 还原真实 http2）。 */
export type ApnsTransport = (
  host: string,
  path: string,
  headers: Record<string, string>,
  body: string
) => Promise<{ status: number; body: string }>;
let apnsTransportImpl: ApnsTransport | null = null;

export function setApnsTransportForTest(impl: ApnsTransport | null): void {
  apnsTransportImpl = impl;
}

/** 真实 http2 传输：APNs 仅支持 HTTP/2（undici fetch 不支持 h2，必须用 node:http2）。 */
function realApnsTransport(
  host: string,
  path: string,
  headers: Record<string, string>,
  body: string
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    let session: ClientHttp2Session | undefined;
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      try {
        session?.close();
      } catch {
        /* 已关闭 */
      }
      fn();
    };
    const timer = setTimeout(() => done(() => reject(new Error('APNs 请求超时（8s）'))), 8000);
    try {
      session = http2Connect(`https://${host}`);
      session.on('error', (e) => {
        clearTimeout(timer);
        done(() => reject(e));
      });
      const req = session.request({ ...headers, ':method': 'POST', ':path': path });
      req.on('response', (res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          clearTimeout(timer);
          const status = Number(res[':status'] ?? 0);
          done(() => resolve({ status, body: Buffer.concat(chunks).toString('utf-8') }));
        });
      });
      req.on('error', (e) => {
        clearTimeout(timer);
        done(() => reject(e));
      });
      req.end(body);
    } catch (e) {
      clearTimeout(timer);
      done(() => reject(e));
    }
  });
}

export class ApnsPushSender implements PushSender {
  readonly kind = 'apns' as const;
  private readonly opt: ApnsOptions;

  constructor(o: ApnsOptions) {
    if (!o.keyP8 || !o.keyId || !o.teamId || !o.topic) {
      throw new Error('APNs 配置不完整：需要 APNS_KEY_P8 / APNS_KEY_ID / APNS_TEAM_ID / APNS_TOPIC');
    }
    this.opt = { ...o, keyP8: normalizeP8(o.keyP8) };
  }

  private async providerToken(now: number): Promise<string> {
    // Apple 建议 token 复用不超过 1 小时：50 分钟主动重签（留漂移余量）。
    if (apnsToken && now - apnsToken.iat < 50 * 60_000) return apnsToken.jwt;
    const jwt = buildApnsJwt(this.opt, Math.floor(now / 1000));
    apnsToken = { jwt, iat: now };
    return jwt;
  }

  async send(device: DeviceToken, payload: PushPayload): Promise<boolean> {
    // FCM/APNs 令牌与平台绑定：ios 令牌不得走其它通道。
    if (device.platform !== 'ios') {
      structLog('warn', 'push.dispatch.unsupported_platform', {
        sender: 'apns',
        platform: device.platform,
        owner: device.owner
      });
      return false;
    }
    const host = this.opt.production === true
      ? 'api.push.apple.com'
      : 'api.development.push.apple.com';
    const token = await this.providerToken(Date.now());
    const body = JSON.stringify({
      aps: {
        alert: { title: payload.title, body: payload.body },
        sound: 'default',
      },
      ...(payload.deeplink ? { deeplink: payload.deeplink } : {}),
      ...(payload.kind ? { kind: payload.kind } : {}),
    });
    const transport = apnsTransportImpl ?? realApnsTransport;
    const res = await transport(
      host,
      `/3/device/${encodeURIComponent(device.token)}`,
      {
        authorization: `bearer ${token}`,
        'apns-topic': this.opt.topic,
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'content-type': 'application/json',
      },
      body
    );
    if (res.status !== 200) {
      // 410 Unregistered：令牌已失效，端上/运维应重新注册；这里如实报失败。
      throw new Error(`APNs 发送失败：HTTP ${res.status} ${res.body.slice(0, 200)}`);
    }
    return true;
  }
}

/** 供测试重置 APNs 令牌缓存。 */
export function resetApnsTokenForTest(): void {
  apnsToken = null;
}

// ─── 平台路由（android→FCM / ios→APNs，未配置的平台降级日志兜底）─────────────

export class PlatformRoutingSender implements PushSender {
  readonly kind = 'routing' as const;

  constructor(
    private readonly fcm?: PushSender,
    private readonly apns?: PushSender,
    private readonly fallback: PushSender = new LogPushSender()
  ) {}

  async send(device: DeviceToken, payload: PushPayload): Promise<boolean> {
    if (device.platform === 'android') {
      return this.fcm ? this.fcm.send(device, payload) : this.fallback.send(device, payload);
    }
    if (device.platform === 'ios') {
      return this.apns ? this.apns.send(device, payload) : this.fallback.send(device, payload);
    }
    return false;
  }
}

// ─── 组合工厂与 owner 派发 ───────────────────────────────────────────────────

let senderSingleton: PushSender | null = null;

/** 组合工厂：按凭据装配 FCM / APNs / 平台路由，缺凭据降级日志兜底（降级可用）。 */
export function getPushSender(env: NodeJS.ProcessEnv = process.env): PushSender {
  if (senderSingleton) return senderSingleton;

  let fcm: FcmPushSender | undefined;
  const fcmRaw = (env.FIREBASE_SERVICE_ACCOUNT || '').trim();
  if (fcmRaw) {
    try {
      fcm = new FcmPushSender(fcmRaw);
      structLog('info', 'push.sender.fcm', { note: 'FCM 投递层已启用' });
    } catch (e) {
      // 凭据损坏：降级日志兜底并告警，绝不因推送配置错误阻断启动。
      logError('push.sender', e as Error, {
        note: 'FIREBASE_SERVICE_ACCOUNT 解析失败，降级为日志投递'
      });
    }
  }

  let apns: ApnsPushSender | undefined;
  const p8 = (env.APNS_KEY_P8 || '').trim();
  const keyId = (env.APNS_KEY_ID || '').trim();
  const teamId = (env.APNS_TEAM_ID || '').trim();
  const topic = (env.APNS_TOPIC || '').trim();
  if (p8 && keyId && teamId && topic) {
    try {
      apns = new ApnsPushSender({
        keyP8: p8,
        keyId,
        teamId,
        topic,
        production: (env.APNS_ENV || 'production').toLowerCase() !== 'development',
      });
      structLog('info', 'push.sender.apns', {
        note: 'APNs 投递层已启用',
        production: apns !== undefined && (env.APNS_ENV || 'production').toLowerCase() !== 'development'
      });
    } catch (e) {
      logError('push.sender', e as Error, {
        note: 'APNs 配置无效，iOS 降级为日志投递'
      });
    }
  }

  if (fcm && apns) {
    senderSingleton = new PlatformRoutingSender(fcm, apns);
  } else if (fcm) {
    senderSingleton = fcm;
  } else if (apns) {
    senderSingleton = apns;
  } else {
    senderSingleton = new LogPushSender();
  }
  return senderSingleton;
}

/** 供测试注入自定义 sender（传 null 重置为工厂单例）。 */
export function setPushSenderForTest(s: PushSender | null): void {
  senderSingleton = s;
  cachedToken = null;
}

/**
 * 向某 owner 的全部已注册设备投递一条推送。失败只计数与告警，绝不抛错 ——
 * 推送是增强路径，主流程（SSE / Web）不因此受影响。
 */
export async function dispatchPushToOwner(owner: string, payload: PushPayload): Promise<void> {
  let devices: DeviceToken[];
  try {
    devices = await getDeviceStore().listByOwner(owner);
  } catch (e) {
    logError('push.dispatch', e as Error, { op: 'listByOwner', owner });
    return;
  }
  if (devices.length === 0) return;
  const sender = getPushSender();
  await Promise.allSettled(
    devices.map(async (d) => {
      pushCounters.attempted++;
      try {
        const ok = await sender.send(d, payload);
        if (ok) {
          pushCounters.sent++;
        } else {
          pushCounters.failed++;
        }
      } catch (e) {
        pushCounters.failed++;
        logError('push.dispatch', e as Error, {
          op: 'send',
          owner: d.owner,
          platform: d.platform,
          tokenFingerprint: d.token.slice(0, 8)
        });
      }
    })
  );
}

/** 供测试重置计数。 */
export function resetPushStatsForTest(): void {
  pushCounters = { attempted: 0, sent: 0, failed: 0 };
}

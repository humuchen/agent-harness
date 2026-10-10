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
 *   APNs（.p8 + HTTP/2）后续按同一契约补实现；
 * - `dispatchPushToOwner(owner, payload)`：查设备库 → 逐设备投递 → 失败只记数
 *   不抛错（推送是增强路径，绝不影响业务主流程）。
 *
 * 接线点：reminder-bus.publishReminder（备忘提醒到点时除 SSE 外同步投递推送）。
 */

import { createSign } from 'node:crypto';
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
  readonly kind: 'log' | 'fcm';
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

// ─── 组合工厂与 owner 派发 ───────────────────────────────────────────────────

let senderSingleton: PushSender | null = null;

/** 组合工厂：配了 FIREBASE_SERVICE_ACCOUNT → FCM，否则日志兜底（降级可用）。 */
export function getPushSender(env: NodeJS.ProcessEnv = process.env): PushSender {
  if (senderSingleton) return senderSingleton;
  const raw = (env.FIREBASE_SERVICE_ACCOUNT || '').trim();
  if (raw) {
    try {
      senderSingleton = new FcmPushSender(raw);
      structLog('info', 'push.sender.fcm', { note: 'FCM 投递层已启用' });
      return senderSingleton;
    } catch (e) {
      // 凭据损坏：降级日志兜底并告警，绝不因推送配置错误阻断启动。
      logError('push.sender', e as Error, {
        note: 'FIREBASE_SERVICE_ACCOUNT 解析失败，降级为日志投递'
      });
    }
  }
  senderSingleton = new LogPushSender();
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

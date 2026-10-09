/**
 * OpenRouter OAuth（PKCE）一键授权框架（P2.1）。
 *
 * 目标：让用户免手工复制 Key——点击「授权」后在 OpenRouter  consent 页授权，
 * 由本服务用 PKCE 换取 access token，并作为 provider key 加密落库（与手工粘贴同一条链路）。
 *
 * 安全约束（与 provider-keys 一致）：
 *  - 采用 PKCE（S256），公共客户端无需 client_secret。P1-1 起 code_verifier 由
 *    **服务端**生成（/oauth/start），经签名 state 随授权 URL 流转、回调后凭 state 反解——
 *    verifier 不再经客户端明文流转，state 无法伪造。
 *  - 换得的 access token 经 saveUserProviderKey 走服务端 AES-GCM 加密落库（与手工 Key 完全一致）。
 *  - 未配置 OPENROUTER_OAUTH_CLIENT_ID 时，/oauth/config 返回 enabled:false，前端隐藏授权入口，
 *    整套链路零副作用（不影响现有手工粘贴路径）。
 *
 * 端点（均在 /api/account 命名空间下，与 BYOK 同权限档 provider:manage）：
 *  - GET  /api/account/oauth/config?provider=openrouter → { enabled, clientId, authorizeUrl, redirectUri, scopes }
 *  - GET  /api/account/oauth/start?provider=openrouter  → { authorizeUrl }（服务端生成 verifier + 签名 state，
 *        并组装完整授权 URL；前端直接 window.open 该 URL，不再自建 PKCE）。
 *  - GET  /api/account/oauth/callback  → 静态 HTML（公开，无鉴权）：读取 URL 的 code/state，
 *        向同域 /api/account/oauth/exchange 发 POST，成功后再 postMessage 给 opener 并关闭弹窗。
 *  - POST /api/account/oauth/exchange  → { code, state, provider }（新）/ { code, codeVerifier, provider }
 *        （旧前端兼容）：用 PKCE 换 token，落库。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { saveUserProviderKey, type ProviderId } from './provider-keys';
import { encryptApiKey, decryptApiKey } from './custom-models';

interface OAuthProviderSpec {
  /** 供应商标识（与 provider-keys 的 ProviderId 对齐）。 */
  id: ProviderId;
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string;
  /** env 中 client_id 的键名。 */
  clientIdEnv: string;
  /** env 中 client_secret 的键名（可选）。 */
  clientSecretEnv?: string;
  /** env 中自定义 authorize 端点的键名（可选覆盖）。 */
  authorizeUrlEnv?: string;
  tokenUrlEnv?: string;
}

const OAUTH_PROVIDERS: Record<string, OAuthProviderSpec> = {
  openrouter: {
    id: 'openrouter',
    // OpenRouter 授权与换票端点（可被 env 覆盖）。
    authorizeUrl: 'https://openrouter.ai/auth',
    tokenUrl: 'https://openrouter.ai/api/v1/oauth/token',
    scopes: 'openid profile',
    clientIdEnv: 'OPENROUTER_OAUTH_CLIENT_ID',
    clientSecretEnv: 'OPENROUTER_OAUTH_CLIENT_SECRET',
    authorizeUrlEnv: 'OPENROUTER_OAUTH_AUTHORIZE_URL',
    tokenUrlEnv: 'OPENROUTER_OAUTH_TOKEN_URL'
  }
};

function getSpec(provider: string): OAuthProviderSpec | null {
  return OAUTH_PROVIDERS[provider] ?? null;
}

// ─── 服务端签发 OAuth state（P1-1 CSRF 防护）─────────────────────────────────
// 旧实现：state 即前端生成的 code_verifier，服务端不签发也不校验 → 攻击者可诱导
// 已登录受害者完成「绑定攻击者 OpenRouter 账号」的授权流（login-CSRF / 账号固定）。
// 新实现：/oauth/start 由服务端生成 verifier 并把 { exp, nonce, verifier } 经
// AES-GCM 加密为 state（认证标签防篡改，10 分钟 TTL），回调凭 state 反解 verifier
// 换票。stateless 校验天然多实例可用（无需共享存储）；重放 state 无意义——授权码
// code 在 OpenRouter 侧一次性消费。
const OAUTH_STATE_TTL_MS = 10 * 60_000;
const OAUTH_STATE_PREFIX = 'ah1.';

function b64url(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function b64urlDecode(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function s256(verifier: string): string {
  return b64url(createHash('sha256').update(verifier).digest());
}

/** 签发授权 state：载荷 { exp, nonce, verifier } 经 AES-GCM 加密（防伪造 + 保密 verifier）。 */
export function issueOAuthState(verifier: string): string {
  const payload = JSON.stringify({
    exp: Date.now() + OAUTH_STATE_TTL_MS,
    nonce: b64url(randomBytes(16)),
    verifier
  });
  return OAUTH_STATE_PREFIX + b64url(Buffer.from(encryptApiKey(payload)));
}

/** 校验并解出授权 state 中的 code_verifier；伪造/篡改/过期 → null（调用方按 400 拒绝）。 */
export function verifyOAuthState(state: string): string | null {
  if (typeof state !== 'string' || !state.startsWith(OAUTH_STATE_PREFIX)) return null;
  try {
    // b64url 解码还原出的是「encryptApiKey 输出的 base64 文本」（utf-8 字节），
    // 需按 utf-8 读回原文再交给 decryptApiKey 做一次 base64 解码。
    const payload = decryptApiKey(b64urlDecode(state.slice(OAUTH_STATE_PREFIX.length)).toString('utf-8'));
    const obj = JSON.parse(payload) as { exp?: number; verifier?: string };
    if (typeof obj.exp !== 'number' || obj.exp < Date.now()) return null;
    if (typeof obj.verifier !== 'string' || obj.verifier.length < 32) return null;
    return obj.verifier;
  } catch {
    return null;
  }
}

/** 计算本服务对外公开基址（redirect_uri 用）。 */
function publicBaseUrl(req: IncomingMessage): string {
  const fromEnv = process.env.PUBLIC_BASE_URL?.trim();
  if (fromEnv) return fromEnv.replace(/\/$/, '');
  const host = req.headers.host ?? `localhost:${process.env.PORT ?? 4173}`;
  const proto = req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
  return `${proto}://${host}`;
}

/** 返回某 provider 的 OAuth 配置；未配置 client_id 则 enabled=false。 */
export function getOAuthConfig(
  req: IncomingMessage,
  provider: string
): {
  enabled: boolean;
  provider: string;
  clientId?: string;
  authorizeUrl?: string;
  redirectUri?: string;
  scopes?: string;
} {
  const spec = getSpec(provider);
  if (!spec) {
    return { enabled: false, provider };
  }
  const clientId = process.env[spec.clientIdEnv]?.trim();
  if (!clientId) {
    return { enabled: false, provider };
  }
  const authorizeUrl =
    (spec.authorizeUrlEnv && process.env[spec.authorizeUrlEnv]?.trim()) ||
    spec.authorizeUrl;
  const redirectUri =
    process.env.OPENROUTER_OAUTH_REDIRECT_URI?.trim() ||
    `${publicBaseUrl(req)}/api/account/oauth/callback`;
  return {
    enabled: true,
    provider,
    clientId,
    authorizeUrl,
    redirectUri,
    scopes: spec.scopes
  };
}

/**
 * 用授权码 + PKCE verifier 向 OpenRouter 换取 access token，并作为 provider key 落库。
 * @returns 落库的 keyHint / 或抛错（HTTP 失败 / 无 token）。
 */
export async function exchangeOAuthCode(opts: {
  provider: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  owner: string;
}): Promise<{ keyHint: string }> {
  const spec = getSpec(opts.provider);
  if (!spec) throw new Error(`unsupported oauth provider: ${opts.provider}`);
  const clientId = process.env[spec.clientIdEnv]?.trim();
  if (!clientId) throw new Error('oauth not configured (missing client id)');
  const tokenUrl =
    (spec.tokenUrlEnv && process.env[spec.tokenUrlEnv]?.trim()) ||
    spec.tokenUrl;
  const clientSecret = spec.clientSecretEnv
    ? process.env[spec.clientSecretEnv]?.trim()
    : undefined;

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: opts.code,
    redirect_uri: opts.redirectUri,
    client_id: clientId,
    code_verifier: opts.codeVerifier
  });
  if (clientSecret) body.set('client_secret', clientSecret);

  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`oauth token exchange failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  const data = (await res.json()) as { access_token?: string; error?: string };
  if (!data.access_token) {
    throw new Error(`oauth token exchange failed: ${data.error ?? 'no access_token'}`);
  }
  // OpenRouter 的 access_token 可直接作 Bearer 调 OpenAI 兼容端点；落库方式与手工 Key 完全一致。
  const saved = await saveUserProviderKey(opts.owner, spec.id, {
    apiKey: data.access_token
  });
  return { keyHint: saved.keyHint };
}

/** GET /api/account/oauth/callback 的静态 HTML：在弹窗内完成换票并回传 opener。 */
const CALLBACK_HTML = `<!doctype html>
<html lang="zh">
<head><meta charset="utf-8"><title>OpenRouter 授权中…</title>
<style>
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0B0E14;color:#e6e6e6;
       display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
  .box{text-align:center;padding:24px 28px;border:1px solid #2a2f3a;border-radius:14px;background:#121622;max-width:360px}
  .sp{font-size:14px;color:#9aa4b2;margin-top:10px}
  .ok{color:#34d399}.err{color:#f87171}
</style></head>
<body><div class="box">
  <div id="t">正在完成授权…</div>
  <div class="sp" id="s">请稍候</div>
</div>
<script>
(async () => {
  const q = new URLSearchParams(location.search);
  const code = q.get('code');
  const state = q.get('state'); // 服务端签发的签名 state（P1-1）：exchange 端据此反解 verifier
  const provider = q.get('provider') || 'openrouter';
  const set = (cls, msg) => { document.getElementById('t').textContent = msg;
    document.getElementById('t').className = cls; };
  if (!code || !state) {
    set('err','授权被取消或缺少参数'); return;
  }
  try {
    const r = await fetch('/api/account/oauth/exchange', {
      method:'POST', headers:{'content-type':'application/json'},
      credentials:'include',
      body: JSON.stringify({ provider, code, state: state,
        redirectUri: location.origin + '/api/account/oauth/callback' })
    });
    if (!r.ok) { const e = await r.json().catch(()=>({})); throw new Error(e.error || ('HTTP '+r.status)); }
    set('ok','授权成功！正在关闭…');
    try { opener && opener.postMessage({ type:'oauth:done', provider, ok:true }, location.origin); } catch(_) {}
  } catch (e) {
    set('err','授权失败：' + (e.message || e));
  } finally {
    setTimeout(() => { try { window.close(); } catch(_) {} }, 1200);
  }
})();
</script></body></html>`;

/** 注册 OAuth 相关路由；返回 true 表示已处理。 */
export async function registerOAuthRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string
): Promise<boolean> {
  const base = '/api/account/oauth';
  if (!path.startsWith(base)) return false;

  // GET /api/account/oauth/callback → 静态 HTML（公开）。
  if (method === 'GET' && path === `${base}/callback`) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(CALLBACK_HTML);
    return true;
  }

  // GET /api/account/oauth/start?provider=openrouter → 服务端签发 verifier + 签名 state，
  // 组装完整授权 URL 返回（P1-1：前端不再自建 PKCE / 不再自定 state）。
  if (method === 'GET' && path === `${base}/start`) {
    const provider =
      (req.url ? new URL(req.url, 'http://x').searchParams.get('provider') : '') ||
      'openrouter';
    const cfg = getOAuthConfig(req, provider);
    if (!cfg.enabled || !cfg.clientId || !cfg.authorizeUrl) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'oauth not configured' }));
      return true;
    }
    const verifier = b64url(randomBytes(48)); // 64 字符，符合 RFC 7636 的 43-128 字符要求
    const params = new URLSearchParams({
      client_id: cfg.clientId,
      redirect_uri: cfg.redirectUri ?? '',
      response_type: 'code',
      scope: cfg.scopes ?? 'openid profile',
      code_challenge: s256(verifier),
      code_challenge_method: 'S256',
      state: issueOAuthState(verifier)
    });
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ authorizeUrl: `${cfg.authorizeUrl}?${params.toString()}` }));
    return true;
  }

  // GET /api/account/oauth/config?provider=openrouter → 配置（需登录）。
  if (method === 'GET' && path === `${base}/config`) {
    const provider = (req.url ? new URL(req.url, 'http://x').searchParams.get('provider') : '') || 'openrouter';
    const cfg = getOAuthConfig(req, provider);
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(cfg));
    return true;
  }

  // POST /api/account/oauth/exchange → 换票并落库（需登录，owner=ctx.sub）。
  if (method === 'POST' && path === `${base}/exchange`) {
    // guard 由调用方（server.ts）已完成，并注入 owner；此处 body 仅含 code/verifier/provider。
    // 为避免在 router 层重复 guard，约定：server.ts 对 /api/account/oauth/exchange 也走 guard，
    // 并把 ctx.sub 暂存到 req 的 ahOwner 字段。
    const owner = (req as unknown as { ahOwner?: string }).ahOwner;
    if (!owner) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return true;
    }
    let body: any = {};
    try {
      // P2-6：此路由此前自读 body 无大小上限（其余路由均受 MAX_BODY_BYTES 约束），
      // 补 64KB 上限（OAuth 交换载荷远小于此）。
      const raw = await new Promise<string>((resolve, reject) => {
        let d = '';
        req.on('data', (c: string) => {
          d += c;
          if (d.length > 64 * 1024) {
            reject(new Error('body too large'));
            req.destroy();
          }
        });
        req.on('end', () => resolve(d));
        req.on('error', reject);
      });
      body = raw ? JSON.parse(raw) : {};
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid body' }));
      return true;
    }
    // P1-1：优先取服务端签发的 state（反解 verifier）；旧前端仍直传 codeVerifier 时
    // 走兼容路径。state 无效/过期 → 400，不做授权换票（防 login-CSRF / 账号固定）。
    let codeVerifier = '';
    const stateRaw = typeof body.state === 'string' ? body.state : '';
    if (stateRaw) {
      const fromState = verifyOAuthState(stateRaw);
      if (!fromState) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'oauth state invalid or expired' }));
        return true;
      }
      codeVerifier = fromState;
    } else if (typeof body.codeVerifier === 'string' && body.codeVerifier) {
      codeVerifier = body.codeVerifier;
    }
    if (!body.code || !codeVerifier) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'code and state (or codeVerifier) are required' }));
      return true;
    }
    try {
      const redirectUri =
        body.redirectUri ||
        `${publicBaseUrl(req)}/api/account/oauth/callback`;
      const saved = await exchangeOAuthCode({
        provider: body.provider || 'openrouter',
        code: String(body.code),
        codeVerifier,
        redirectUri,
        owner
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, keyHint: saved.keyHint }));
    } catch (e) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: e instanceof Error ? e.message : 'oauth exchange failed' }));
    }
    return true;
  }

  return false;
}

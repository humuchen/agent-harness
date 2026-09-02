/**
 * OpenRouter OAuth（PKCE）一键授权框架（P2.1）。
 *
 * 目标：让用户免手工复制 Key——点击「授权」后在 OpenRouter  consent 页授权，
 * 由本服务用 PKCE 换取 access token，并作为 provider key 加密落库（与手工粘贴同一条链路）。
 *
 * 安全约束（与 provider-keys 一致）：
 *  - 采用 PKCE（S256），公共客户端无需 client_secret；code_verifier 由前端生成并随 state 回传，
 *    后端只用它换 token，不持久化。
 *  - 换得的 access token 经 saveUserProviderKey 走服务端 AES-GCM 加密落库（与手工 Key 完全一致）。
 *  - 未配置 OPENROUTER_OAUTH_CLIENT_ID 时，/oauth/config 返回 enabled:false，前端隐藏授权入口，
 *    整套链路零副作用（不影响现有手工粘贴路径）。
 *
 * 端点（均在 /api/account 命名空间下，与 BYOK 同权限档 provider:manage）：
 *  - GET  /api/account/oauth/config?provider=openrouter → { enabled, clientId, authorizeUrl, redirectUri, scopes }
 *  - GET  /api/account/oauth/callback  → 静态 HTML（公开，无鉴权）：读取 URL 的 code/state，
 *        向同域 /api/account/oauth/exchange 发 POST，成功后再 postMessage 给 opener 并关闭弹窗。
 *  - POST /api/account/oauth/exchange  → { code, codeVerifier, provider }：用 PKCE 换 token，落库。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { saveUserProviderKey, type ProviderId } from './provider-keys';

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
  const state = q.get('state'); // 我们的实现中 state 即 code_verifier
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
      body: JSON.stringify({ provider, code, codeVerifier: state,
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
      const raw = await new Promise<string>((resolve, reject) => {
        let d = '';
        req.on('data', (c) => (d += c));
        req.on('end', () => resolve(d));
        req.on('error', reject);
      });
      body = raw ? JSON.parse(raw) : {};
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid body' }));
      return true;
    }
    try {
      const redirectUri =
        body.redirectUri ||
        `${publicBaseUrl(req)}/api/account/oauth/callback`;
      const saved = await exchangeOAuthCode({
        provider: body.provider || 'openrouter',
        code: String(body.code || ''),
        codeVerifier: String(body.codeVerifier || ''),
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

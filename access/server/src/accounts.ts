/**
 * 账户密码鉴权子系统（零新依赖：Node 内置 crypto + 现有 node:sqlite）。
 *
 * 与现有身份源（静态令牌 / OIDC / proxy 头注入）**共存**：作为 Authorizer 的一档 fallback，
 * 由 authz.createAuthorizer 组合进来，企业 SSO 部署完全不受影响。
 *
 * 流程（对应需求）：
 *  1) POST /api/account/register —— 校验用户名/密码强度 → 入库（scrypt 加盐哈希）。
 *  2) POST /api/account/login    —— 校验凭据 → 签发 HMAC 签名的 token（payload 含 username + 7 天 exp），
 *     同时把 token 记到服务端 SQLite（auth_tokens 表，7 天有效期，支持吊销）→ Set-Cookie: ah_auth。
 *  3) 之后每次请求：浏览器自动带 Cookie: ah_auth=*** ；前端额外在 header 带 x-ah-username。
 *     AccountAuthorizer 从 cookie（或 Authorization / ?token= 给非浏览器客户端）取 token +
 *     读 x-ah-username 头，校验：签名有效 + exp 未过 + 服务端 token 记录仍存在且未过期 +
 *     头中 username 与 token 内 username 一致（防头伪造）。任一项失败 → 401。
 *  4) 前端收到 401 → 清 cookie + 跳登录页。
 *
 * 安全约束：
 *  - 密码 scrypt 加盐（Node 内置），不存明文。
 *  - token 为 jti.payload.sig：sig = HMAC-SHA256(jti.payload, AH_AUTH_SECRET)；payload = base64url({u,exp})。
 *  - Cookie: HttpOnly; SameSite=Lax; 仅非 localhost 置 Secure（dev 可 http）；Max-Age=604800。
 *  - 签名密钥 AH_AUTH_SECRET（64 hex）；缺失时回退 AH_CRYPTO_KEY，再缺则每进程随机生成（重启即失效，仅演示）。
 */
import {
  randomBytes,
  scryptSync,
  timingSafeEqual,
  createHmac
} from 'node:crypto';
import { join } from 'node:path';
import { getDbAdapter } from '@agent-harness/core';

// ─── 签名密钥 ────────────────────────────────────────────────────────────────
function getAuthSecret(): Uint8Array {
  const raw = (
    process.env.AH_AUTH_SECRET ||
    process.env.AH_CRYPTO_KEY ||
    ''
  ).trim();
  if (raw && /^[0-9a-fA-F]{64}$/.test(raw)) {
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i++)
      out[i] = parseInt(raw.slice(i * 2, i * 2 + 2), 16);
    return out;
  }
  // 演示兜底：每进程随机密钥（重启后旧 token 全部失效）。生产务必配置 AH_AUTH_SECRET。
  console.warn(
    '   ⚠️  未配置 AH_AUTH_SECRET / AH_CRYPTO_KEY：账户 token 将使用每进程随机密钥，服务重启后全部登录失效。生产请配置 AH_AUTH_SECRET=64hex。'
  );
  return randomBytes(32);
}

const b64url = (buf: Buffer): string =>
  buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
const b64urlJson = (obj: unknown): string =>
  b64url(Buffer.from(JSON.stringify(obj), 'utf8'));

const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 天

// ─── 数据库存储（通过统一适配器，支持 sqlite / turso 双后端）──────────────
let db: any = null;
let dbReady: Promise<void> | null = null;

function getDbFile(): string {
  return (
    process.env.ACCOUNT_DB_FILE || join(process.cwd(), 'data', 'accounts.db')
  );
}

async function ensureDb(): Promise<void> {
  if (db) return;
  if (!dbReady) {
    dbReady = (async () => {
      const file = getDbFile();
      // 使用统一适配器（自动按 DB_BACKEND 环境变量选择 sqlite 或 turso）
      db = getDbAdapter({ file });
      db.exec(
        `CREATE TABLE IF NOT EXISTS users (
          username TEXT PRIMARY KEY,
          password TEXT NOT NULL,            -- scrypt: salt:hash (hex)
          email TEXT,                        -- 选填联系邮箱（注册时收集，非登录标识）
          created_at INTEGER NOT NULL
        )`
      );
      db.exec(
        `CREATE TABLE IF NOT EXISTS auth_tokens (
          jti TEXT PRIMARY KEY,
          username TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL
        )`
      );
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_tokens_user ON auth_tokens(username)`
      );
      // 兼容旧库：早期 users 表无 email 列，ALTER 补列（列已存在则跳过）。
      try {
        const cols = db.prepare('PRAGMA table_info(users)').all() as Record<string, unknown>[];
        const hasEmail = cols.some((c) => String(c.name) === 'email');
        if (!hasEmail) {
          db.exec('ALTER TABLE users ADD COLUMN email TEXT');
        }
      } catch {
        /* 列已存在或 Turso 不支持该 DDL，忽略 */
      }
      // ── 部署逃生账户 seeding ──
      // 若配置了 ADMIN_USERNAME / ADMIN_PASSWORD（默认 admin / admin888），则确保该账户
      // 常驻本地库：库被清空（如 Render 临时盘重启）或密码变更时自动重建 / 同步。
      // 这样无论磁盘是否持久化，admin 账户都随时可登录放行，无需手工注册。
      // 设 ADMIN_PASSWORD=（空）可禁用内置账户。
      const adminUser = (process.env.ADMIN_USERNAME || 'admin').trim();
      const adminPass = process.env.ADMIN_PASSWORD;
      if (adminUser && adminPass) {
        const exists = db
          .prepare('SELECT password FROM users WHERE username = ?')
          .get(adminUser) as { password: string } | undefined;
        if (!exists) {
          db.prepare(
            'INSERT INTO users (username, password, email, created_at) VALUES (?, ?, ?, ?)'
          ).run(adminUser, hashPassword(adminPass), null, Date.now());
        } else if (!verifyPassword(adminPass, exists.password)) {
          // 环境变量指定的密码与库中不一致（部署改密）→ 同步更新。
          db.prepare('UPDATE users SET password = ? WHERE username = ?').run(
            hashPassword(adminPass),
            adminUser
          );
        }
      }
    })();
  }
  await dbReady;
}

// ─── 密码哈希（scrypt 加盐）─────────────────────────────────────────────────
function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(pw, salt, 64);
  return `${salt.toString('hex')}:${derived.toString('hex')}`;
}

function verifyPassword(pw: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, 'hex');
  const derived = scryptSync(pw, salt, 64);
  const expected = Buffer.from(hashHex, 'hex');
  return (
    derived.length === expected.length && timingSafeEqual(derived, expected)
  );
}

// ─── token 签发 / 校验 ──────────────────────────────────────────────────────
export interface AccountToken {
  jti: string;
  username: string;
  exp: number; // 毫秒时间戳
  sig: string;
}

function sign(jti: string, payloadB64: string): string {
  const mac = createHmac('sha256', getAuthSecret());
  mac.update(`${jti}.${payloadB64}`);
  return b64url(mac.digest());
}

/** 签发：写服务端 token 记录（7 天）+ 返回紧凑 token 串。 */
export async function issueToken(username: string): Promise<string> {
  await ensureDb();
  const jti = randomBytes(16).toString('hex');
  const exp = Date.now() + TOKEN_TTL_MS;
  const payloadB64 = b64urlJson({ u: username, exp });
  const sig = sign(jti, payloadB64);
  db.prepare(
    `INSERT INTO auth_tokens (jti, username, expires_at, created_at) VALUES (?, ?, ?, ?)`
  ).run(jti, username, exp, Date.now());
  return `${jti}.${payloadB64}.${sig}`;
}

/** 解析 + 验签 token（不查库）。非法返回 null。 */
export function parseToken(raw: string): AccountToken | null {
  const parts = raw.split('.');
  if (parts.length !== 3) return null;
  const [jti, payloadB64, sig] = parts;
  const expected = sign(jti, payloadB64);
  try {
    const a = Buffer.from(sig, 'base64');
    const b = Buffer.from(expected, 'base64');
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }
  try {
    const payload = JSON.parse(
      Buffer.from(payloadB64, 'base64').toString('utf8')
    ) as {
      u: string;
      exp: number;
    };
    if (typeof payload.u !== 'string' || typeof payload.exp !== 'number')
      return null;
    return { jti, username: payload.u, exp: payload.exp, sig };
  } catch {
    return null;
  }
}

/** 校验 token 在「服务端」仍有效：签名已过、已过期、或 DB 记录已消失（吊销/到期清理）均拒绝。 */
export function isTokenValidLocally(t: AccountToken): boolean {
  if (Date.now() >= t.exp) return false;
  // ensureDb 为异步（建表），但调用前已通过 login/register 触发过一次，
  // 此处用同步快照：若尚未就绪直接判否（首请求并发场景极少见，且会重试建库）。
  if (!db) return false;
  const row = db
    .prepare('SELECT jti FROM auth_tokens WHERE jti = ? AND expires_at > ?')
    .get(t.jti, Date.now());
  return !!row;
}

// ─── 账户操作（注册 / 登录）─────────────────────────────────────────────────
export interface AccountResult {
  ok: boolean;
  error?: string;
  username?: string;
  token?: string;
  email?: string;
}

function validUsername(u: string): boolean {
  // 3-32 位，字母/数字/下划线，避免空白与特殊字符（防注入与日志污染）。
  return /^[A-Za-z0-9_]{3,32}$/.test(u);
}

export async function registerUser(
  username: string,
  password: string,
  email?: string
): Promise<AccountResult> {
  username = (username || '').trim();
  password = password || '';
  email = (email || '').trim();
  if (!validUsername(username))
    return { ok: false, error: '用户名需为 3-32 位字母、数字、下划线' };
  if (password.length < 8) return { ok: false, error: '密码至少 8 位' };
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return { ok: false, error: '邮箱格式不正确' };
  await ensureDb();
  const existing = db
    .prepare('SELECT username FROM users WHERE username = ?')
    .get(username);
  if (existing) return { ok: false, error: '用户名已被占用' };
  db.prepare(
    'INSERT INTO users (username, password, email, created_at) VALUES (?, ?, ?, ?)'
  ).run(username, hashPassword(password), email || null, Date.now());
  return { ok: true, username };
}

export async function loginUser(
  username: string,
  password: string
): Promise<AccountResult> {
  username = (username || '').trim();
  await ensureDb();
  const row = db
    .prepare('SELECT password FROM users WHERE username = ?')
    .get(username) as { password: string } | undefined;
  // 统一延迟：用户不存在也走一次哈希比较，避免用户枚举时序差。
  const fake = hashPassword('__nonexistent__');
  const stored = row?.password ?? fake;
  if (!row || !verifyPassword(password, stored)) {
    return { ok: false, error: '用户名或密码错误' };
  }
  const token = await issueToken(username);
  return { ok: true, username, token };
}

/**
 * GitHub OAuth 登录：按 GitHub login 在本地 upsert 一个账户并签发登录态。
 *  - username 取 GitHub login（已做合法性校验，非法时回退用 gh_<id>）。
 *  - 密码用一次性随机 scrypt 占位：GitHub 用户无法用密码登录，只能走 OAuth，降低撞库风险。
 *  - 已存在则仅更新 email（GitHub 主邮箱可能变化），不覆盖密码。
 * 返回 { ok, username, token }（token 即 ah_auth cookie 值）。
 */
export async function upsertGithubUser(
  login: string,
  githubId: number,
  email?: string
): Promise<AccountResult> {
  // GitHub login 允许字母/数字/连字符/点，但本地用户名仅允许 [A-Za-z0-9_]，
  // 故做映射：非法字符替换成下划线，过长则截断到 32，并以 gh_ 前缀避免与手动注册撞名。
  let username = (login || `gh_${githubId}`)
    .replace(/[^A-Za-z0-9_]/g, '_')
    .slice(0, 32);
  if (!validUsername(username)) username = `gh_${githubId}`;
  email = (email || '').trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) email = '';

  await ensureDb();
  const existing = db
    .prepare('SELECT username FROM users WHERE username = ?')
    .get(username) as { username: string } | undefined;
  if (!existing) {
    db.prepare(
      'INSERT INTO users (username, password, email, created_at) VALUES (?, ?, ?, ?)'
    ).run(username, hashPassword(randomBytes(24).toString('hex')), email || null, Date.now());
  } else if (email) {
    // 已存在：仅同步 GitHub 主邮箱（不碰密码）。
    db.prepare('UPDATE users SET email = ? WHERE username = ?').run(email, username);
  }
  const token = await issueToken(username);
  return { ok: true, username, token };
}

// ─── Cookie 辅助 ────────────────────────────────────────────────────────────
export const AUTH_COOKIE = 'ah_auth';

function isLocalhost(req: { headers: Record<string, unknown> }): boolean {
  const host = String(req.headers.host ?? '');
  return (
    host.startsWith('localhost') ||
    host.startsWith('127.0.0.1') ||
    host.startsWith('[::1]')
  );
}

/** 构造 Set-Cookie 头值：HttpOnly + SameSite=Lax；仅非 localhost 置 Secure（dev 可 http）。 */
export function authCookieValue(
  req: { headers: Record<string, unknown> },
  token: string
): string {
  const parts = [
    `${AUTH_COOKIE}=${token}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${TOKEN_TTL_MS / 1000}`
  ];
  if (!isLocalhost(req)) parts.push('Secure');
  return parts.join('; ');
}

/** 从请求里取出 ah_auth cookie 值（无则返回 null）。 */
export function cookieValue(
  req: { headers: Record<string, string | string[] | undefined> },
  name: string
): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  const cookies = (Array.isArray(raw) ? raw.join('; ') : raw).split(';');
  for (const c of cookies) {
    const [k, ...v] = c.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

export const TOKEN_TTL = TOKEN_TTL_MS;

/**
 * 从请求的 ah_auth cookie 解析出当前已登录用户名（签名/过期/吊销任一失败返回 null）。
 * 供 /api/account/me 等「当前会话」端点使用。
 */
export function usernameFromCookie(
  req: { headers: Record<string, string | string[] | undefined> }
): string | null {
  const raw = cookieValue(req, AUTH_COOKIE);
  if (!raw) return null;
  const t = parseToken(raw);
  if (!t || !isTokenValidLocally(t)) return null;
  return t.username;
}

/** 当前登录用户的基础资料（username / email / 注册时间），供 /api/account/me 回填 UI。 */
export interface AccountProfile {
  username: string;
  email: string | null;
  createdAt: number;
}

/** 读取某用户的基础资料（库未就绪 / 用户不存在返回 null）。 */
export function getProfile(username: string): AccountProfile | null {
  if (!db) return null;
  const row = db
    .prepare(
      'SELECT username, email, created_at FROM users WHERE username = ?'
    )
    .get(username) as
    | { username: string; email: string | null; created_at: number }
    | undefined;
  if (!row) return null;
  return {
    username: row.username,
    email: row.email ?? null,
    createdAt: row.created_at
  };
}

/**
 * 修改密码：校验「旧密码」→ 校验「新密码强度」→ 覆盖 users.password。
 * 注意：仅改密码，不动 token（已登录会话保持有效，符合常见 UX；如需强制重登可另调 revokeAllTokens）。
 * 返回 ok / error（error 区分「旧密码错误」与「弱密码」）。
 */
export function changePassword(
  username: string,
  oldPassword: string,
  newPassword: string
): { ok: boolean; error?: string } {
  if (!username) return { ok: false, error: '未登录' };
  if (!newPassword || newPassword.length < 8)
    return { ok: false, error: '新密码至少 8 位' };
  // GitHub OAuth 用户：密码为一次性随机占位，无法用旧密码校验，直接拒绝自助改密。
  if (!db) return { ok: false, error: '服务端未就绪' };
  const row = db
    .prepare('SELECT password FROM users WHERE username = ?')
    .get(username) as { password: string } | undefined;
  if (!row) return { ok: false, error: '用户不存在' };
  if (!verifyPassword(oldPassword || '', row.password))
    return { ok: false, error: '旧密码错误' };
  db.prepare('UPDATE users SET password = ? WHERE username = ?').run(
    hashPassword(newPassword),
    username
  );
  return { ok: true };
}

/** 吊销某用户全部登录态（删除 auth_tokens 记录；cookie 由前端/登出接口同步清除）。 */
export function revokeAllTokens(username: string): void {
  if (!db) return;
  db.prepare('DELETE FROM auth_tokens WHERE username = ?').run(username);
}

/**
 * 构造「清除 ah_auth cookie」的 Set-Cookie 头值：空值 + 立即过期 + 与下发时一致的属性。
 * 用于 /api/account/logout。
 */
export function clearAuthCookie(req: {
  headers: Record<string, unknown>;
}): string {
  const parts = [
    `${AUTH_COOKIE}=`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT'
  ];
  if (!isLocalhost(req)) parts.push('Secure');
  return parts.join('; ');
}

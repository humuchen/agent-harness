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
/** 重置凭证有效期（15 分钟）。过期需重新申请。 */
const RESET_TTL_MS = 15 * 60 * 1000;

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
      await db.exec(
        `CREATE TABLE IF NOT EXISTS users (
          username TEXT PRIMARY KEY,
          password TEXT NOT NULL,            -- scrypt: salt:hash (hex)
          email TEXT,                        -- 选填联系邮箱（注册时收集，非登录标识）
          created_at INTEGER NOT NULL
        )`
      );
      await db.exec(
        `CREATE TABLE IF NOT EXISTS auth_tokens (
          jti TEXT PRIMARY KEY,
          username TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL
        )`
      );
      await db.exec(
        `CREATE INDEX IF NOT EXISTS idx_tokens_user ON auth_tokens(username)`
      );
      // 密码重置凭证表：token 一次性使用，过期由 RESET_TTL_MS 控制。
      await db.exec(
        `CREATE TABLE IF NOT EXISTS password_resets (
          token TEXT PRIMARY KEY,
          username TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL
        )`
      );
      await db.exec(
        `CREATE INDEX IF NOT EXISTS idx_resets_user ON password_resets(username)`
      );
      // 兼容旧库：早期 users 表无 email 列，ALTER 补列（列已存在则跳过）。
      try {
        const cols = await db.prepare('PRAGMA table_info(users)').all() as Record<string, unknown>[];
        const hasEmail = cols.some((c) => String(c.name) === 'email');
        if (!hasEmail) {
          await db.exec('ALTER TABLE users ADD COLUMN email TEXT');
        }
      } catch {
        /* 列已存在或 Turso 不支持该 DDL，忽略 */
      }
      // 兼容旧库：新增 role 列（默认 admin，保持既有密码账户行为不变）；新增 github_id 列（唯一，用于按 GitHub ID 关联，杜绝同名账号接管）。
      // 注意：ALTER 加 NOT NULL 列需带 DEFAULT，否则旧行会因无值报错；列已存在则跳过。
      try {
        const cols = await db.prepare('PRAGMA table_info(users)').all() as Record<string, unknown>[];
        const hasRole = cols.some((c) => String(c.name) === 'role');
        if (!hasRole) {
          await db.exec(
            "ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'admin'"
          );
        }
        const hasGh = cols.some((c) => String(c.name) === 'github_id');
        if (!hasGh) {
          // github_id 可能为空（密码/Google 账户），故允许 NULL；唯一索引仅对非空值生效。
          await db.exec('ALTER TABLE users ADD COLUMN github_id INTEGER');
          await db.exec(
            'CREATE UNIQUE INDEX IF NOT EXISTS idx_users_github_id ON users(github_id)'
          );
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
        const exists = await db
          .prepare('SELECT password FROM users WHERE username = ?')
          .get(adminUser) as { password: string } | undefined;
        if (!exists) {
          await db.prepare(
            'INSERT INTO users (username, password, email, created_at, role) VALUES (?, ?, ?, ?, ?)'
          ).run(adminUser, hashPassword(adminPass), null, Date.now(), 'admin');
        } else if (!verifyPassword(adminPass, exists.password)) {
          // 环境变量指定的密码与库中不一致（部署改密）→ 同步更新。
          await db.prepare('UPDATE users SET password = ?, role = ? WHERE username = ?').run(
            hashPassword(adminPass),
            'admin',
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
  /** 角色（admin/operator/viewer），随 token 下发，避免每次请求回查库。旧 token 无此字段时默认 admin（向后兼容）。 */
  role?: string;
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
  // 角色随 token 下发（默认 admin，兼容未列 role 的旧库）。
  const row = await db
    .prepare('SELECT role FROM users WHERE username = ?')
    .get(username) as { role?: string } | undefined;
  const role = row?.role || 'admin';
  const payloadB64 = b64urlJson({ u: username, exp, r: role });
  const sig = sign(jti, payloadB64);
  await db.prepare(
    `INSERT INTO auth_tokens (jti, username, expires_at, created_at) VALUES (?, ?, ?, ?)`
  ).run(jti, username, exp, Date.now());
  return `${jti}.${payloadB64}.${sig}`;
}

/** 解析 + 验签 token（不查库）。非法返回 null。 */
export function parseToken(raw: string): AccountToken | null {
  const parts = raw.split('.');
  if (parts.length !== 3) return null;
  const jti = parts[0];
  const payloadB64 = parts[1];
  const sig = parts[2];
  if (!jti || !payloadB64 || !sig) return null;
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
      r?: string;
    };
    if (typeof payload.u !== 'string' || typeof payload.exp !== 'number')
      return null;
    // 旧 token 无 r → 默认 admin（向后兼容）。
    const role = typeof payload.r === 'string' ? payload.r : 'admin';
    return { jti, username: payload.u, exp: payload.exp, sig, role };
  } catch {
    return null;
  }
}

/** 校验 token 在「服务端」仍有效：签名已过、已过期、或 DB 记录已消失（吊销/到期清理）均拒绝。 */
export async function isTokenValidLocally(t: AccountToken): Promise<boolean> {
  if (Date.now() >= t.exp) return false;
  if (!db) return false;
  const row = await db
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
  const existing = await db
    .prepare('SELECT username FROM users WHERE username = ?')
    .get(username);
  if (existing) return { ok: false, error: '用户名已被占用' };
  await db.prepare(
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
  const row = await db
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
  // ① 优先按 github_id 关联（核心防接管）：攻击者即便提前抢注同名密码账户，
  // 也无法劫持受害者的 GitHub 登录 —— 同一 GitHub id 永远落在同一行，密码由一次性随机占位，
  // 与 GitHub 账户绑定，攻击者拿不到。
  if (githubId) {
    const byGh = await db
      .prepare('SELECT username FROM users WHERE github_id = ?')
      .get(githubId) as { username: string } | undefined;
    if (byGh) {
      if (email) {
        await db.prepare('UPDATE users SET email = ? WHERE github_id = ?').run(email, githubId);
      }
      const token = await issueToken(byGh.username);
      return { ok: true, username: byGh.username, token };
    }
  }
  // ② 未命中 github_id：用户名可能已被「密码/其它来源」账户占用。若该占用账户并非同一 GitHub id，
  // 则绝不能并入（否则等于把 GitHub 登录锚定到他人账户），改为追加 _gh<id> 后缀另建独立行。
  const clash = await db
    .prepare('SELECT username, github_id FROM users WHERE username = ?')
    .get(username) as { username: string; github_id?: number | null } | undefined;
  let finalName = username;
  if (clash) {
    if (clash.github_id && githubId && clash.github_id === githubId) {
      // 防御性兜底：理论上①已命中，这里直接复用避免重复建行。
      const token = await issueToken(clash.username);
      return { ok: true, username: clash.username, token };
    }
    finalName = `${username}_gh${githubId || '0'}`;
  }
  await db.prepare(
    'INSERT INTO users (username, password, email, created_at, role, github_id) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(
    finalName,
    hashPassword(randomBytes(24).toString('hex')),
    email || null,
    Date.now(),
    'operator',
    githubId || null
  );
  const token = await issueToken(finalName);
  return { ok: true, username: finalName, token };
}

/**
 * Google OAuth 登录：按 Google sub（唯一 ID）在本地 upsert 一个账户并签发登录态。
 *  - username 取 name 的合法化映射，前缀 gg_ 避免与手动注册撞名。
 *  - 密码用一次性随机 scrypt 占位：Google 用户无法用密码登录，只能走 OAuth。
 *  - 已存在则仅同步 email / name（不覆盖密码）。
 * 返回 { ok, username, token }（token 即 ah_auth cookie 值）。
 */
export async function upsertGoogleUser(
  sub: string,
  email: string,
  name?: string
): Promise<AccountResult> {
  // 优先用 name 构造友好用户名；非法字符替换成下划线，截断到 24
  let base = (name || '').trim().replace(/\s+/g, '_').replace(/[^A-Za-z0-9_]/g, '').slice(0, 24);
  if (!base || base.length < 3) base = (email.split('@')[0] ?? '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 24) || `gg_${sub.slice(-8)}`;
  let username = base.startsWith('gg_') ? base : `gg_${base}`;
  username = username.slice(0, 32);
  if (!validUsername(username)) username = `gg_${sub.replace(/[^A-Za-z0-9_]/g, '').slice(-24)}`;
  if (!validUsername(username)) username = `gg_${sub.slice(-16)}`;
  email = (email || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) email = '';

  await ensureDb();
  const existing = db
    .prepare('SELECT username FROM users WHERE username = ?')
    .get(username) as { username: string } | undefined;
  if (!existing) {
    db.prepare(
      'INSERT INTO users (username, password, email, created_at, role) VALUES (?, ?, ?, ?, ?)'
    ).run(username, hashPassword(randomBytes(24).toString('hex')), email || null, Date.now(), 'operator');
  } else if (email) {
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
export async function usernameFromCookie(
  req: { headers: Record<string, string | string[] | undefined> }
): Promise<string | null> {
  const raw = cookieValue(req, AUTH_COOKIE);
  if (!raw) return null;
  const t = parseToken(raw);
  if (!t || !(await isTokenValidLocally(t))) return null;
  return t.username;
}

/** 当前登录用户的基础资料（username / email / role / 注册时间），供 /api/account/me 回填 UI。 */
export interface AccountProfile {
  username: string;
  email: string | null;
  role: string;
  createdAt: number;
}

/** 读取某用户的基础资料（库未就绪 / 用户不存在返回 null）。 */
export async function getProfile(username: string): Promise<AccountProfile | null> {
  if (!db) return null;
  const row = await db
    .prepare(
      'SELECT username, email, role, created_at FROM users WHERE username = ?'
    )
    .get(username) as
    | { username: string; email: string | null; role: string; created_at: number }
    | undefined;
  if (!row) return null;
  return {
    username: row.username,
    email: row.email ?? null,
    role: row.role ?? 'viewer',
    createdAt: row.created_at
  };
}

/**
 * 修改密码：校验「旧密码」→ 校验「新密码强度」→ 覆盖 users.password。
 * 注意：仅改密码，不动 token（已登录会话保持有效，符合常见 UX；如需强制重登可另调 revokeAllTokens）。
 * 返回 ok / error（error 区分「旧密码错误」与「弱密码」）。
 */
export async function changePassword(
  username: string,
  oldPassword: string,
  newPassword: string
): Promise<{ ok: boolean; error?: string }> {
  if (!username) return { ok: false, error: '未登录' };
  if (!newPassword || newPassword.length < 8)
    return { ok: false, error: '新密码至少 8 位' };
  // GitHub OAuth 用户：密码为一次性随机占位，无法用旧密码校验，直接拒绝自助改密。
  if (!db) return { ok: false, error: '服务端未就绪' };
  const row = await db
    .prepare('SELECT password FROM users WHERE username = ?')
    .get(username) as { password: string } | undefined;
  if (!row) return { ok: false, error: '用户不存在' };
  if (!verifyPassword(oldPassword || '', row.password))
    return { ok: false, error: '旧密码错误' };
  await db.prepare('UPDATE users SET password = ? WHERE username = ?').run(
    hashPassword(newPassword),
    username
  );
  return { ok: true };
}

/** 吊销某用户全部登录态（删除 auth_tokens 记录；cookie 由前端/登出接口同步清除）。 */
export async function revokeAllTokens(username: string): Promise<void> {
  if (!db) return;
  await db.prepare('DELETE FROM auth_tokens WHERE username = ?').run(username);
}

/**
 * 申请重置密码：按「用户名或注册邮箱」定位账号，存在则生成一次性重置凭证
 * （token + 15 分钟过期）写入 password_resets 表，并返回 token。
 *
 * 演示环境（无邮件服务）：token 直接返回前端，便于走通「申请 → 重置」全流程；
 * 生产环境应改为仅把 token 下发到用户邮箱、本接口不返回 token（避免链接泄露即失密）。
 * 账号不存在时明确返回错误——本项目注册接口已暴露「用户名已被占用」，
 * 用户枚举风险本就存在，保持一致性、方便用户自查输入。
 */
export interface ResetRequestResult {
  ok: boolean;
  error?: string;
  resetToken?: string;
}

export async function requestPasswordReset(
  identifier: string
): Promise<ResetRequestResult> {
  identifier = (identifier || '').trim();
  if (!identifier) return { ok: false, error: '请填写用户名或邮箱' };
  const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identifier);
  if (!isEmail && !validUsername(identifier))
    return { ok: false, error: '请输入有效的用户名或邮箱' };
  await ensureDb();
  const row = (await db
    .prepare('SELECT username FROM users WHERE username = ? OR email = ?')
    .get(identifier, identifier)) as { username: string } | undefined;
  if (!row) return { ok: false, error: '该账号不存在' };
  // 清理该用户旧的重置凭证（避免堆积 / 多链接并存）。
  await db
    .prepare('DELETE FROM password_resets WHERE username = ?')
    .run(row.username);
  const token = randomBytes(24).toString('hex');
  const exp = Date.now() + RESET_TTL_MS;
  await db
    .prepare(
      'INSERT INTO password_resets (token, username, expires_at, created_at) VALUES (?, ?, ?, ?)'
    )
    .run(token, row.username, exp, Date.now());
  return { ok: true, resetToken: token };
}

/**
 * 用重置凭证重设密码：校验 token 存在且未过期 → 校验新密码强度 →
 * 覆盖 users.password → 立即作废该 token（一次性）→ 吊销该用户全部已登录会话（强制重登）。
 * 返回 ok / error（区分「凭证无效 / 过期」与「弱密码」）。
 */
export async function resetPassword(
  token: string,
  newPassword: string
): Promise<{ ok: boolean; error?: string }> {
  token = (token || '').trim();
  newPassword = newPassword || '';
  if (!token) return { ok: false, error: '缺少重置凭证' };
  if (newPassword.length < 8) return { ok: false, error: '密码至少 8 位' };
  await ensureDb();
  const rec = (await db
    .prepare(
      'SELECT username, expires_at FROM password_resets WHERE token = ?'
    )
    .get(token)) as { username: string; expires_at: number } | undefined;
  if (!rec) return { ok: false, error: '重置凭证无效，请重新申请' };
  if (Date.now() >= rec.expires_at)
    return { ok: false, error: '重置凭证已过期，请重新申请' };
  // 一次性：先更新密码、作废凭证，再吊销既有登录态（强制重新登录）。
  await db
    .prepare('UPDATE users SET password = ? WHERE username = ?')
    .run(hashPassword(newPassword), rec.username);
  await db.prepare('DELETE FROM password_resets WHERE token = ?').run(token);
  await revokeAllTokens(rec.username);
  return { ok: true };
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

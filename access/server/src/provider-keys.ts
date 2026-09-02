/**
 * 用户自带 LLM 凭据（BYOK）· 数据层 + 凭据解析链。
 *
 * 这是「移除环境写死 OPEN_API_KEY、按用户落库、运行期 per-run 注入」的核心模块。
 * 设计约束（详见 docs/01-architecture/user-provider-key-design.md）：
 *  - 凭据解析集中在 server 层，core 完全不动（core 仍走「配置对象优先 → env 兜底」，
 *    本模块把解析结果作为 apiKey 显式传入 createOpenRouterLLM）。
 *  - 绝不把用户 Key 写入 process.env（Node 单进程并发多 run 会串号）。
 *  - 加解密只在服务端进行（复用 custom-models 的 AES-256-GCM，密钥 AH_CRYPTO_KEY）；
 *    前端只传明文 Key（走 HTTPS），服务端加密落库，GET 只回掩码 key_hint，密文不出网。
 *  - 按 owner（= 登录身份 AuthContext.sub）隔离：所有读写以服务端 ctx.sub 为准，
 *    忽略请求体里的任何 owner/username 字段（防越权）。
 *
 * 数据库：独立库文件（与 users 同生命周期语义，但单文件单句柄避免与 accounts 库抢锁），
 * 经 getDbAdapter 双后端（sqlite / turso）。
 */

import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { getDbAdapter } from '@agent-harness/core';
import { encryptApiKey, decryptApiKey, getCustomModel } from './custom-models';

// ─── provider 默认端点 ───────────────────────────────────────────────────────
export type ProviderId = 'openrouter' | 'openai' | 'custom';

const PROVIDER_BASE_URL: Record<ProviderId, string> = {
  openrouter: 'https://openrouter.ai/api/v1',
  openai: 'https://api.openai.com/v1',
  custom: ''
};

const PROVIDER_WHITELIST = new Set<string>(['openrouter', 'openai', 'custom']);

// ─── P2.3 密钥轮换提醒阈值 ────────────────────────────────────────────────────
// 超过该天数未更新（即未重新保存）的 Key 标记为 needs_rotation，前端提示用户轮换。
// 可通过 env KEY_ROTATION_DAYS 覆盖，默认 90 天。
export const KEY_ROTATION_DAYS = Math.max(
  1,
  Number(process.env.KEY_ROTATION_DAYS ?? 90) || 90
);

/** 依据最后更新时间判定是否需要轮换。updatedAt 为 0（未知）→ 视为需要。 */
export function computeNeedsRotation(updatedAt: number | undefined): boolean {
  if (!updatedAt || updatedAt <= 0) return true;
  const ageMs = Date.now() - updatedAt;
  return ageMs > KEY_ROTATION_DAYS * 24 * 60 * 60 * 1000;
}

// ─── 凭据解析结果 ────────────────────────────────────────────────────────────
export interface CredentialResult {
  /** 解析到的明文 Key（主 Key）；无则 undefined（调用方应据此拒绝 real 模式）。 */
  apiKey?: string;
  /**
   * P2.4 多 Key：解析到的全部明文 Key（含主 Key 与附加 Key）。
   * 仅 user 档（含多 Key）填充；单 Key 时等同于 [apiKey]，便于调用方统一处理。
   */
  apiKeys?: string[];
  /** 解析到的 baseUrl（可为空 → 用 provider 内置默认）。 */
  baseUrl?: string;
  /** 命中的 provider 标识（用于审计 / 状态展示）。 */
  provider?: string;
  /** 来源档位：custom_model | user | user_supplied | platform | none。 */
  source: 'custom_model' | 'user' | 'user_supplied' | 'platform' | 'none';
  /** 仅 user 档返回，供 /api/state 回显掩码。 */
  keyHint?: string;
  /** P2.3 该 Key 是否已超过轮换阈值（仅 user 档有效）。 */
  needsRotation?: boolean;
}

// ─── 库存储 ──────────────────────────────────────────────────────────────────
let db: any = null;
let dbReady: Promise<void> | null = null;

function getDbFile(): string {
  return process.env.PROVIDER_KEYS_DB_FILE || join(process.cwd(), 'data', 'provider-keys.db');
}

async function ensureDb(): Promise<void> {
  if (db) return;
  if (!dbReady) {
    dbReady = (async () => {
      const file = getDbFile();
      db = getDbAdapter({ file });
      await db.exec(
        `CREATE TABLE IF NOT EXISTS user_provider_keys (
          owner             TEXT    NOT NULL,
          provider          TEXT    NOT NULL,
          base_url          TEXT,
          key_cipher        TEXT    NOT NULL,
          key_hint          TEXT    NOT NULL,
          status            TEXT    NOT NULL DEFAULT 'unverified',
          last_verified_at  INTEGER,
          last_error        TEXT,
          created_at        INTEGER NOT NULL,
          updated_at        INTEGER NOT NULL,
          PRIMARY KEY (owner, provider)
        )`
      );
      await db.exec(
        'CREATE INDEX IF NOT EXISTS idx_upk_owner ON user_provider_keys(owner)'
      );
      // P2.4：多 Key 支持。向后兼容迁移——新增可空列存储附加 Key（JSON 数组）。
      // 现有单 Key 行 extra_keys_json 为 NULL，解析时视为无附加 Key。
      // exec 返回 void（不同后端可能异步），用 try/catch 包裹实现幂等（列已存在则忽略）。
      try {
        await db.exec(
          'ALTER TABLE user_provider_keys ADD COLUMN extra_keys_json TEXT'
        );
      } catch {
        /* 列已存在（迁移过）→ 忽略 */
      }
    })();
  }
  await dbReady;
}

// ─── 类型 ────────────────────────────────────────────────────────────────────
export interface ProviderKeyRow {
  owner: string;
  provider: string;
  baseUrl?: string;
  keyCipher: string;
  keyHint: string;
  status: 'unverified' | 'valid' | 'invalid';
  lastVerifiedAt?: number;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
  /** P2.4：附加 Key（主 Key 之后的其余 Key）。 */
  extraKeys?: Array<{ keyCipher: string; keyHint: string }>;
}

/** 对外（GET 列表）脱敏后的形态：永不含密文或明文。 */
export interface ProviderKeyPublic {
  provider: string;
  baseUrl?: string;
  keyHint: string;
  status: 'unverified' | 'valid' | 'invalid';
  lastVerifiedAt?: number;
  lastError?: string;
  /** P2.4：本 provider 的 Key 总数（主 Key + 附加 Key）。 */
  keyCount?: number;
  /** P2.3：是否已到轮换阈值，前端据此提示用户轮换。 */
  needsRotation?: boolean;
}

// ─── 掩码 ────────────────────────────────────────────────────────────────────
/**
 * 仅保留首尾若干字符生成掩码（sk-or-v1-…a91f），中间用 · 填充。
 * 过短 Key 退化为「前 0 + 后 4」。明文绝不出网。
 */
export function maskKey(plain: string): string {
  const s = plain.trim();
  if (!s) return '';
  if (s.length <= 11) return '••••' + s.slice(-4);
  return s.slice(0, 7) + '…' + s.slice(-4);
}

// ─── 行读写 ──────────────────────────────────────────────────────────────────
function rowToPublic(r: any): ProviderKeyPublic {
  const extraKeys: Array<{ keyCipher: string; keyHint: string }> = parseExtraKeys(
    typeof r.extra_keys_json === 'string' ? r.extra_keys_json : null
  );
  return {
    provider: r.provider,
    ...(r.base_url ? { baseUrl: r.base_url } : {}),
    keyHint: r.key_hint,
    status: r.status,
    ...(r.last_verified_at ? { lastVerifiedAt: r.last_verified_at } : {}),
    ...(r.last_error ? { lastError: r.last_error } : {}),
    keyCount: 1 + extraKeys.length,
    needsRotation: computeNeedsRotation(r.updated_at)
  };
}

/** 解析 extra_keys_json（容错：非法 JSON / 非数组 → 空数组）。 */
function parseExtraKeys(
  raw: string | null
): Array<{ keyCipher: string; keyHint: string }> {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((k: any) => k && typeof k.c === 'string' && typeof k.h === 'string')
      .map((k: any) => ({ keyCipher: k.c, keyHint: k.h }));
  } catch {
    return [];
  }
}

export async function getUserProviderKey(
  owner: string,
  provider: string
): Promise<ProviderKeyRow | null> {
  await ensureDb();
  const r = await db
    .prepare(
      'SELECT owner, provider, base_url, key_cipher, key_hint, status, last_verified_at, last_error, created_at, updated_at, extra_keys_json FROM user_provider_keys WHERE owner = ? AND provider = ?'
    )
    .get(owner, provider) as any | undefined;
  if (!r) return null;
  return {
    owner: r.owner,
    provider: r.provider,
    ...(r.base_url ? { baseUrl: r.base_url } : {}),
    keyCipher: r.key_cipher,
    keyHint: r.key_hint,
    status: r.status,
    ...(r.last_verified_at ? { lastVerifiedAt: r.last_verified_at } : {}),
    ...(r.last_error ? { lastError: r.last_error } : {}),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    extraKeys: parseExtraKeys(
      typeof r.extra_keys_json === 'string' ? r.extra_keys_json : null
    )
  };
}

export async function listUserProviderKeys(
  owner: string
): Promise<ProviderKeyPublic[]> {
  await ensureDb();
  const rows = (await db
    .prepare(
      'SELECT owner, provider, base_url, key_hint, status, last_verified_at, last_error, updated_at, extra_keys_json FROM user_provider_keys WHERE owner = ? ORDER BY updated_at DESC'
    )
    .all(owner)) as any[];
  return rows.map(rowToPublic);
}

/**
 * 保存（upsert）某用户的某 provider Key。
 * 入参 apiKey / keys 为明文（前端走 HTTPS 传来），服务端 AES-GCM 逐个加密落库。
 * - 单 Key（兼容旧前端）：传 `apiKey`，等效于 keys=[apiKey]。
 * - 多 Key（P2.4）：传 `keys`（长度≥1，keys[0] 为主 Key，其余为附加 Key）。
 * 返回主 Key 掩码与状态。加密失败（AH_CRYPTO_KEY 未配置）抛出明确错误，不静默落库。
 */
export async function saveUserProviderKey(
  owner: string,
  provider: ProviderId,
  opts: { apiKey?: string; keys?: string[]; baseUrl?: string }
): Promise<{ keyHint: string; status: 'unverified' }> {
  // 归一化为 keys 数组：优先 keys，否则 apiKey。
  const keys = (opts.keys && opts.keys.length ? opts.keys : [opts.apiKey])
    .map((k) => (k ?? '').trim())
    .filter(Boolean);
  if (keys.length === 0) throw new Error('apiKey 不能为空');
  const baseUrl = opts.baseUrl?.trim() || '';
  // 主 Key（keys[0]）落主列；其余落 extra_keys_json。
  const primaryKey = keys[0]!;
  const primaryCipher = encryptApiKey(primaryKey); // 失败抛错 → 调用方捕获返回 400
  const primaryHint = maskKey(primaryKey);
  const extra = keys.slice(1).map((k) => ({
    c: encryptApiKey(k),
    h: maskKey(k)
  }));
  const extraJson = extra.length ? JSON.stringify(extra) : null;
  const now = Date.now();
  await ensureDb();
  await db
    .prepare(
      `INSERT INTO user_provider_keys (owner, provider, base_url, key_cipher, key_hint, status, created_at, updated_at, extra_keys_json)
       VALUES (?, ?, ?, ?, ?, 'unverified', ?, ?, ?)
       ON CONFLICT(owner, provider) DO UPDATE SET
         base_url = excluded.base_url,
         key_cipher = excluded.key_cipher,
         key_hint = excluded.key_hint,
         extra_keys_json = excluded.extra_keys_json,
         status = 'unverified',
         last_verified_at = NULL,
         last_error = NULL,
         updated_at = excluded.updated_at`
    )
    .run(
      owner,
      provider,
      baseUrl || null,
      primaryCipher,
      primaryHint,
      now,
      now,
      extraJson
    );
  return { keyHint: primaryHint, status: 'unverified' };
}

export async function deleteUserProviderKey(
  owner: string,
  provider: string
): Promise<void> {
  await ensureDb();
  await db
    .prepare('DELETE FROM user_provider_keys WHERE owner = ? AND provider = ?')
    .run(owner, provider);
}

export async function setVerifyResult(
  owner: string,
  provider: string,
  ok: boolean,
  error?: string
): Promise<void> {
  await ensureDb();
  await db
    .prepare(
      `UPDATE user_provider_keys SET status = ?, last_verified_at = ?, last_error = ? WHERE owner = ? AND provider = ?`
    )
    .run(ok ? 'valid' : 'invalid', Date.now(), error ?? null, owner, provider);
}

// ─── 模型 → provider 推断 ────────────────────────────────────────────────────
function inferProvider(model?: string): ProviderId {
  if (model && model.startsWith('openai/')) return 'openai';
  return 'openrouter';
}

// ─── 凭据解析链（单一事实来源）──────────────────────────────────────────────
/**
 * 解析一次 run 应使用哪个 LLM 凭据。
 *
 * 优先级（见设计文档 §3）：
 *  1. 自定义模型（custom_models，含 apiKey 密文）→ 用户自带任意 OpenAI 兼容端点。
 *  2. 该用户的 user_provider_keys[provider] → 本方案主链路（OpenRouter / OpenAI）。
 *  3. 请求体直接带 modelApiKey（旧自定义模型前端路径，向后兼容）。
 *  4. 平台兜底 Key（PLATFORM_OPEN_API_KEY + ALLOW_PLATFORM_KEY=true，默认关）。
 *  5. 无 → source='none'（调用方据 mode 拒绝或降级 mock）。
 *
 * @param owner 登录身份（ctx.sub），不可伪造。
 * @param opts.model 本次请求的模型（用于自定义模型匹配与 provider 推断）。
 * @param opts.modelBaseUrl / opts.modelApiKey 来自旧自定义模型前端路径（明文），向后兼容。
 */
export async function resolveRunCredential(
  owner: string,
  opts: { model?: string; modelBaseUrl?: string; modelApiKey?: string } = {}
): Promise<CredentialResult> {
  const { model, modelBaseUrl, modelApiKey } = opts;

  // 1. 自定义模型（P1.1 owner 隔离）：仅命中「本人私有」或「平台遗留（__legacy__）」模型，
  //    绝不返回他人私有模型。平台遗留模型对所有用户可用（向后兼容单租户时代）。
  if (model) {
    try {
      const cm = await getCustomModel(model, owner, true);
      if (cm?.apiKey) {
        const plain = decryptApiKey(cm.apiKey);
        return {
          apiKey: plain,
          apiKeys: [plain],
          baseUrl: cm.baseUrl,
          provider: 'custom_model',
          source: 'custom_model'
        };
      }
    } catch {
      /* 自定义模型读取失败不阻断主链路 */
    }
  }

  // 2. 用户级 provider Key（主链路）。
  const provider = inferProvider(model);
  try {
    const row = await getUserProviderKey(owner, provider);
    if (row?.keyCipher) {
      const plain = decryptApiKey(row.keyCipher);
      if (plain) {
        // P2.4：拼接主 Key + 附加 Key（附加 Key 解密失败的跳过，不阻断主链路）。
        const apiKeys: string[] = [plain];
        if (row.extraKeys && row.extraKeys.length) {
          for (const ex of row.extraKeys) {
            try {
              const p = decryptApiKey(ex.keyCipher);
              if (p) apiKeys.push(p);
            } catch {
              /* 单条附加 Key 解密失败：忽略 */
            }
          }
        }
        return {
          apiKey: plain,
          apiKeys,
          baseUrl: row.baseUrl || PROVIDER_BASE_URL[provider as ProviderId] || undefined,
          provider,
          source: 'user',
          keyHint: row.keyHint,
          needsRotation: computeNeedsRotation(row.updatedAt)
        };
      }
    }
  } catch {
    /* DB 未就绪等：回落后续档位 */
  }

  // 3. 旧前端自定义模型路径（明文 Key 随请求而来，向后兼容）。
  if (modelApiKey) {
    return {
      apiKey: modelApiKey,
      apiKeys: [modelApiKey],
      baseUrl: modelBaseUrl,
      provider: 'custom',
      source: 'user_supplied'
    };
  }

  // 4. 平台兜底（默认关闭，仅内部演示 / 灰度）。
  if (
    process.env.ALLOW_PLATFORM_KEY === 'true' &&
    process.env.PLATFORM_OPEN_API_KEY &&
    process.env.PLATFORM_OPEN_API_KEY.trim()
  ) {
    return {
      apiKey: process.env.PLATFORM_OPEN_API_KEY.trim(),
      apiKeys: [process.env.PLATFORM_OPEN_API_KEY.trim()],
      baseUrl:
        process.env.PLATFORM_OPEN_BASE_URL?.trim() ||
        PROVIDER_BASE_URL.openrouter,
      provider: 'platform',
      source: 'platform'
    };
  }

  // 5. 无凭据。
  return { source: 'none' };
}

// ─── 连通性校验（OpenRouter /key）────────────────────────────────────────────
interface VerifyCacheEntry {
  at: number;
  result: { valid: boolean; limit?: number; usage?: number; error?: string };
}
const verifyCache = new Map<string, VerifyCacheEntry>();
const VERIFY_TTL_MS = 60_000;

/**
 * 校验 Key 是否对 OpenRouter 有效（GET https://openrouter.ai/api/v1/key）。
 * 结果缓存 60s，避免每次 run 前都打网络。非 openrouter provider 暂不联网校验，
 * 直接回 unverified（undefined 状态由调用方按 unverified 处理）。
 */
export async function verifyProviderKey(
  provider: ProviderId,
  apiKey: string
): Promise<{ valid: boolean; limit?: number; usage?: number; error?: string }> {
  if (provider !== 'openrouter') {
    // 其它 provider 暂不支持在线校验：交给实际调用时由上游 401 判定。
    return { valid: true };
  }
  const cacheKey = `${provider}:${apiKey.slice(0, 8)}`;
  const cached = verifyCache.get(cacheKey);
  if (cached && Date.now() - cached.at < VERIFY_TTL_MS) {
    return cached.result;
  }
  try {
    const res = await fetch('https://openrouter.ai/api/v1/key', {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' }
    });
    if (!res.ok) {
      const result = { valid: false, error: `HTTP ${res.status}` };
      verifyCache.set(cacheKey, { at: Date.now(), result });
      return result;
    }
    const data = (await res.json()) as {
      data?: { limit?: number; usage?: number };
    };
    const result = {
      valid: true,
      ...(typeof data?.data?.limit === 'number'
        ? { limit: data.data.limit }
        : {}),
      ...(typeof data?.data?.usage === 'number'
        ? { usage: data.data.usage }
        : {})
    };
    verifyCache.set(cacheKey, { at: Date.now(), result });
    return result;
  } catch (e) {
    // 网络不可达：乐观视为有效（真实请求会再次判定），但不缓存。
    return { valid: true, error: e instanceof Error ? e.message : String(e) };
  }
}

// ─── HTTP 路由（4 端点，owner 强制 = ctx.sub）────────────────────────────────
/**
 * 注册 /api/account/provider-keys 路由。
 * 调用方（server.ts）必须先 guard 拿到 ctx，并传入 ctx.sub 作为 owner。
 * 一律以 ctx.sub 为准，忽略请求体任何 owner/username 字段（防越权）。
 *
 * @returns true 表示已处理并响应；false 表示路径未命中。
 */
export async function registerProviderKeyRoutes(
  _req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
  body: any,
  owner: string
): Promise<boolean> {
  const base = '/api/account/provider-keys';
  if (!path.startsWith(base)) return false;

  const sendJson = (obj: unknown, code = 200) => {
    res.writeHead(code, {
      'content-type': 'application/json',
      'cache-control': 'no-store'
    });
    res.end(JSON.stringify(obj));
  };

  // GET /api/account/provider-keys → 本用户全部（脱敏）。
  if (method === 'GET' && path === base) {
    const list = await listUserProviderKeys(owner);
    sendJson({ keys: list });
    return true;
  }

  // 解析 :provider 段（支持 /verify 子路径）。
  const rest = path.slice(base.length);
  const m = /^\/([^/]+)(\/verify)?$/.exec(rest);
  if (!m) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
    return true;
  }
  const provider = decodeURIComponent(m[1] ?? '');
  const isVerify = !!m[2];

  if (!PROVIDER_WHITELIST.has(provider)) {
    sendJson({ error: `unsupported provider: ${provider}` }, 400);
    return true;
  }
  const pid = provider as ProviderId;

  // POST /api/account/provider-keys/:provider/verify
  if (method === 'POST' && isVerify) {
    const row = await getUserProviderKey(owner, pid);
    if (!row?.keyCipher) {
      sendJson({ status: 'invalid', error: '尚未保存该 provider 的 Key' }, 404);
      return true;
    }
    const plain = decryptApiKey(row.keyCipher);
    const result = await verifyProviderKey(pid, plain);
    await setVerifyResult(owner, pid, result.valid, result.error);
    sendJson({ status: result.valid ? 'valid' : 'invalid', ...result });
    return true;
  }

  // PUT /api/account/provider-keys/:provider → 保存。
  if (method === 'PUT') {
    // P2.4：支持多 Key（keys 数组）或单 Key（apiKey，向后兼容）。
    const keys = Array.isArray(body?.keys)
      ? (body.keys as unknown[])
          .filter((k) => typeof k === 'string')
          .map((k) => (k as string).trim())
          .filter(Boolean)
      : [];
    const singleApiKey =
      typeof body?.apiKey === 'string' ? body.apiKey.trim() : '';
    if (keys.length === 0 && !singleApiKey) {
      sendJson({ error: 'apiKey required' }, 400);
      return true;
    }
    const baseUrl =
      typeof body?.baseUrl === 'string' ? body.baseUrl.trim() : undefined;
    try {
      const saved = await saveUserProviderKey(owner, pid, {
        ...(keys.length ? { keys } : { apiKey: singleApiKey }),
        ...(baseUrl ? { baseUrl } : {})
      });
      sendJson({ ok: true, keyCount: keys.length || 1, ...saved });
    } catch (e) {
      sendJson(
        { error: e instanceof Error ? e.message : '加密保存失败' },
        400
      );
    }
    return true;
  }

  // DELETE /api/account/provider-keys/:provider
  if (method === 'DELETE') {
    await deleteUserProviderKey(owner, pid);
    sendJson({ ok: true });
    return true;
  }

  res.writeHead(405, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'method not allowed' }));
  return true;
}

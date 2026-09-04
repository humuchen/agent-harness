/**
 * 自定义模型持久化（SQLite） + REST 路由 + AES-GCM 加解密 helper。
 *
 * 约束：
 *  - 自定义模型统一走 SQLite（不再 frontend localStorage）；
 *  - API Key 由前端传明文（走 HTTPS），服务端在此层 AES-GCM 加密落库，GET 仅回掩码；
 *  - 密钥来源：仓库根 .env 的 AH_CRYPTO_KEY（64 hex / 32 bytes），仅服务端持有。
 *  - owner 隔离（P1.1）：每行归属某登录身份（ctx.sub）；存量库无 owner 的行在
 *    ensureDb 时回填为平台哨兵 __legacy__，由 admin/operator 托管，普通用户仅见自己。
 */

import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { getDbAdapter } from '@agent-harness/core';

/** 平台哨兵 owner：单租户时代遗留的自定义模型在 owner 隔离后统一归入此标识，
 *  由 admin/operator（includeLegacy）可见可管；普通用户不可见，避免越权读他人模型。 */
export const LEGACY_OWNER = '__legacy__';

// ─── 工具函数 ────────────────────────────────────────────────────────────────

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * 从运行时环境取 AES-256 key（64 hex chars）。
 *
 * 服务端是纯 tsc 编译、没有 Vite define 注入，因此不依赖任何 build-time 全局，
 * 统一从 process.env.AH_CRYPTO_KEY 读取（server.ts 顶部 loadSecrets() 已把
 * 仓库根 .env 装配进 process.env）。与前端 vite.config.ts 注入的是同一个值。
 * 未配置则抛错（禁止静默降级为明文）。
 */
function getBuildTimeCryptoKey(): Uint8Array {
  const raw = (process.env.AH_CRYPTO_KEY || '').trim();
  if (!raw || raw.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error(
      'missing crypto key: AH_CRYPTO_KEY env must be 64 hex chars (AES-256)。' +
        '请在仓库根 .env 配置 AH_CRYPTO_KEY 后重启服务。'
    );
  }
  return hexToBytes(raw);
}

// ─── 服务端 AES-GCM 解密 ─────────────────────────────────────────────────────

/**
 * 服务端加密：输入明文，输出 base64(version || iv || AAD || ciphertext + authTag)。
 * 与前端 crypto.ts 的 encryptApiKey 配对（同 key、同 iv 长度、同输出格式）。
 *
 * P1-6: 新增 1 字节版本前缀（0x01）+ AAD（tenantId + rowId），支持密钥轮换且不
 * 需全量重加密；同时使 AAD 绑定到业务上下文，防止密文在其他租户/行之间复用。
 */
/** 当前 AAD 派生逻辑（encrypt 与 decrypt 必须完全一致）。 */
function buildAad(opts?: { tenantId?: string; rowId?: string }): Buffer {
  const aadParts = [opts?.tenantId ?? '', opts?.rowId ?? ''];
  return Buffer.from(aadParts.join('\x00'));
}

export function encryptApiKey(plaintext: string, opts?: { tenantId?: string; rowId?: string }): string {
  const { createCipheriv, randomBytes } =
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('node:crypto') as typeof import('node:crypto');
  const key = getBuildTimeCryptoKey();
  const iv = randomBytes(12);
  const version = Buffer.from([0x01]); // 版本前缀
  const aad = buildAad(opts);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  if (aad.length > 0) cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const combined = Buffer.concat([version, iv, ct, tag]);
  return combined.toString('base64');
}

/**
 * 服务端解密：输入 base64(version || iv || ciphertext + authTag)，输出明文 apiKey。
 *
 * P1-7: 返回结果区分「未配置」（无密文）与「解密失败」（密文损坏/密钥不匹配），
 * 便于排障。解密失败抛出 Error，调用方可捕获区分处理。
 */
export function decryptApiKey(payload: unknown, opts?: { tenantId?: string; rowId?: string }): string {
  if (typeof payload !== 'string') return '';
  const raw = Buffer.from(payload, 'base64');
  // 最短合法载荷：1(version) + 12(iv) + 16(tag)，明文可为空但实际 key 不为空。
  if (raw.length < 1 + 12 + 16) return '';
  // P1-6 之后密文带 1 字节版本前缀（0x01）；此前的存量密文为
  // base64(iv12 ‖ ct ‖ tag16)（无版本前缀、无 AAD）。两者都需向后兼容，
  // 否则存量自定义模型 / provider key / mcp token 一解密就抛
  // "unsupported key encryption version"，导致 GET 列表整体 500。
  const aad = buildAad(opts);
  // 先按新格式（带版本前缀 + AAD）尝试；首字节恰为 0x01 的旧格式密文
  // 或 AAD 不匹配会在此抛错，落入下方的旧格式回退。
  if (raw[0] === 0x01) {
    try {
      return tryDecrypt(raw, 1, aad);
    } catch {
      /* 落入旧格式回退 */
    }
  }
  // 旧格式回退：base64(iv12 ‖ ct ‖ tag16)，无版本前缀、无 AAD。
  try {
    return tryDecrypt(raw, 0, undefined);
  } catch {
    // tag 校验失败 / key 不匹配：两种格式都解不开 → 拒绝而非静默降级。
    throw new Error('api key decryption failed: invalid auth tag or key mismatch');
  }
}

/** 核心 GCM 解密：versionOffset 为跳过的版本前缀字节数（新格式=1，旧格式=0）。 */
function tryDecrypt(raw: Buffer, versionOffset: number, aad?: Buffer): string {
  const iv = raw.subarray(versionOffset, versionOffset + 12);
  const tag = raw.subarray(raw.length - 16);
  const ct = raw.subarray(versionOffset + 12, raw.length - 16);
  const { createDecipheriv } =
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('node:crypto') as typeof import('node:crypto');
  const decipher = createDecipheriv('aes-256-gcm', getBuildTimeCryptoKey(), iv);
  // 仅当 AAD 非空才设置（加密端同样逻辑）；新旧格式在「无 opts」场景下 AAD 均为空，天然一致。
  if (aad && aad.length > 0) decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString('utf8');
}

// ─── SQLite 存储 ─────────────────────────────────────────────────────────────

export interface CustomModelRow {
  id: string;
  baseUrl?: string;
  /** AES-GCM 密文（base64(iv + ciphertext)） */
  apiKey?: string;
  /** 明文掩码（首尾若干字符），脱敏展示用，密文不出网。 */
  keyHint?: string;
  /** 归属用户（= 登录身份 ctx.sub）；存量库无 owner 的行回填为 LEGACY_OWNER（平台哨兵）。 */
  owner?: string;
  updatedAt: number;
}

/** 对外（GET）脱敏形态：永不含密文或明文。 */
export interface CustomModelPublic {
  id: string;
  baseUrl?: string;
  keyHint: string;
  updatedAt: number;
}

let db: any = null;
let dbReady: Promise<void> | null = null;

const DEFAULT_DB = process.env.CUSTOM_MODELS_DB_FILE || '/var/lib/agent-harness/custom-models.db';

async function ensureDb() {
  if (db) return;
  if (!dbReady) {
    dbReady = (async () => {
      const file = DEFAULT_DB;
      // 使用统一适配器（自动按 DB_BACKEND 环境变量选择 sqlite 或 turso）
      db = getDbAdapter({ file });
      await db.exec(
        `CREATE TABLE IF NOT EXISTS custom_models (
          id TEXT PRIMARY KEY,
          base_url TEXT,
          api_key TEXT,
          updated_at INTEGER NOT NULL,
          key_hint TEXT,
          owner TEXT
        )`
      );
      // 存量库（无 key_hint 列）向后兼容：幂等加列，失败（已存在）忽略。
      try {
        await db.exec('ALTER TABLE custom_models ADD COLUMN key_hint TEXT');
      } catch {
        /* 列已存在 */
      }
      // P1.1：存量库（无 owner 列）向后兼容：幂等加列。
      try {
        await db.exec('ALTER TABLE custom_models ADD COLUMN owner TEXT');
      } catch {
        /* 列已存在 */
      }
      // P1.1：存量行（owner 为空）回填为平台哨兵，使单租户时代的自定义模型在
      // owner 隔离后由 admin/operator 托管；普通用户只可见自己的。幂等。
      try {
        await db
          .prepare('UPDATE custom_models SET owner = ? WHERE owner IS NULL OR owner = ?')
          .run(LEGACY_OWNER, '');
      } catch {
        /* 表为空或列异常时忽略 */
      }
    })();
  }
  await dbReady;
}

export async function listCustomModels(
  owner: string,
  includeLegacy = false
): Promise<CustomModelRow[]> {
  await ensureDb();
  let sql =
    'SELECT id, base_url, api_key, updated_at, key_hint, owner FROM custom_models';
  const params: unknown[] = [];
  if (includeLegacy) {
    sql += ' WHERE owner = ? OR owner = ?';
    params.push(owner, LEGACY_OWNER);
  } else {
    sql += ' WHERE owner = ?';
    params.push(owner);
  }
  sql += ' ORDER BY updated_at DESC';
  const rows = (await db.prepare(sql).all(...params)) as any[];
  return rows.map((r) => ({
    id: r.id,
    ...(r.base_url ? { baseUrl: r.base_url } : {}),
    ...(r.api_key ? { apiKey: r.api_key } : {}),
    ...(r.key_hint ? { keyHint: r.key_hint } : {}),
    ...(r.owner ? { owner: r.owner } : {}),
    updatedAt: r.updated_at,
  }));
}

export async function getCustomModel(
  id: string,
  owner?: string,
  includeLegacy = false
): Promise<CustomModelRow | null> {
  await ensureDb();
  let sql =
    'SELECT id, base_url, api_key, updated_at, key_hint, owner FROM custom_models WHERE id = ?';
  const params: unknown[] = [id];
  if (owner) {
    // 命中本人 OR（includeLegacy 时）平台哨兵；绝不返回他人私有模型。
    sql += ' AND (owner = ?' + (includeLegacy ? ' OR owner = ?)' : ')');
    params.push(owner);
    if (includeLegacy) params.push(LEGACY_OWNER);
  } else if (includeLegacy) {
    sql += ' AND owner = ?';
    params.push(LEGACY_OWNER);
  }
  const r = (await db.prepare(sql).get(...params)) as any | undefined;
  if (!r) return null;
  return {
    id: r.id,
    ...(r.base_url ? { baseUrl: r.base_url } : {}),
    ...(r.api_key ? { apiKey: r.api_key } : {}),
    ...(r.key_hint ? { keyHint: r.key_hint } : {}),
    ...(r.owner ? { owner: r.owner } : {}),
    updatedAt: r.updated_at,
  };
}

export async function putCustomModel(row: Omit<CustomModelRow, 'updatedAt'>): Promise<void> {
  await ensureDb();
  const now = Date.now();
  const stmt = db.prepare(
    `INSERT INTO custom_models (id, base_url, api_key, updated_at, key_hint, owner)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       base_url = excluded.base_url,
       api_key = excluded.api_key,
       updated_at = excluded.updated_at,
       key_hint = excluded.key_hint`
    // 注意：owner 不进 UPDATE SET —— 冲突时保留原 owner（legacy 仍是 legacy，
    // 用户私有仍是该用户），避免 POST 误把他人/平台模型据为己有。
  );
  await stmt.run(
    row.id,
    row.baseUrl ?? null,
    row.apiKey ?? null,
    now,
    row.keyHint ?? null,
    row.owner ?? null
  );
}

export async function deleteCustomModel(
  id: string,
  owner: string,
  includeLegacy = false
): Promise<void> {
  await ensureDb();
  let sql = 'DELETE FROM custom_models WHERE id = ?';
  const params: unknown[] = [id];
  if (includeLegacy) {
    sql += ' AND (owner = ? OR owner = ?)';
    params.push(owner, LEGACY_OWNER);
  } else {
    sql += ' AND owner = ?';
    params.push(owner);
  }
  await db.prepare(sql).run(...params);
}

// ─── 脱敏 / 输入归一化 helper ────────────────────────────────────────────────
// 注意：本模块刻意不复用 provider-keys 的 maskKey（避免与 provider-keys 形成循环依赖）。

/** 仅保留首尾若干字符生成掩码（sk-…a91f），中间用 · 填充；明文绝不出网。 */
function maskKeyLocal(plain: string): string {
  const s = plain.trim();
  if (!s) return '';
  if (s.length <= 11) return '••••' + s.slice(-4);
  return s.slice(0, 7) + '…' + s.slice(-4);
}

/**
 * 把前端传入的 apiKey 归一化为「密文 + 掩码」二元组，供落库。
 * 兼容两种来源：
 *  - 明文（P1.4 之后前端不再加密，直接传明文）→ 服务端 AES-GCM 加密 + 掩码；
 *  - 旧前端密文（base64(iv+ct+tag)，升级过渡期可能残留）→ 原样保留 + 解密后掩码。
 * 返回 null 表示无 Key。
 */
function storeApiKeyInput(raw?: string): { cipher: string; hint: string } | null {
  if (!raw || !raw.trim()) return null;
  const s = raw.trim();
  // 旧前端可能已传密文（base64，iv12 + tag16 + ≥1 字节 ct）。
  try {
    const buf = Buffer.from(s, 'base64');
    if (buf.length >= 28) {
      const pt = decryptApiKey(s); // 同源密钥可解
      if (pt) return { cipher: s, hint: maskKeyLocal(pt) };
    }
  } catch {
    /* 非 base64 密文 → 走明文分支 */
  }
  // 明文：服务端加密（绝不依赖前端密钥）。
  return { cipher: encryptApiKey(s), hint: maskKeyLocal(s) };
}

/** GET 对外脱敏：剥离密文，仅回 keyHint（缺失时由密文反解掩码，绝不回明文）。 */
function toPublicModel(r: CustomModelRow): CustomModelPublic {
  let hint = r.keyHint || '';
  if (!hint && r.apiKey) {
    try {
      const pt = decryptApiKey(r.apiKey);
      hint = pt ? maskKeyLocal(pt) : '已配置';
    } catch {
      // 单条密文无法解密（密钥不匹配/损坏）→ 不阻断整个列表，仅给占位掩码。
      hint = '已配置';
    }
  }
  return {
    id: r.id,
    ...(r.baseUrl ? { baseUrl: r.baseUrl } : {}),
    keyHint: hint || '已配置',
    updatedAt: r.updatedAt
  };
}

// ─── HTTP 路由 ───────────────────────────────────────────────────────────────

export async function registerCustomModelRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
  body: any,
  owner: string,
  includeLegacy = false
): Promise<boolean> {
  if (!path.startsWith('/api/custom-models')) return false;

  if (method === 'GET' && path === '/api/custom-models') {
    const list = (await listCustomModels(owner, includeLegacy)).map(toPublicModel);
    sendJson(res, list, req);
    return true;
  }

  if (method === 'GET' && /^\/api\/custom-models\/[^/]+$/.test(path)) {
    const id = decodeURIComponent(path.split('/').pop() || '');
    const row = await getCustomModel(id, owner, includeLegacy);
    if (!row) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return true;
    }
    sendJson(res, toPublicModel(row), req);
    return true;
  }

  if (method === 'POST' && path === '/api/custom-models') {
    const id = String(body?.id ?? '').trim();
    if (!id) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'id required' }));
      return true;
    }
    const baseUrl = typeof body?.baseUrl === 'string' ? body.baseUrl.trim() : undefined;
    const apiKey = typeof body?.apiKey === 'string' ? body.apiKey.trim() : undefined;
    // P1.4：明文 Key 由服务端加密（前端不再持密钥）；兼容旧前端残留的密文输入。
    const key = storeApiKeyInput(apiKey);
    // 等待写入完成再响应，避免「先回 200 后落库」的竞态。
    // owner 强制 = ctx.sub（调用方已 guard），忽略请求体任何 owner 字段（防越权）。
    await putCustomModel({
      id,
      owner,
      ...(baseUrl ? { baseUrl } : {}),
      ...(key ? { apiKey: key.cipher, keyHint: key.hint } : {}),
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return true;
  }

  if (method === 'DELETE' && /^\/api\/custom-models\/[^/]+$/.test(path)) {
    const id = decodeURIComponent(path.split('/').pop() || '');
    await deleteCustomModel(id, owner, includeLegacy);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return true;
  }

  // 命中前缀但未匹配任何子路由：404（不落入后续通用路由）。
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
  return true;
}

// ─── 最小 sendJson 复用（避免重复声明类型） ─────────────────────────────────

function sendJson(res: ServerResponse, obj: any, _req: IncomingMessage) {
  const body = JSON.stringify(obj);
  res.writeHead(200, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
  });
  res.end(body);
}

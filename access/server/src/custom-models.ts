/**
 * 自定义模型持久化（SQLite） + REST 路由 + AES-GCM 加解密 helper。
 *
 * 约束：
 *  - 自定义模型统一走 SQLite（不再 frontend localStorage）；
 *  - API Key 由前端 AES-GCM 加密后传输，服务端在此层解密后交给 runner；
 *  - 密钥来源：仓库根 .env 的 AH_CRYPTO_KEY（64 hex / 32 bytes）。
 *    前端经 vite define 注入同一值（见 frontend/webapp/vite.config.ts），两端共用。
 */

import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

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
 * 服务端解密：输入 base64(iv + ciphertext)，输出明文 apiKey。
 *
 * 密文由浏览器 WebCrypto AES-GCM 产生，其输出为 ciphertext || authTag(16B)，
 * 即完整载荷 = iv(12B) || ct(n-28) || tag(16B)。Node 的 createDecipheriv
 * 要求显式 setAuthTag 后 final() 校验才能通过。
 */
export function decryptApiKey(payload: unknown): string {
  if (typeof payload !== 'string') return '';
  const raw = Buffer.from(payload, 'base64');
  // 最短合法载荷：12(iv) + 16(tag)，明文可为空但实际 key 不为空。
  if (raw.length < 12 + 16) return '';
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(raw.length - 16);
  const ct = raw.subarray(12, raw.length - 16);
  const { createDecipheriv } =
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('node:crypto') as typeof import('node:crypto');
  const decipher = createDecipheriv('aes-256-gcm', getBuildTimeCryptoKey(), iv);
  decipher.setAuthTag(tag);
  try {
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString('utf8');
  } catch {
    // tag 校验失败 / key 不匹配：拒绝而非降级。
    return '';
  }
}

// ─── SQLite 存储 ─────────────────────────────────────────────────────────────

export interface CustomModelRow {
  id: string;
  baseUrl?: string;
  /** AES-GCM 密文（base64(iv + ciphertext)） */
  apiKey?: string;
  updatedAt: number;
}

let db: any = null;
let dbReady: Promise<void> | null = null;

const DEFAULT_DB = join(process.cwd(), 'data', 'custom-models.db');

function getDbFile(): string {
  return process.env.CUSTOM_MODELS_DB_FILE || DEFAULT_DB;
}

async function ensureDb() {
  if (db) return;
  if (!dbReady) {
    dbReady = (async () => {
      const { mkdirSync } = await import('node:fs');
      const path = await import('node:path');
      const file = getDbFile();
      mkdirSync(path.dirname(file), { recursive: true });
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: any };
      db = new DatabaseSync(file);
      db.exec(
        `CREATE TABLE IF NOT EXISTS custom_models (
          id TEXT PRIMARY KEY,
          base_url TEXT,
          api_key TEXT,
          updated_at INTEGER NOT NULL
        )`
      );
    })();
  }
  await dbReady;
}

export async function listCustomModels(): Promise<CustomModelRow[]> {
  await ensureDb();
  const stmt = db.prepare('SELECT id, base_url, api_key, updated_at FROM custom_models ORDER BY updated_at DESC');
  const rows = stmt.all() as any[];
  return rows.map((r) => ({
    id: r.id,
    ...(r.base_url ? { baseUrl: r.base_url } : {}),
    ...(r.api_key ? { apiKey: r.api_key } : {}),
    updatedAt: r.updated_at,
  }));
}

export async function getCustomModel(id: string): Promise<CustomModelRow | null> {
  await ensureDb();
  const stmt = db.prepare('SELECT id, base_url, api_key, updated_at FROM custom_models WHERE id = ?');
  const r = stmt.get(id) as any | undefined;
  if (!r) return null;
  return {
    id: r.id,
    ...(r.base_url ? { baseUrl: r.base_url } : {}),
    ...(r.api_key ? { apiKey: r.api_key } : {}),
    updatedAt: r.updated_at,
  };
}

export async function putCustomModel(row: Omit<CustomModelRow, 'updatedAt'>): Promise<void> {
  await ensureDb();
  const now = Date.now();
  const stmt = db.prepare(
    `INSERT INTO custom_models (id, base_url, api_key, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       base_url = excluded.base_url,
       api_key = excluded.api_key,
       updated_at = excluded.updated_at`
  );
  stmt.run(row.id, row.baseUrl ?? null, row.apiKey ?? null, now);
}

export async function deleteCustomModel(id: string): Promise<void> {
  await ensureDb();
  db.prepare('DELETE FROM custom_models WHERE id = ?').run(id);
}

// ─── HTTP 路由 ───────────────────────────────────────────────────────────────

export async function registerCustomModelRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
  body: any
): Promise<boolean> {
  if (!path.startsWith('/api/custom-models')) return false;

  if (method === 'GET' && path === '/api/custom-models') {
    sendJson(res, await listCustomModels(), req);
    return true;
  }

  if (method === 'GET' && /^\/api\/custom-models\/[^/]+$/.test(path)) {
    const id = decodeURIComponent(path.split('/').pop() || '');
    const row = await getCustomModel(id);
    if (!row) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return true;
    }
    sendJson(res, row, req);
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
    // 等待写入完成再响应，避免「先回 200 后落库」的竞态。
    await putCustomModel({
      id,
      ...(baseUrl ? { baseUrl } : {}),
      ...(apiKey ? { apiKey } : {}),
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return true;
  }

  if (method === 'DELETE' && /^\/api\/custom-models\/[^/]+$/.test(path)) {
    const id = decodeURIComponent(path.split('/').pop() || '');
    await deleteCustomModel(id);
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

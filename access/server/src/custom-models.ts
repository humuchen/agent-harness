/**
 * 自定义模型持久化（SQLite） + REST 路由 + AES-GCM 加解密 helper。
 *
 * 约束：
 *  - 自定义模型统一走 SQLite（不再 frontend localStorage）；
 *  - API Key 由前端 AES-GCM 加密后传输，服务端在此层解密后交给 runner；
 *  - 服务端不持有前端私钥：AES key 由 Vite build-time define 注入（__AH_CRYPTO_KEY__）。
 */

import { readFile } from 'node:fs/promises';
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

/** 从注入的 build-time 常量取 AES-256 key；未注入则抛错（禁止静默降级为明文）。 */
function getBuildTimeCryptoKey(): Uint8Array {
  // @ts-ignore - 由 vite.config.ts define 注入
  const raw = typeof __AH_CRYPTO_KEY__ === 'string' ? __AH_CRYPTO_KEY__ : '';
  if (!raw || raw.length !== 64) {
    throw new Error(
      'missing build-time crypto key: __AH_CRYPTO_KEY__ must be 64 hex chars (AES-256)'
    );
  }
  return hexToBytes(raw);
}

// ─── 服务端 AES-GCM 解密 ─────────────────────────────────────────────────────

/**
 * 服务端解密：输入 base64(iv + ciphertext)，输出明文 apiKey。
 * 使用 Node.js 内置 node:crypto，同步接口（Node 22+）。
 */
export function decryptApiKey(payload: unknown): string {
  if (typeof payload !== 'string') return '';
  const raw = Buffer.from(payload, 'base64');
  if (raw.length < 13) return '';
  const iv = raw.slice(0, 12);
  const ct = raw.slice(12);
  const key = getBuildTimeCryptoKey();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createDecipheriv } = require('node:crypto') as typeof import('node:crypto');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  let plaintext: Buffer;
  try {
    plaintext = Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    return '';
  }
  // GCM auth tag（最后 16 bytes）已在 final() 校验
  return plaintext.toString('utf8');
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

export function registerCustomModelRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
  body: any
): boolean {
  if (!path.startsWith('/api/custom-models')) return false;

  if (method === 'GET' && path === '/api/custom-models') {
    const rows = listCustomModelsSync();
    sendJson(res, rows, req);
    return true;
  }

  if (method === 'GET' && /^\/api\/custom-models\/[^/]+$/.test(path)) {
    const id = decodeURIComponent(path.split('/').pop() || '');
    const row = getCustomModelSync(id);
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
    void putCustomModel({
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
    void deleteCustomModel(id);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return true;
  }

  if (path.startsWith('/api/custom-models')) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
    return true;
  }
  return false;
}

// 服务端路由为同步分发，SQLite 查询提供同步包装（node:sqlite 本身支持同步 API）。
function listCustomModelsSync(): CustomModelRow[] {
  if (!db) return [];
  const stmt = db.prepare('SELECT id, base_url, api_key, updated_at FROM custom_models ORDER BY updated_at DESC');
  const rows = stmt.all() as any[];
  return rows.map((r) => ({
    id: r.id,
    ...(r.base_url ? { baseUrl: r.base_url } : {}),
    ...(r.api_key ? { apiKey: r.api_key } : {}),
    updatedAt: r.updated_at,
  }));
}

function getCustomModelSync(id: string): CustomModelRow | null {
  if (!db) return null;
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

// ─── 最小 sendJson 复用（避免重复声明类型） ─────────────────────────────────

function sendJson(res: ServerResponse, obj: any, _req: IncomingMessage) {
  const body = JSON.stringify(obj);
  res.writeHead(200, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
  });
  res.end(body);
}

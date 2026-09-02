/**
 * MCP 服务持久化（SQLite）。
 *
 * 设计：
 *  - 一键接入 / 手动添加的 MCP 服务配置保存到 SQLite，重启后自动加载重连
 *  - 鉴权 token（如有）经 AES-GCM 加密后落库，密钥复用 AH_CRYPTO_KEY
 *  - 不存储运行时状态（status / tools），这些在每次连接时重新获取
 */

import { join } from 'node:path';
import { getDbAdapter } from '@agent-harness/core';
import { encryptApiKey, decryptApiKey } from './custom-models';
import type { McpServerConfig } from '@agent-harness/core';

// ─── 数据模型 ────────────────────────────────────────────────────────────────

export interface McpServerRecord {
  name: string;
  serverUrl?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  headers?: Record<string, string>;
  transportType?: string;
  /** AES-GCM 密文（base64(iv + ciphertext)），来自一键接入的 token */
  authToken?: string;
  updatedAt: number;
}

// ─── 数据库连接 ──────────────────────────────────────────────────────────────

let db: any = null;
let dbReady: Promise<void> | null = null;

const DEFAULT_DB = join(process.cwd(), 'data', 'mcp-servers.db');

function getDbFile(): string {
  return process.env.MCP_SERVERS_DB_FILE || DEFAULT_DB;
}

async function ensureDb() {
  if (db) return;
  if (!dbReady) {
    dbReady = (async () => {
      const file = getDbFile();
      db = getDbAdapter({ file });
      await db.exec(
        `CREATE TABLE IF NOT EXISTS mcp_servers (
          name TEXT PRIMARY KEY,
          server_url TEXT,
          command TEXT,
          args TEXT,
          env TEXT,
          headers TEXT,
          transport_type TEXT,
          auth_token TEXT,
          updated_at INTEGER NOT NULL
        )`
      );
    })();
  }
  await dbReady;
}

// ─── CRUD ────────────────────────────────────────────────────────────────────

export async function listMcpServers(): Promise<McpServerRecord[]> {
  await ensureDb();
  const stmt = db.prepare(
    'SELECT name, server_url, command, args, env, headers, transport_type, auth_token, updated_at FROM mcp_servers ORDER BY updated_at DESC'
  );
  const rows = (await stmt.all()) as any[];
  return rows.map((r) => ({
    name: r.name,
    ...(r.server_url ? { serverUrl: r.server_url } : {}),
    ...(r.command ? { command: r.command } : {}),
    ...(r.args ? { args: safeJsonParse(r.args) } : {}),
    ...(r.env ? { env: safeJsonParse(r.env) } : {}),
    ...(r.headers ? { headers: safeJsonParse(r.headers) } : {}),
    ...(r.transport_type ? { transportType: r.transport_type } : {}),
    ...(r.auth_token ? { authToken: r.auth_token } : {}),
    updatedAt: r.updated_at,
  }));
}

export async function getMcpServer(
  name: string
): Promise<McpServerRecord | null> {
  await ensureDb();
  const stmt = db.prepare(
    'SELECT name, server_url, command, args, env, headers, transport_type, auth_token, updated_at FROM mcp_servers WHERE name = ?'
  );
  const r = (await stmt.get(name)) as any | undefined;
  if (!r) return null;
  return {
    name: r.name,
    ...(r.server_url ? { serverUrl: r.server_url } : {}),
    ...(r.command ? { command: r.command } : {}),
    ...(r.args ? { args: safeJsonParse(r.args) } : {}),
    ...(r.env ? { env: safeJsonParse(r.env) } : {}),
    ...(r.headers ? { headers: safeJsonParse(r.headers) } : {}),
    ...(r.transport_type ? { transportType: r.transport_type } : {}),
    ...(r.auth_token ? { authToken: r.auth_token } : {}),
    updatedAt: r.updated_at,
  };
}

export async function putMcpServer(
  config: McpServerConfig & { authToken?: string }
): Promise<void> {
  await ensureDb();
  const now = Date.now();
  const stmt = db.prepare(
    `INSERT INTO mcp_servers (name, server_url, command, args, env, headers, transport_type, auth_token, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       server_url = excluded.server_url,
       command = excluded.command,
       args = excluded.args,
       env = excluded.env,
       headers = excluded.headers,
       transport_type = excluded.transport_type,
       auth_token = excluded.auth_token,
       updated_at = excluded.updated_at`
  );
  await stmt.run(
    config.name,
    config.serverUrl ?? null,
    config.command ?? null,
    config.args ? JSON.stringify(config.args) : null,
    config.env ? JSON.stringify(config.env) : null,
    config.headers ? JSON.stringify(config.headers) : null,
    config.transportType ?? null,
    config.authToken ?? null,
    now
  );
}

export async function deleteMcpServer(name: string): Promise<void> {
  await ensureDb();
  await db.prepare('DELETE FROM mcp_servers WHERE name = ?').run(name);
}

// ─── 工具函数 ────────────────────────────────────────────────────────────────

function safeJsonParse(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

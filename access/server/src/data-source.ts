/**
 * 数据源注册表（Data Sources，P1-x）。
 *
 * 统一管理企业接入的各种数据源（静态配置 / HTTP 端点 / PostgreSQL 等），
 * 供后续「知识库 / 检索 / 工具」等能力按需拉取数据。设计与企业内一贯的
 * 「接口 + 默认实现 + 组合工厂」保持一致——
 * - `DataSourceRegistry` 是契约（list / get / test / create / remove）；
 * - 默认实现 `FileDataSourceRegistry` 将定义落盘到 JSON 文件（`DATASOURCES_FILE`，
 *   默认 `.data/datasources.json`），便于对接、审计与演示；
 * - `test(id)` 按 `type` 构建轻量 `DataSourceAdapter` 实际探测连通性
 *   （static 永远可达、http 走 fetch、postgres 走 TCP 探活，不引入 pg 驱动）；
 * - 后续可新增 `DbDataSourceRegistry` / `VaultDataSourceRegistry` 实现同一接口，
 *   业务层（路由 + 前端）零改动。
 *
 * 写入鉴权由路由（guard）负责，本模块只管持久化与连通性探测。
 *
 * 仅使用 node: 内置模块，保持自包含。
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { createConnection } from 'node:net';
import { lookup } from 'node:dns/promises';

// ── 出网目标防护（SSRF / 内网探测，P1）────────────────────────────────────
// 数据源连通性测试会以服务端身份向用户配置的任意 URL / host:port 发起请求——
// 不加限制时，持有 datasource:read 的低权限账号即可让服务器探测内网拓扑
// （含 169.254.169.254 云元数据端点），并从 latencyMs / 错误信息侧信道推断网段结构。
// 默认 denylist：http 限 http(s) scheme，目标主机经 DNS 解析后逐 IP 校验，
// 命中私有/保留网段即拒绝（解析后校验同时挡住 DNS rebinding 的常见形态）。
// 自托管内网部署确需连内网数据源时，显式设置 DATASOURCE_EGRESS_MODE=open 恢复旧行为。

function egressMode(): string {
  return (process.env.DATASOURCE_EGRESS_MODE ?? 'denylist').toLowerCase();
}

/** IPv4 是否落在私有 / 保留网段。 */
function isPrivateIpv4(ip: string): boolean {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return true; // 非点分十进制一律视为可疑
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 0 || a === 10 || a === 127) return true; // 本机 / 内网 / 回环
  if (a === 169 && b === 254) return true; // 链路本地（含云元数据 169.254.169.254）
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 192 && b === 0) return true; // 192.0.0/24 + TEST-NET-1 192.0.2/24
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 基准测试
  if (a >= 224) return true; // 组播 224/4 + 保留 240/4
  return false;
}

/** IPv6 是否私有 / 保留（含 IPv4 映射地址解包校验）。 */
function isPrivateIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  const mapped = lower.match(/^::(?:ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  const mappedIp = mapped?.[1];
  if (mappedIp) return isPrivateIpv4(mappedIp); // ::ffff:a.b.c.d 按 IPv4 判
  if (lower === '::' || lower === '::1') return true; // 未指定 / 回环
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true; // fe80::/10
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // fc00::/7 ULA
  if (lower.startsWith('ff')) return true; // 组播
  return false;
}

function isPrivateIp(ip: string): boolean {
  return ip.includes(':') ? isPrivateIpv6(ip) : isPrivateIpv4(ip);
}

/**
 * 校验出网目标主机；违规抛 Error（adapter 层捕获并转为连接失败，不泄露解析细节）。
 * IP 字面量由 dns.lookup 直接返回；域名解析失败同样拒绝（fail-closed）。
 */
export async function assertEgressTarget(host: string): Promise<void> {
  if (egressMode() === 'open') return;
  const records = await lookup(host, { all: true, verbatim: true }).catch(() => {
    throw new Error(`egress blocked: 无法解析主机（${host}）`);
  });
  if (records.some((r) => isPrivateIp(r.address))) {
    throw new Error(
      'egress blocked: 目标落在私有/保留网段（SSRF 防护；如确需访问内网数据源，请设置 DATASOURCE_EGRESS_MODE=open）'
    );
  }
}

export type DataSourceType = 'http' | 'static' | 'postgres';

export interface DataSourceDef {
  id: string;
  name: string;
  type: DataSourceType;
  config: Record<string, unknown>;
}

export interface ConnectionResult {
  ok: boolean;
  message: string;
  latencyMs?: number;
}

export interface DataSourceAdapter {
  def: DataSourceDef;
  testConnection(): Promise<ConnectionResult>;
}

export interface DataSourceRegistry {
  list(): Promise<DataSourceDef[]>;
  get(id: string): Promise<DataSourceDef | null>;
  /** null if id unknown（调用方自行决定 404 响应）。 */
  test(id: string): Promise<ConnectionResult | null>;
  /** auth handled by route；直接落盘。 */
  create(def: DataSourceDef): Promise<DataSourceDef>;
  remove(id: string): Promise<boolean>;
}

// ── 适配器：按 type 实际探测连通性 ──

class StaticAdapter implements DataSourceAdapter {
  constructor(public def: DataSourceDef) {}
  async testConnection(): Promise<ConnectionResult> {
    return { ok: true, message: 'static source reachable' };
  }
}

class HttpAdapter implements DataSourceAdapter {
  constructor(public def: DataSourceDef) {}
  async testConnection(): Promise<ConnectionResult> {
    const url = typeof this.def.config?.url === 'string' ? this.def.config.url : '';
    if (!url) {
      return { ok: false, message: 'missing config.url' };
    }
    // P1 SSRF 防护：scheme 白名单 + 目标主机私有网段校验。
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { ok: false, message: 'invalid config.url' };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false, message: 'only http/https allowed' };
    }
    try {
      await assertEgressTarget(parsed.hostname);
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
    const start = Date.now();
    try {
      const res = await fetch(url, {
        method: 'GET',
        signal: AbortSignal.timeout(5000)
      });
      const latencyMs = Date.now() - start;
      return {
        ok: res.status < 400,
        message: `HTTP ${res.status}`,
        latencyMs
      };
    } catch (e: any) {
      return { ok: false, message: String(e?.message ?? e) };
    }
  }
}

class PostgresAdapter implements DataSourceAdapter {
  constructor(public def: DataSourceDef) {}
  async testConnection(): Promise<ConnectionResult> {
    const host = typeof this.def.config?.host === 'string' ? this.def.config.host : 'localhost';
    const port =
      typeof this.def.config?.port === 'number' ? this.def.config.port : 5432;
    // P1 SSRF 防护：TCP 探测目标同样先过私有网段校验。
    try {
      await assertEgressTarget(host);
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
    return new Promise<ConnectionResult>((resolve) => {
      const start = Date.now();
      const socket = createConnection({ host, port });
      const done = (r: ConnectionResult) => {
        try {
          socket.destroy();
        } catch {
          /* 忽略销毁异常 */
        }
        resolve(r);
      };
      socket.on('connect', () => {
        done({ ok: true, message: `tcp connected ${host}:${port}`, latencyMs: Date.now() - start });
      });
      socket.on('error', (e: Error) => {
        done({ ok: false, message: String(e?.message ?? e) });
      });
    });
  }
}

/** 按 type 构建适配器；未知类型回落为永远不可达，避免路由侧崩溃。 */
export function buildAdapter(def: DataSourceDef): DataSourceAdapter {
  switch (def.type) {
    case 'static':
      return new StaticAdapter(def);
    case 'http':
      return new HttpAdapter(def);
    case 'postgres':
      return new PostgresAdapter(def);
    default:
      return {
        def,
        async testConnection() {
          return { ok: false, message: `unsupported type: ${def.type}` };
        }
      };
  }
}

// ── 默认实现：JSON 文件落盘 ──

export class FileDataSourceRegistry implements DataSourceRegistry {
  constructor(private readonly file: string) {}

  private async readAll(): Promise<DataSourceDef[]> {
    try {
      const raw = await readFile(this.file, 'utf-8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as DataSourceDef[]) : [];
    } catch {
      // 文件缺失 / 解析失败：视为空集合（保证读写端点始终可用）。
      return [];
    }
  }

  private async writeAll(items: DataSourceDef[]): Promise<void> {
    const dir = dirname(this.file);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
    await writeFile(this.file, JSON.stringify(items, null, 2), 'utf-8');
  }

  async list(): Promise<DataSourceDef[]> {
    return this.readAll();
  }

  async get(id: string): Promise<DataSourceDef | null> {
    const items = await this.readAll();
    return items.find((d) => d.id === id) ?? null;
  }

  async test(id: string): Promise<ConnectionResult | null> {
    const def = await this.get(id);
    if (!def) return null;
    const adapter = buildAdapter(def);
    return adapter.testConnection();
  }

  async create(def: DataSourceDef): Promise<DataSourceDef> {
    const items = await this.readAll();
    const idx = items.findIndex((d) => d.id === def.id);
    if (idx >= 0) {
      items[idx] = def; // 同 id 覆盖
    } else {
      items.push(def);
    }
    await this.writeAll(items);
    return def;
  }

  async remove(id: string): Promise<boolean> {
    const items = await this.readAll();
    const next = items.filter((d) => d.id !== id);
    if (next.length === items.length) return false;
    await this.writeAll(next);
    return true;
  }
}

// ── 组合工厂 ──

let registrySingleton: DataSourceRegistry | null = null;

/** 组合工厂：按环境变量选择 registry（默认 JSON 文件落盘）。 */
export function getDataSourceRegistry(env: NodeJS.ProcessEnv = process.env): DataSourceRegistry {
  if (!registrySingleton) {
    const file = env.DATASOURCES_FILE || '.data/datasources.json';
    registrySingleton = new FileDataSourceRegistry(file);
  }
  return registrySingleton;
}

/** 供测试注入自定义 registry（传 null 复位为默认未初始化）。 */
export function setDataSourceRegistry(r: DataSourceRegistry | null): void {
  registrySingleton = r;
}

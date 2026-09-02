/**
 * 最小插件市场 Registry Server
 *
 * 提供:
 * - 插件列表查询
 * - 插件版本解析（语义化版本排序）
 * - 插件包下载（GET /plugins/<id>-<ver>.tar.gz）
 * - 安装统计（下载计数，内存聚合 + 定期落盘）
 * - 发布鉴权（REGISTRY_TOKEN，未配置时开放并告警）
 *
 * 运行方式:
 *   node access/server/dist/registry-server.js
 *   PORT=4000 REGISTRY_TOKEN=xxx node access/server/dist/registry-server.js
 */

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  readFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  createReadStream,
  statSync
} from 'node:fs';
import { join, resolve } from 'node:path';

const PORT = Number(process.env.PORT || process.env.REGISTRY_PORT || 4000);

/**
 * 语义化版本比较：a>b 返回 >0，a<b 返回 <0，相等返回 0。非数字段按 0 处理。
 * 与 core/src/plugin/registry.ts 的 cmpVersion 同构；此处内联以保持本服务零依赖独立运行。
 */
function cmpVersion(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}

// 插件存储目录
const REGISTRY_DIR = join(process.cwd(), 'registry-data');
const PLUGINS_FILE = join(REGISTRY_DIR, 'plugins.json');
const PACKAGES_DIR = join(REGISTRY_DIR, 'packages');

// 鉴权：发布/管理端点令牌。未设置时开放（本地/演示），启动期打印一次性告警。
const REGISTRY_TOKEN = (process.env.REGISTRY_TOKEN || '').trim();

// CORS：跨域白名单（逗号分隔 Origin）。留空 = 仅同源（不返回 ACAO，杜绝通配符）。
const CORS_ORIGINS = (process.env.REGISTRY_CORS_ORIGIN || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// 下载计数落盘间隔（毫秒）。
const FLUSH_MS = Number(process.env.REGISTRY_FLUSH_MS || 30000);

// 初始化存储
if (!existsSync(REGISTRY_DIR)) mkdirSync(REGISTRY_DIR, { recursive: true });
if (!existsSync(PACKAGES_DIR)) mkdirSync(PACKAGES_DIR, { recursive: true });

// 插件数据库
interface PluginEntry {
  id: string;
  name: string;
  versions: PluginVersion[];
  downloads: number;
  publishedAt: string;
}

interface PluginVersion {
  version: string;
  manifest: any;
  tarballUrl: string;
  publishedAt: string;
}

// 加载现有插件
function loadPlugins(): PluginEntry[] {
  if (!existsSync(PLUGINS_FILE)) return [];
  try {
    return JSON.parse(readFileSync(PLUGINS_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

// 原子写：先写临时文件再同 FS rename，避免写入中途崩溃产生半截 JSON。
function savePlugins(plugins: PluginEntry[]): void {
  const tmp = `${PLUGINS_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(plugins, null, 2));
  renameSync(tmp, PLUGINS_FILE);
}

// 下载计数：内存聚合 delta，避免每次 GET 详情都整文件重写。
const downloadDeltas = new Map<string, number>();

function bumpDownload(id: string): void {
  downloadDeltas.set(id, (downloadDeltas.get(id) ?? 0) + 1);
}

/** 合并落盘：把内存 delta 累加进磁盘并清空。 */
function flushDownloads(): void {
  if (downloadDeltas.size === 0) return;
  const plugins = loadPlugins();
  for (const [id, delta] of downloadDeltas) {
    const p = plugins.find((x) => x.id === id);
    if (p) p.downloads += delta;
  }
  downloadDeltas.clear();
  savePlugins(plugins);
}

/** 读取某插件的「磁盘值 + 内存 delta」合并后的下载数。 */
function effectiveDownloads(p: PluginEntry): number {
  return p.downloads + (downloadDeltas.get(p.id) ?? 0);
}

// 示例插件数据
function seedExamplePlugins(): void {
  const plugins = loadPlugins();
  if (plugins.length > 0) return; // 已有数据

  console.log('🌱 初始化示例插件数据...');

  const examples: PluginEntry[] = [
    {
      id: 'medical-aesthetics-lead',
      name: '医美客资管理',
      versions: [
        {
          version: '0.1.0',
          manifest: {
            id: 'medical-aesthetics-lead',
            name: 'Medical Aesthetics Lead',
            version: '0.1.0',
            description: '医美行业客资管理插件',
            capabilities: ['chat', 'tools']
          },
          tarballUrl: '/plugins/medical-aesthetics-lead-0.1.0.tar.gz',
          publishedAt: '2026-08-19T00:00:00Z'
        }
      ],
      downloads: 42,
      publishedAt: '2026-08-19T00:00:00Z'
    }
  ];

  savePlugins(examples);
  console.log(`✅ 已加载 ${examples.length} 个示例插件`);
}

// 初始化
seedExamplePlugins();

/** CORS：反射白名单内的 Origin；未命中/未配置返回空串（不设 ACAO，仅同源）。 */
function corsAllow(req: IncomingMessage): string {
  const origin = req.headers.origin;
  if (!origin || CORS_ORIGINS.length === 0) return '';
  return CORS_ORIGINS.includes(origin) ? origin : '';
}

/** 发送 JSON 响应。 */
function sendJson(res: ServerResponse, data: any, status = 200): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}

/** 发布/管理端点鉴权。未配置令牌时开放（兼容本地演示）。 */
function requireAuth(req: IncomingMessage, res: ServerResponse): boolean {
  if (!REGISTRY_TOKEN) return true;
  const auth = req.headers.authorization;
  const token =
    typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (token === REGISTRY_TOKEN) return true;
  sendJson(res, { error: 'unauthorized: missing or invalid token' }, 401);
  return false;
}

/**
 * 处理请求
 */
async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
  const path = url.pathname;

  // CORS：命中白名单则反射该 Origin。
  const allow = corsAllow(req);
  if (allow) res.setHeader('access-control-allow-origin', allow);

  // CORS 预检。
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'content-type,authorization',
      ...(allow ? { 'access-control-allow-origin': allow } : {})
    });
    res.end();
    return;
  }

  try {
    // GET /plugins/<file>.tar.gz - 插件包下载（仅允许纯文件名，防目录穿越）。
    if (req.method === 'GET' && path.startsWith('/plugins/')) {
      const filename = path.slice('/plugins/'.length);
      if (!/^[\w.-]+\.(tar\.gz|tgz)$/.test(filename)) {
        return sendJson(res, { error: '非法文件名', filename }, 400);
      }
      const filePath = resolve(PACKAGES_DIR, filename);
      // 二次校验：解析后的路径必须仍落在 PACKAGES_DIR 内。
      if (!filePath.startsWith(PACKAGES_DIR) || !existsSync(filePath)) {
        return sendJson(res, { error: '插件包不存在', filename }, 404);
      }
      res.writeHead(200, {
        'content-type': 'application/gzip',
        'content-length': statSync(filePath).size
      });
      createReadStream(filePath).pipe(res);
      return;
    }

    // GET /api/registry/plugins - 列出所有插件
    if (req.method === 'GET' && path === '/api/registry/plugins') {
      const plugins = loadPlugins();
      return sendJson(res, {
        plugins: plugins.map((p) => ({
          id: p.id,
          name: p.name,
          latestVersion: p.versions[p.versions.length - 1]?.version ?? '',
          downloads: effectiveDownloads(p),
          publishedAt: p.publishedAt
        })),
        total: plugins.length
      });
    }

    // GET /api/registry/plugins/:id - 获取插件详情
    if (
      req.method === 'GET' &&
      path.match(/^\/api\/registry\/plugins\/[\w-]+$/)
    ) {
      const id = path.split('/').pop()!;
      const plugins = loadPlugins();
      const plugin = plugins.find((p) => p.id === id);

      if (!plugin) {
        return sendJson(res, { error: '插件未找到', id }, 404);
      }

      bumpDownload(id);

      return sendJson(res, { plugin: { ...plugin, downloads: effectiveDownloads(plugin) } });
    }

    // GET /api/registry/plugins/:id/versions - 获取所有版本
    if (
      req.method === 'GET' &&
      path.match(/^\/api\/registry\/plugins\/[\w-]+\/versions$/)
    ) {
      const parts = path.split('/');
      const id = parts[parts.length - 2];
      const plugins = loadPlugins();
      const plugin = plugins.find((p) => p.id === id);

      if (!plugin) {
        return sendJson(res, { error: '插件未找到', id }, 404);
      }

      return sendJson(res, {
        versions: plugin.versions.map((v) => ({
          version: v.version,
          publishedAt: v.publishedAt,
          tarballUrl: v.tarballUrl
        }))
      });
    }

    // POST /api/registry/plugins - 发布新插件（受 REGISTRY_TOKEN 保护）。
    if (req.method === 'POST' && path === '/api/registry/plugins') {
      if (!requireAuth(req, res)) return;
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        try {
          const data = JSON.parse(body);
          const { id, name, version, manifest, tarballUrl, tarball } = data;

          if (!id || !name || !version) {
            return sendJson(
              res,
              { error: '缺少必需字段: id, name, version' },
              400
            );
          }

          const plugins = loadPlugins();
          let plugin = plugins.find((p) => p.id === id);

          const now = new Date().toISOString();
          const newVersion = {
            version,
            manifest: manifest || { id, name, version },
            tarballUrl: tarballUrl || `/plugins/${id}-${version}.tar.gz`,
            publishedAt: now
          };

          if (plugin) {
            // 检查版本是否已存在
            if (plugin.versions.some((v) => v.version === version)) {
              return sendJson(res, { error: `版本 ${version} 已存在` }, 409);
            }
            plugin.versions.push(newVersion);
            plugin.versions.sort((a, b) => cmpVersion(a.version, b.version));
          } else {
            plugin = {
              id,
              name,
              versions: [newVersion],
              downloads: 0,
              publishedAt: now
            };
            plugins.push(plugin);
          }

          // 可选：以 base64 上传插件包（.tar.gz），落盘到 packages 目录供下载端点服务。
          if (typeof tarball === 'string' && tarball) {
            const buf = Buffer.from(tarball, 'base64');
            writeFileSync(join(PACKAGES_DIR, `${id}-${version}.tar.gz`), buf);
          }

          savePlugins(plugins);
          return sendJson(res, { ok: true, plugin }, 201);
        } catch (e: any) {
          return sendJson(res, { error: e.message }, 400);
        }
      });
      return;
    }

    // GET /api/registry/search?q=xxx - 搜索插件
    if (req.method === 'GET' && path === '/api/registry/search') {
      const query = (url.searchParams.get('q') || '').toLowerCase();
      const plugins = loadPlugins();

      const results = plugins.filter(
        (p) =>
          p.id.toLowerCase().includes(query) ||
          p.name.toLowerCase().includes(query)
      );

      return sendJson(res, {
        query,
        results: results.map((p) => ({
          id: p.id,
          name: p.name,
          latestVersion: p.versions[p.versions.length - 1]?.version ?? '',
          downloads: effectiveDownloads(p)
        })),
        total: results.length
      });
    }

    // GET /api/registry/stats - 统计信息
    if (req.method === 'GET' && path === '/api/registry/stats') {
      const plugins = loadPlugins();
      const totalDownloads = plugins.reduce(
        (sum, p) => sum + effectiveDownloads(p),
        0
      );
      const totalVersions = plugins.reduce(
        (sum, p) => sum + p.versions.length,
        0
      );

      return sendJson(res, {
        totalPlugins: plugins.length,
        totalVersions,
        totalDownloads,
        topPlugins: [...plugins]
          .sort((a, b) => effectiveDownloads(b) - effectiveDownloads(a))
          .slice(0, 5)
          .map((p) => ({ id: p.id, downloads: effectiveDownloads(p) }))
      });
    }

    // 404
    sendJson(res, { error: '端点未找到', path }, 404);
  } catch (e: any) {
    console.error('Registry服务器错误:', e);
    sendJson(res, { error: e.message }, 500);
  }
}

// 创建服务器
const server = createServer(handleRequest);

// 下载计数定期落盘（进程退出时也会 flush）。
const flushTimer = setInterval(flushDownloads, FLUSH_MS);
flushTimer.unref?.();

server.listen(PORT, () => {
  console.log(`🚀 插件市场 Registry Server 已启动`);
  console.log(`📡 地址: http://localhost:${PORT}`);
  if (!REGISTRY_TOKEN) {
    console.warn('⚠️  REGISTRY_TOKEN 未设置：发布端点开放，公网部署前请务必配置。');
  }
  console.log(`📋 API端点:`);
  console.log(`   GET  /api/registry/plugins        - 列出所有插件`);
  console.log(`   GET  /api/registry/plugins/:id    - 插件详情`);
  console.log(`   GET  /api/registry/search?q=xxx   - 搜索插件`);
  console.log(`   GET  /api/registry/stats          - 统计信息`);
  console.log(`   POST /api/registry/plugins        - 发布插件（受 REGISTRY_TOKEN 保护）`);
  console.log(`   GET  /plugins/<id>-<ver>.tar.gz   - 下载插件包`);
});

/** 优雅关闭：先 flush 下载计数，再关闭监听。 */
function shutdown(): void {
  console.log('\n👋 Registry Server 正在关闭...');
  clearInterval(flushTimer);
  try {
    flushDownloads();
  } catch (e) {
    console.error('flush 失败:', e);
  }
  server.close(() => {
    console.log('✅ Registry Server 已关闭');
    process.exit(0);
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

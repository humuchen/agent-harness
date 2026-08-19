/**
 * 最小插件市场 Registry Server
 *
 * 提供:
 * - 插件列表查询
 * - 插件版本解析
 * - 插件包下载
 * - 安装统计
 *
 * 运行方式:
 *   node packages/server/dist/registry-server.js
 *   PORT=4000 node packages/server/dist/registry-server.js
 */

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PORT = Number(process.env.PORT || process.env.REGISTRY_PORT || 4000);

// 插件存储目录
const REGISTRY_DIR = join(process.cwd(), 'registry-data');
const PLUGINS_FILE = join(REGISTRY_DIR, 'plugins.json');

// 初始化存储
if (!existsSync(REGISTRY_DIR)) {
  mkdirSync(REGISTRY_DIR, { recursive: true });
}

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
  if (!existsSync(PLUGINS_FILE)) {
    return [];
  }
  try {
    return JSON.parse(readFileSync(PLUGINS_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

// 保存插件
function savePlugins(plugins: PluginEntry[]): void {
  writeFileSync(PLUGINS_FILE, JSON.stringify(plugins, null, 2));
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
    },
    {
      id: 'customer-service',
      name: '智能客服',
      versions: [
        {
          version: '0.1.0',
          manifest: {
            id: 'customer-service',
            name: 'Customer Service Agent',
            version: '0.1.0',
            description: '通用智能客服插件',
            capabilities: ['chat']
          },
          tarballUrl: '/plugins/customer-service-0.1.0.tar.gz',
          publishedAt: '2026-08-19T00:00:00Z'
        }
      ],
      downloads: 128,
      publishedAt: '2026-08-19T00:00:00Z'
    }
  ];

  savePlugins(examples);
  console.log(`✅ 已加载 ${examples.length} 个示例插件`);
}

// 初始化
seedExamplePlugins();

/**
 * 发送JSON响应
 */
function sendJson(res: ServerResponse, data: any, status = 200): void {
  res.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*'
  });
  res.end(JSON.stringify(data));
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

  try {
    // GET /api/registry/plugins - 列出所有插件
    if (req.method === 'GET' && path === '/api/registry/plugins') {
      const plugins = loadPlugins();
      return sendJson(res, {
        plugins: plugins.map((p) => ({
          id: p.id,
          name: p.name,
          latestVersion: p.versions[p.versions.length - 1].version,
          downloads: p.downloads,
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
      const id = path.split('/').pop();
      const plugins = loadPlugins();
      const plugin = plugins.find((p) => p.id === id);

      if (!plugin) {
        return sendJson(res, { error: '插件未找到', id }, 404);
      }

      // 增加下载计数
      plugin.downloads++;
      savePlugins(plugins);

      return sendJson(res, { plugin });
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

    // POST /api/registry/plugins - 发布新插件
    if (req.method === 'POST' && path === '/api/registry/plugins') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        try {
          const data = JSON.parse(body);
          const { id, name, version, manifest, tarballUrl } = data;

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
            plugin.versions.sort((a, b) => a.version.localeCompare(b.version));
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
          latestVersion: p.versions[p.versions.length - 1].version,
          downloads: p.downloads
        })),
        total: results.length
      });
    }

    // GET /api/registry/stats - 统计信息
    if (req.method === 'GET' && path === '/api/registry/stats') {
      const plugins = loadPlugins();
      const totalDownloads = plugins.reduce((sum, p) => sum + p.downloads, 0);
      const totalVersions = plugins.reduce(
        (sum, p) => sum + p.versions.length,
        0
      );

      return sendJson(res, {
        totalPlugins: plugins.length,
        totalVersions,
        totalDownloads,
        topPlugins: plugins
          .sort((a, b) => b.downloads - a.downloads)
          .slice(0, 5)
          .map((p) => ({ id: p.id, downloads: p.downloads }))
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

server.listen(PORT, () => {
  console.log(`🚀 插件市场 Registry Server 已启动`);
  console.log(`📡 地址: http://localhost:${PORT}`);
  console.log(`📋 API端点:`);
  console.log(`   GET  /api/registry/plugins        - 列出所有插件`);
  console.log(`   GET  /api/registry/plugins/:id    - 插件详情`);
  console.log(`   GET  /api/registry/search?q=xxx   - 搜索插件`);
  console.log(`   GET  /api/registry/stats          - 统计信息`);
  console.log(`   POST /api/registry/plugins        - 发布插件`);
  console.log(`\n📖 使用示例:`);
  console.log(`   curl http://localhost:${PORT}/api/registry/plugins`);
  console.log(`   curl http://localhost:${PORT}/api/registry/search?q=medical`);
  console.log(`   curl http://localhost:${PORT}/api/registry/stats`);
});

// 优雅关闭
process.on('SIGTERM', () => {
  console.log('\n👋 Registry Server 正在关闭...');
  server.close(() => {
    console.log('✅ Registry Server 已关闭');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('\n👋 Registry Server 正在关闭...');
  server.close(() => {
    console.log('✅ Registry Server 已关闭');
    process.exit(0);
  });
});

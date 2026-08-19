/**
 * 健康检查模块 - K8s liveness/readiness探针支持
 *
 * 提供标准化健康检查端点:
 * - GET /health/live  - Liveness探针(进程存活)
 * - GET /health/ready - Readiness探针(依赖检查)
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

// 健康状态缓存
let lastReadyCheck = 0;
let lastReadyResult: HealthCheckResult | null = null;
const READY_CACHE_MS = 5000; // 5秒缓存

export interface HealthCheckResult {
  status: 'ok' | 'degraded' | 'error';
  checks: Record<string, HealthCheck>;
  uptime: number;
  timestamp: number;
}

export interface HealthCheck {
  status: 'ok' | 'error' | 'timeout';
  latency?: number;
  error?: string;
  details?: Record<string, any>;
}

/**
 * Liveness检查 - 仅检查进程是否存活
 * K8s liveness探针使用
 */
export function handleLiveness(
  req: IncomingMessage,
  res: ServerResponse
): void {
  const uptime = process.uptime();

  res.writeHead(200, {
    'content-type': 'application/json',
    'cache-control': 'no-cache'
  });
  res.end(
    JSON.stringify({
      status: 'ok',
      uptime: Math.round(uptime),
      timestamp: Date.now()
    })
  );
}

/**
 * Readiness检查 - 检查所有依赖是否就绪
 * K8s readiness探针使用
 */
export async function handleReadiness(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  // 使用缓存避免频繁检查
  const now = Date.now();
  if (lastReadyResult && now - lastReadyCheck < READY_CACHE_MS) {
    const statusCode =
      lastReadyResult.status === 'ok'
        ? 200
        : lastReadyResult.status === 'degraded'
          ? 200
          : 503;
    res.writeHead(statusCode, {
      'content-type': 'application/json',
      'cache-control': 'no-cache'
    });
    res.end(JSON.stringify(lastReadyResult));
    return;
  }

  const checks: Record<string, HealthCheck> = {};
  let status: 'ok' | 'degraded' | 'error' = 'ok';

  // 检查1: 数据库连接
  checks.database = await checkDatabase();
  if (checks.database.status === 'error') {
    status = 'error';
  }

  // 检查2: Redis连接(如果启用)
  const redisEnabled = process.env.REDIS_URL || process.env.REDIS_HOST;
  if (redisEnabled) {
    checks.redis = await checkRedis();
    if (checks.redis.status === 'error') {
      status = status === 'error' ? 'error' : 'degraded';
    }
  } else {
    checks.redis = { status: 'ok', details: { enabled: false } };
  }

  // 检查3: MCP服务(如果有)
  try {
    const { mcpManager } = await import('./mcp-manager');
    const mcpServers = mcpManager.list();
    checks.mcp = {
      status: 'ok',
      details: {
        count: mcpServers.length,
        servers: mcpServers.map((s: any) => s.name || s.id)
      }
    };
  } catch (e: any) {
    checks.mcp = {
      status: 'error',
      error: e?.message || 'MCP检查失败'
    };
    status = status === 'error' ? 'error' : 'degraded';
  }

  // 检查4: 内存使用
  const memUsage = process.memoryUsage();
  const memLimit = parseMemoryLimit(process.env.MEMORY_LIMIT_MB);
  const memPercent = memLimit
    ? (memUsage.heapUsed / 1024 / 1024 / memLimit) * 100
    : 0;

  checks.memory = {
    status: memPercent > 90 ? 'error' : memPercent > 70 ? 'ok' : 'ok',
    details: {
      heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024),
      heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
      rss: Math.round(memUsage.rss / 1024 / 1024),
      percent: Math.round(memPercent),
      limit: memLimit
    }
  };

  if (memPercent > 90) {
    status = 'error';
  } else if (memPercent > 70) {
    status = status === 'error' ? 'error' : 'degraded';
  }

  // 构建结果
  const result: HealthCheckResult = {
    status,
    checks,
    uptime: Math.round(process.uptime()),
    timestamp: now
  };

  // 缓存结果
  lastReadyCheck = now;
  lastReadyResult = result;

  // 返回响应
  const statusCode = status === 'ok' ? 200 : status === 'degraded' ? 200 : 503;
  res.writeHead(statusCode, {
    'content-type': 'application/json',
    'cache-control': 'no-cache'
  });
  res.end(JSON.stringify(result));
}

/**
 * 检查数据库连接
 */
async function checkDatabase(): Promise<HealthCheck> {
  const start = Date.now();
  try {
    // 尝试导入并查询数据库
    const { getDb } = await import('./chat-sessions');
    const db = getDb();

    // 执行简单查询测试连接
    db.prepare('SELECT 1').get();

    return {
      status: 'ok',
      latency: Date.now() - start
    };
  } catch (e: any) {
    return {
      status: 'error',
      latency: Date.now() - start,
      error: e?.message || '数据库连接失败'
    };
  }
}

/**
 * 检查Redis连接
 */
async function checkRedis(): Promise<HealthCheck> {
  const start = Date.now();
  try {
    const { getRedisClient } = await import('./redis-client');
    const redis = getRedisClient();

    if (!redis) {
      return {
        status: 'error',
        latency: Date.now() - start,
        error: 'Redis客户端未初始化'
      };
    }

    // PING测试
    await redis.ping();

    return {
      status: 'ok',
      latency: Date.now() - start
    };
  } catch (e: any) {
    return {
      status: 'error',
      latency: Date.now() - start,
      error: e?.message || 'Redis连接失败'
    };
  }
}

/**
 * 解析内存限制
 */
function parseMemoryLimit(envLimit?: string): number | null {
  if (!envLimit) return null;
  const mb = parseInt(envLimit, 10);
  return isNaN(mb) ? null : mb;
}

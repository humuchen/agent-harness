/**
 * Redis客户端封装
 *
 * 提供:
 * - 连接管理(自动重连)
 * - 健康检查(PING/PONG)
 * - 常用操作封装(GET/SET/DEL/EXPIRE)
 * - 优雅关闭
 */

import Redis from 'ioredis';

// 单例实例
let redisInstance: Redis | null = null;
let isConnecting = false;

/**
 * 获取Redis客户端(单例模式)
 *
 * @returns Redis实例,如果未配置则返回null
 */
export function getRedisClient(): Redis | null {
  if (redisInstance) {
    return redisInstance;
  }

  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    console.warn('[Redis] 未配置REDIS_URL,返回null');
    return null;
  }

  if (!isConnecting) {
    initializeRedis();
  }

  return redisInstance;
}

/**
 * 初始化Redis连接
 */
function initializeRedis(): void {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    return;
  }

  isConnecting = true;
  console.log('[Redis] 正在连接...');

  redisInstance = new Redis(redisUrl, {
    // 自动重连配置
    retryStrategy(times: number) {
      const delay = Math.min(times * 50, 2000);
      console.warn(`[Redis] 重连尝试 #${times}, 延迟${delay}ms`);
      return delay;
    },
    maxRetriesPerRequest: 3,
    lazyConnect: true,
    // 连接超时
    connectTimeout: 5000,
    commandTimeout: 3000,
    // 心跳检测
    keepAlive: 30000
  });

  // 事件监听
  redisInstance.on('connect', () => {
    console.log('[Redis] ✅ 连接成功');
    isConnecting = false;
  });

  redisInstance.on('error', (err) => {
    console.error('[Redis] ❌ 错误:', err.message);
    isConnecting = false;
  });

  redisInstance.on('close', () => {
    console.warn('[Redis] 连接关闭');
  });

  redisInstance.on('reconnecting', () => {
    console.log('[Redis] 正在重连...');
  });

  redisInstance.on('end', () => {
    console.warn('[Redis] 连接结束');
  });
}

/**
 * 健康检查 - PING测试
 *
 * @returns PONG响应时间(毫秒),失败返回-1
 */
export async function ping(): Promise<number> {
  const client = getRedisClient();
  if (!client) {
    return -1;
  }

  try {
    const start = Date.now();
    const result = await client.ping();
    const latency = Date.now() - start;

    if (result === 'PONG') {
      return latency;
    }
    return -1;
  } catch (e: any) {
    console.error('[Redis] PING失败:', e?.message);
    return -1;
  }
}

/**
 * 获取键值
 *
 * @param key 键名
 * @returns 值或null
 */
export async function get(key: string): Promise<string | null> {
  const client = getRedisClient();
  if (!client) {
    throw new Error('Redis客户端未初始化');
  }

  return client.get(key);
}

/**
 * 设置键值
 *
 * @param key 键名
 * @param value 值
 * @param ttl 过期时间(秒,可选)
 */
export async function set(
  key: string,
  value: string,
  ttl?: number
): Promise<'OK'> {
  const client = getRedisClient();
  if (!client) {
    throw new Error('Redis客户端未初始化');
  }

  if (ttl) {
    return client.set(key, value, 'EX', ttl);
  }
  return client.set(key, value);
}

/**
 * 删除键
 *
 * @param key 键名
 * @returns 删除的键数量
 */
export async function del(key: string): Promise<number> {
  const client = getRedisClient();
  if (!client) {
    throw new Error('Redis客户端未初始化');
  }

  return client.del(key);
}

/**
 * 设置键过期时间
 *
 * @param key 键名
 * @param seconds 过期时间(秒)
 * @returns 1=成功, 0=键不存在
 */
export async function expire(key: string, seconds: number): Promise<number> {
  const client = getRedisClient();
  if (!client) {
    throw new Error('Redis客户端未初始化');
  }

  return client.expire(key, seconds);
}

/**
 * 检查键是否存在
 *
 * @param key 键名
 * @returns true=存在
 */
export async function exists(key: string): Promise<boolean> {
  const client = getRedisClient();
  if (!client) {
    return false;
  }

  const result = await client.exists(key);
  return result > 0;
}

/**
 * 获取键剩余过期时间
 *
 * @param key 键名
 * @returns 剩余秒数, -1=永不过期, -2=键不存在
 */
export async function ttl(key: string): Promise<number> {
  const client = getRedisClient();
  if (!client) {
    return -2;
  }

  return client.ttl(key);
}

/**
 * 优雅关闭Redis连接
 */
export async function shutdown(): Promise<void> {
  if (redisInstance) {
    console.log('[Redis] 正在关闭连接...');
    try {
      await redisInstance.quit();
      console.log('[Redis] ✅ 连接已关闭');
    } catch (e: any) {
      console.error('[Redis] 关闭失败:', e?.message);
    } finally {
      redisInstance = null;
      isConnecting = false;
    }
  }
}

/**
 * 获取Redis连接状态
 *
 * @returns 连接状态信息
 */
export function getStatus(): {
  connected: boolean;
  configured: boolean;
  status: string;
} {
  const configured = !!process.env.REDIS_URL;
  const connected = redisInstance?.status === 'ready';

  return {
    connected,
    configured,
    status: redisInstance?.status || 'not_initialized'
  };
}

/**
 * 刷新连接(用于健康检查或故障恢复)
 *
 * @returns 是否刷新成功
 */
export async function refresh(): Promise<boolean> {
  if (redisInstance) {
    try {
      await redisInstance.disconnect();
      redisInstance = null;
      isConnecting = false;

      const client = getRedisClient();
      return client !== null;
    } catch (e: any) {
      console.error('[Redis] 刷新失败:', e?.message);
      return false;
    }
  }

  // 如果之前未连接,尝试初始化
  const client = getRedisClient();
  return client !== null;
}

// 导出ioredis类型供高级使用
export { Redis };

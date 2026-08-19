# Redis客户端使用指南

## 概述

`redis-client.ts` 提供了完整的 Redis 客户端封装，基于 `ioredis` 实现。

## 快速开始

### 1. 配置环境变量

```bash
# .env
REDIS_URL=redis://localhost:6379

# 或使用云服务商
REDIS_URL=redis://:password@host:port/db
```

### 2. 基本使用

```typescript
import { getRedisClient, get, set, del } from './redis-client';

// 获取客户端实例
const redis = getRedisClient();
if (!redis) {
  console.log('Redis未配置');
  return;
}

// 设置值
await set('user:123', JSON.stringify({ name: '张三' }));

// 设置值并指定过期时间(60秒)
await set('session:abc', 'token123', 60);

// 获取值
const user = await get('user:123');
console.log(JSON.parse(user));

// 删除值
await del('user:123');
```

## API参考

### 连接管理

#### `getRedisClient(): Redis | null`

获取 Redis 客户端单例。

```typescript
const client = getRedisClient();
if (client) {
  // 使用原生ioredis API
  await client.hset('user:123', 'name', '张三');
}
```

**返回值**:

- `Redis` - 客户端实例
- `null` - 未配置 REDIS_URL

---

#### `getStatus(): { connected, configured, status }`

获取连接状态。

```typescript
const status = getStatus();
// {
//   connected: true,
//   configured: true,
//   status: 'ready'
// }
```

**字段说明**:

- `connected` - 是否已连接
- `configured` - 是否配置了 REDIS_URL
- `status` - ioredis 状态字符串

---

#### `shutdown(): Promise<void>`

优雅关闭连接。

```typescript
// 在应用退出时调用
process.on('SIGTERM', async () => {
  await shutdown();
  process.exit(0);
});
```

---

#### `refresh(): Promise<boolean>`

刷新连接（故障恢复）。

```typescript
if (getStatus().status === 'error') {
  const success = await refresh();
  console.log('刷新结果:', success);
}
```

---

### 基本操作

#### `ping(): Promise<number>`

健康检查 PING 测试。

```typescript
const latency = await ping();
if (latency < 0) {
  console.error('Redis不可用');
} else {
  console.log(`响应时间: ${latency}ms`);
}
```

**返回值**:

- `>=0` - 响应时间(毫秒)
- `-1` - PING 失败或未配置

---

#### `get(key: string): Promise<string | null>`

获取键值。

```typescript
const value = await get('cache:homepage');
if (value) {
  return JSON.parse(value);
}
```

---

#### `set(key: string, value: string, ttl?: number): Promise<'OK'>`

设置键值。

```typescript
// 永久存储
await set('config:app', JSON.stringify({ debug: true }));

// 带过期时间(60秒)
await set('session:xyz', 'token', 60);
```

---

#### `del(key: string): Promise<number>`

删除键。

```typescript
const deleted = await del('user:123');
console.log(`删除了 ${deleted} 个键`);
```

---

#### `expire(key: string, seconds: number): Promise<number>`

设置过期时间。

```typescript
// 将现有键设置为10分钟后过期
await expire('cache:data', 600);
```

---

#### `exists(key: string): Promise<boolean>`

检查键是否存在。

```typescript
if (await exists('user:123')) {
  console.log('用户缓存存在');
}
```

---

#### `ttl(key: string): Promise<number>`

获取剩余过期时间。

```typescript
const remaining = await ttl('session:abc');
if (remaining === -1) {
  console.log('永不过期');
} else if (remaining === -2) {
  console.log('键不存在');
} else {
  console.log(`剩余 ${remaining} 秒`);
}
```

---

## 高级模式

### 缓存模式

```typescript
async function getCachedUser(userId: string) {
  const cacheKey = `user:${userId}`;

  // 1. 尝试从缓存读取
  const cached = await get(cacheKey);
  if (cached) {
    return JSON.parse(cached);
  }

  // 2. 缓存未命中，查询数据库
  const user = await db.query('SELECT * FROM users WHERE id = ?', [userId]);

  // 3. 写入缓存(5分钟过期)
  await set(cacheKey, JSON.stringify(user), 300);

  return user;
}
```

---

### 会话管理

```typescript
async function createSession(userId: string) {
  const sessionId = generateId();
  const sessionData = JSON.stringify({
    userId,
    createdAt: Date.now()
  });

  // 会话30分钟过期
  await set(`session:${sessionId}`, sessionData, 1800);

  return sessionId;
}

async function validateSession(sessionId: string) {
  const data = await get(`session:${sessionId}`);
  if (!data) {
    return null; // 会话过期或不存在
  }

  // 刷新过期时间(滑动过期)
  await expire(`session:${sessionId}`, 1800);

  return JSON.parse(data);
}
```

---

### 限流器

```typescript
async function checkRateLimit(
  userId: string,
  maxRequests: number,
  windowSecs: number
) {
  const key = `ratelimit:${userId}`;

  const count = await get(key);
  if (!count) {
    // 第一次请求
    await set(key, '1', windowSecs);
    return true;
  }

  const currentCount = parseInt(count);
  if (currentCount >= maxRequests) {
    return false; // 超出限制
  }

  // 增加计数
  await set(key, String(currentCount + 1));
  return true;
}

// 使用示例: 每用户每分钟最多10次请求
const allowed = await checkRateLimit('user123', 10, 60);
if (!allowed) {
  throw new Error('请求过于频繁');
}
```

---

### 分布式锁

```typescript
async function acquireLock(
  resourceId: string,
  ttlSeconds: number
): Promise<boolean> {
  const key = `lock:${resourceId}`;
  const value = `locked:${Date.now()}`;

  // SET NX (仅当键不存在时设置)
  const client = getRedisClient();
  if (!client) return false;

  const result = await client.set(key, value, 'EX', ttlSeconds, 'NX');
  return result === 'OK';
}

async function releaseLock(resourceId: string) {
  await del(`lock:${resourceId}`);
}

// 使用示例
if (await acquireLock('payment:order123', 30)) {
  try {
    // 处理支付...
  } finally {
    await releaseLock('payment:order123');
  }
}
```

---

## 健康检查集成

Redis 客户端已集成到健康检查模块：

```typescript
// packages/server/src/health.ts
async function checkRedis(): Promise<HealthCheck> {
  const { ping } = await import('./redis-client');
  const latency = await ping();

  if (latency < 0) {
    return { status: 'error', error: 'Redis PING失败' };
  }

  return { status: 'ok', latency };
}
```

---

## 自动重连

客户端内置自动重连机制：

```typescript
// redis-client.ts 已配置
redisInstance = new Redis(redisUrl, {
  retryStrategy(times: number) {
    const delay = Math.min(times * 50, 2000); // 指数退避
    return delay;
  },
  maxRetriesPerRequest: 3
});
```

**重连策略**:

- 第1次重试: 50ms
- 第2次重试: 100ms
- 第3次重试: 150ms
- ...
- 最大延迟: 2000ms

---

## 错误处理

```typescript
try {
  const value = await get('some:key');
  // 处理值...
} catch (error) {
  if (error.message === 'Redis客户端未初始化') {
    // 降级到内存存储或数据库
    console.warn('Redis不可用,使用备用方案');
  } else {
    throw error;
  }
}
```

---

## 环境变量

| 变量        | 说明            | 示例                                 |
| ----------- | --------------- | ------------------------------------ |
| `REDIS_URL` | Redis连接字符串 | `redis://localhost:6379`             |
|             | 带密码          | `redis://:password@host:6379/0`      |
|             | Redis Cloud     | `redis://user:pass@cloud.redis:6379` |

---

## 性能优化建议

### 1. 连接池

ioredis 默认单连接，对于大多数场景足够。如果需要连接池：

```typescript
import Redis from 'ioredis';

// 创建多个实例
const readClient = new Redis(redisUrl);
const writeClient = new Redis(redisUrl);
```

### 2. Pipeline

批量操作使用 Pipeline 减少网络往返：

```typescript
const client = getRedisClient();
const pipeline = client.pipeline();

pipeline.set('key1', 'value1');
pipeline.set('key2', 'value2');
pipeline.set('key3', 'value3');

const results = await pipeline.exec();
```

### 3. 合理设置 TTL

```typescript
// 短期缓存(高频更新数据)
await set('stats:realtime', data, 30); // 30秒

// 中期缓存(配置数据)
await set('config:app', config, 3600); // 1小时

// 长期缓存(静态数据)
await set('dict:provinces', provinces, 86400); // 24小时
```

---

## 监控和日志

客户端自动输出关键日志：

```
[Redis] 正在连接...
[Redis] ✅ 连接成功
[Redis] ❌ 错误: ECONNREFUSED
[Redis] 正在重连...
[Redis] 连接关闭
```

可通过监听事件自定义日志行为：

```typescript
const client = getRedisClient();
if (client) {
  client.on('error', (err) => {
    // 发送到错误追踪系统
    sentry.captureException(err);
  });
}
```

---

## 测试

```bash
# 运行测试
pnpm --filter @agent-harness/server test test/redis-client.test.cjs
```

**测试覆盖**:

- ✅ 未配置时返回 null
- ✅ 导出所有必需方法
- ✅ 状态查询
- ✅ PING 测试

---

## 故障排查

### 问题1: 返回 null

**原因**: 未配置 REDIS_URL

**解决**:

```bash
export REDIS_URL=redis://localhost:6379
```

### 问题2: 连接超时

**原因**: Redis 服务未启动或网络问题

**解决**:

```bash
# 检查 Redis 是否运行
redis-cli ping

# 检查网络
telnet localhost 6379
```

### 问题3: 频繁重连

**原因**: Redis 服务不稳定

**解决**:

1. 检查 Redis 日志
2. 调整 `retryStrategy`
3. 考虑使用 Redis Sentinel 或 Cluster

---

## 最佳实践

1. ✅ **始终检查 null** - `getRedisClient()` 可能返回 null
2. ✅ **设置 TTL** - 避免内存无限增长
3. ✅ **错误降级** - Redis 不可用时使用备用方案
4. ✅ **优雅关闭** - 应用退出时调用 `shutdown()`
5. ✅ **监控延迟** - 定期检查 `ping()` 响应时间
6. ❌ **不要存储大对象** - 单键值建议 < 10KB
7. ❌ **不要阻塞事件循环** - 使用异步 API

---

## 相关文档

- [ioredis 官方文档](https://github.com/luin/ioredis)
- [Redis 命令参考](https://redis.io/commands/)
- [健康检查模块](../health.ts)

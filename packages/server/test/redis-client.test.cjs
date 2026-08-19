/**
 * Redis客户端测试
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('Redis Client', () => {
  it('应该在未配置REDIS_URL时返回null', () => {
    // 清除环境变量
    const originalUrl = process.env.REDIS_URL;
    delete process.env.REDIS_URL;

    // 需要重新加载模块
    delete require.cache[require.resolve('../dist/redis-client')];
    const { getRedisClient } = require('../dist/redis-client');

    const client = getRedisClient();
    assert.strictEqual(client, null, '未配置时应返回null');

    // 恢复环境变量
    if (originalUrl) {
      process.env.REDIS_URL = originalUrl;
    }
  });

  it('应该导出所有必需的方法', () => {
    delete require.cache[require.resolve('../dist/redis-client')];
    const redis = require('../dist/redis-client');

    const requiredExports = [
      'getRedisClient',
      'ping',
      'get',
      'set',
      'del',
      'expire',
      'exists',
      'ttl',
      'shutdown',
      'getStatus',
      'refresh'
    ];

    for (const name of requiredExports) {
      assert.ok(typeof redis[name] === 'function', `应导出 ${name} 函数`);
    }
  });

  it('getStatus应返回正确的状态', () => {
    delete require.cache[require.resolve('../dist/redis-client')];
    const { getStatus } = require('../dist/redis-client');

    const status = getStatus();
    assert.ok(typeof status === 'object', '应返回对象');
    assert.ok('connected' in status, '应包含connected字段');
    assert.ok('configured' in status, '应包含configured字段');
    assert.ok('status' in status, '应包含status字段');
  });

  it('ping在未配置时应返回-1', async () => {
    const originalUrl = process.env.REDIS_URL;
    delete process.env.REDIS_URL;

    delete require.cache[require.resolve('../dist/redis-client')];
    const { ping } = require('../dist/redis-client');

    const result = await ping();
    assert.strictEqual(result, -1, '未配置时应返回-1');

    if (originalUrl) {
      process.env.REDIS_URL = originalUrl;
    }
  });
});

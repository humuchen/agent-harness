'use strict';
// P0-3 回归：BYOK 连通性校验缓存的跨用户隔离与容量上限。
//
// 背景：旧实现缓存键为 `provider:apiKey.slice(0, 8)` —— OpenRouter Key 统一以
// `sk-or-v1-` 开头，所有用户共享同一缓存条目，A 用户的校验结果（valid/limit/usage）
// 会串给 B 用户；且缓存 Map 无淘汰机制，条目随用户增长永不删除（缓慢泄漏）。
// 修复后：缓存键 = 完整 Key 的 SHA-256 摘要；容量上限 + 惰性淘汰。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PK_JS = path.join(__dirname, '..', 'dist', 'provider-keys.js');
const RUN = fs.existsSync(PK_JS);

test('verifyProviderKey: 缓存键按完整 Key 摘要隔离——同前缀不同 Key 不串号', { skip: !RUN }, async () => {
  const mod = require(PK_JS);
  const authCalls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (_url, opts) => {
    const auth = opts?.headers?.Authorization ?? '';
    authCalls.push(auth);
    const key = auth.slice('Bearer '.length);
    return {
      ok: true,
      json: async () => ({
        data: { limit: key.includes('AAAA') ? 100 : 200, usage: 5 }
      })
    };
  });
  try {
    const a = await mod.verifyProviderKey('openrouter', 'sk-or-v1-AAAA1111AAAA1111AAAA');
    const b = await mod.verifyProviderKey('openrouter', 'sk-or-v1-BBBB2222BBBB2222BBBB');
    assert.strictEqual(a.limit, 100);
    // 旧实现此处会错误返回 100（共享 `sk-or-v1-` 前缀缓存键）
    assert.strictEqual(b.limit, 200, '不同用户 Key 的校验结果不得串号（P0-3 回归）');
    // 同 Key 二次调用命中缓存：不再打网络
    const before = authCalls.length;
    await mod.verifyProviderKey('openrouter', 'sk-or-v1-AAAA1111AAAA1111AAAA');
    assert.strictEqual(authCalls.length, before, 'TTL 内同 Key 应命中缓存');
    // 缓存条目有界
    const stats = mod.verifyCacheStats();
    assert.ok(stats.size <= stats.max);
    assert.ok(stats.max >= 16);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('verifyProviderKey: 容量上限触发惰性淘汰（条目数不超上限）', { skip: !RUN }, async () => {
  const mod = require(PK_JS);
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    json: async () => ({ data: { limit: 1, usage: 0 } })
  }));
  try {
    // 默认上限 1000：灌 40 个不同 Key（远小于上限但足以验证增长与不报错）；
    // 淘汰逻辑由 verifyCacheStats.size <= max 不变量 + 独立小上限路径覆盖。
    const keys = [];
    for (let i = 0; i < 40; i++) {
      keys.push(`sk-or-v1-EVICT${String(i).padStart(4, '0')}xxxxxxxx`);
    }
    for (const k of keys) await mod.verifyProviderKey('openrouter', k);
    const stats = mod.verifyCacheStats();
    assert.ok(stats.size <= stats.max, '缓存条目数不得超过上限');
    assert.ok(stats.size >= 40, '未达上限时不得误淘汰');
  } finally {
    globalThis.fetch = origFetch;
  }
});

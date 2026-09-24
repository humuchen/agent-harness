'use strict';
/**
 * 三项收尾落地测试：
 * ① DNS rebinding 防护：isPrivateIp 覆盖 / checkEgressAsync 开关语义 / webfetch 连接时校验
 * ② Turso failover：连接错误降级走本地、语义错误直抛、探活恢复切回远端
 * ③ per-tenant guardrails：引擎隔离 + 租户注册表 resolve 链
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  isPrivateIp,
  checkEgressAsync,
  GuardrailsEngine,
  defaultGuardrailsEngine,
  getGuardrailsForTenant,
  resolveTenantGuardrailPolicy,
  resetTenantGuardrailsForTest,
  policyEngine,
  FailoverProxyAdapter,
  getDbAdapter,
  resetDbAdaptersForTest,
} = require('../dist/index.js');

// ---------------------------------------------------------------------------
// ① DNS rebinding / 私网判定
// ---------------------------------------------------------------------------

test('isPrivateIp：元数据/链路本地/ULA/CGNAT/IPv4-mapped 全覆盖，公网放行', () => {
  assert.strictEqual(isPrivateIp('169.254.169.254'), true, '云元数据地址必须判私网');
  assert.strictEqual(isPrivateIp('127.0.0.1'), true);
  assert.strictEqual(isPrivateIp('10.1.2.3'), true);
  assert.strictEqual(isPrivateIp('172.16.0.1'), true);
  assert.strictEqual(isPrivateIp('172.31.255.255'), true);
  assert.strictEqual(isPrivateIp('192.168.1.1'), true);
  assert.strictEqual(isPrivateIp('100.64.0.1'), true, 'CGNAT 段');
  assert.strictEqual(isPrivateIp('::1'), true);
  assert.strictEqual(isPrivateIp('fd00::1'), true, 'ULA fc00::/7');
  assert.strictEqual(isPrivateIp('fe80::1'), true, '链路本地');
  assert.strictEqual(isPrivateIp('::ffff:10.0.0.5'), true, 'IPv4-mapped');
  assert.strictEqual(isPrivateIp('8.8.8.8'), false);
  assert.strictEqual(isPrivateIp('172.32.0.1'), false, '172.16/12 之外不算');
  assert.strictEqual(isPrivateIp('11.0.0.1'), false);
});

test('checkEgressAsync：allowPrivateNetwork=false 时私网字面量被拦；缺省豁免零回归', async () => {
  const netStrict = { mode: 'allowlist', allowedDomains: ['example.com'], allowPrivateNetwork: false };
  const denied = await checkEgressAsync('http://127.0.0.1:8080/x', netStrict);
  assert.ok(denied && denied.includes('private network'), 'false 时私网必须拦截');

  const netDefault = { mode: 'allowlist', allowedDomains: ['example.com'] };
  const exempt = await checkEgressAsync('http://127.0.0.1:8080/x', netDefault);
  assert.strictEqual(exempt, null, '缺省（未设 allowPrivateNetwork）保持豁免零回归');

  // denylist '*'：外部域名仍按域名规则拦截（不依赖 DNS）
  const deniedList = await checkEgressAsync('https://api.external.dev/x', {
    mode: 'denylist',
    deniedDomains: ['*'],
  });
  assert.ok(deniedList && deniedList.includes('denylist'));
});

test('webfetch：连接时校验（ctx.networkPolicy.allowPrivateNetwork=false → 私网目标被拒）', async () => {
  const { ToolRegistry } = require('../dist/tools.js');
  const { registerWebFetch } = require('../dist/builtins/webfetch.js');
  const reg = new ToolRegistry();
  registerWebFetch(reg, {});
  const tool = reg.entries().find((t) => t.name === 'builtin__web_fetch');
  assert.ok(tool, 'web_fetch 应已注册');
  const out = await tool.fn(
    { url: 'http://127.0.0.1:9/x' },
    { networkPolicy: { mode: 'open', allowPrivateNetwork: false } }
  );
  assert.match(String(out), /private network address/, '连接前必须被解析级校验拦截');
});

// ---------------------------------------------------------------------------
// ② FailoverProxyAdapter 状态机
// ---------------------------------------------------------------------------

function makeFakePrimary() {
  return {
    cacheKey: 'fake-primary',
    mode: 'remote',
    failNext: 0, // >0 时接下来的 exec 抛连接错误；-1 表示语义错误
    execCalls: 0,
    exec(sql) {
      this.execCalls += 1;
      if (this.failNext > 0) {
        this.failNext -= 1;
        throw new Error('fetch failed: connection refused');
      }
      if (this.failNext === -1) {
        this.failNext = 0;
        throw new Error('SQL syntax error near FROM');
      }
      return undefined;
    },
    prepare(sql) {
      return {
        run: (...p) => this.exec(sql),
        get: () => ({ from: 'remote' }),
        all: () => [{ from: 'remote' }],
      };
    },
    close() {},
  };
}

test('FailoverProxy：连接错误降级走本地；语义错误直抛不降级；探活恢复切回远端', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-failover-'));
  const localFile = path.join(dir, 'local.db');
  try {
    FailoverProxyAdapter.DEGRADE_THRESHOLD = 2;
    FailoverProxyAdapter.PROBE_WINDOW_MS = 80;
    const primary = makeFakePrimary();
    const proxy = new FailoverProxyAdapter(
      primary,
      getDbAdapter({ file: localFile, backend: 'sqlite' }),
      { cacheKey: 'test:failover', label: 'test' }
    );

    // healthy：直连远端
    proxy.exec('CREATE TABLE IF NOT EXISTS t (x TEXT)');
    assert.strictEqual(primary.execCalls, 1);

    // 语义错误：直抛，不进入降级计数（远端仍被使用）
    primary.failNext = -1;
    assert.throws(() => proxy.exec('SELECT * FROM nope'), /SQL syntax/);
    assert.strictEqual(primary.execCalls, 2);

    // 连接错误 ×2 → 降级，后续走本地（本地先建同构表）
    primary.failNext = 2;
    proxy.exec('CREATE TABLE IF NOT EXISTS t (x TEXT)');
    proxy.exec('INSERT INTO t (x) VALUES (?)');
    const before = primary.execCalls;
    proxy.exec('INSERT INTO t (x) VALUES (?)');
    assert.strictEqual(primary.execCalls, before, '降级窗口内不应再打远端');
    // 本地库应已有 2 条插入（fake 远端只会返回 {from:'remote'}，本地 sqlite 返回真实行）
    const rows = proxy.prepare('SELECT x FROM t').all();
    assert.strictEqual(rows.length, 2, '窗口内读写均走本地');
    assert.notStrictEqual(rows[0] && rows[0].from, 'remote');

    // 探活窗口过期 → probe 远端成功 → 恢复
    const waitMs = 120;
    const start = Date.now();
    return new Promise((resolve) => {
      const tick = () => {
        if (Date.now() - start >= waitMs) return resolve();
        setTimeout(tick, 20);
      };
      tick();
    }).then(() => {
      proxy.exec('INSERT INTO t (x) VALUES (?)');
      assert.ok(primary.execCalls > before, '窗口过期后应 probe 远端');
    });
  } finally {
    FailoverProxyAdapter.DEGRADE_THRESHOLD = 2;
    FailoverProxyAdapter.PROBE_WINDOW_MS = 15_000;
    resetDbAdaptersForTest();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ok */ }
  }
});

// ---------------------------------------------------------------------------
// ③ per-tenant guardrails
// ---------------------------------------------------------------------------

test('GuardrailsEngine：实例策略隔离，互不影响全局默认', () => {
  const strict = new GuardrailsEngine({
    ...require('../dist/guardrails.js').getGuardrailPolicy(),
  });
  const lenBefore = defaultGuardrailsEngine.policy.maxInputLength;
  strict.configure({ maxInputLength: 10 });
  assert.strictEqual(strict.policy.maxInputLength, 10);
  assert.strictEqual(defaultGuardrailsEngine.policy.maxInputLength, lenBefore, '全局默认不受实例影响');
  const blocked = strict.checkInput('a'.repeat(50));
  assert.strictEqual(blocked.ok, false, '实例收紧后长输入被拦');
});

test('getGuardrailsForTenant：租户策略经注册表解析，租户间互不影响', () => {
  resetTenantGuardrailsForTest();
  policyEngine.registerTenantPolicy('t-strict', {
    ...policyEngine.getPolicy(undefined),
    maxInputLength: 300,
    network: { mode: 'denylist', deniedDomains: ['*'], allowPrivateNetwork: false },
  });
  const e1 = getGuardrailsForTenant('t-strict');
  assert.strictEqual(e1.policy.maxInputLength, 300, '租户显式策略生效');
  const e2 = getGuardrailsForTenant('t-other');
  assert.notStrictEqual(e2.policy.maxInputLength, 300, '其它租户不受影响（隔离）');
  // TTL 缓存：同租户同实例
  assert.strictEqual(getGuardrailsForTenant('t-strict'), e1);
  // 快照入口
  const snap = resolveTenantGuardrailPolicy('t-strict');
  assert.strictEqual(snap.network.allowPrivateNetwork, false);
  resetTenantGuardrailsForTest();
});

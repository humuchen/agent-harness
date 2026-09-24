// GUARDRAIL_ALLOW_PRIVATE_NETWORK 部署开关守护测试：
// - 缺省 false（secure by default，P0 修复）：私网地址纳入管控；
// - 显式 true：恢复放行（内网互访部署的逃生舱）。
// resolveDefaultPolicy 按调用时 process.env 求值（模块级 policy 单例在导入时已固化，
// 测试直接调 resolveDefaultPolicy 验证 env → 策略映射）。
const test = require('node:test');
const assert = require('node:assert');

const { resolveDefaultPolicy, checkEgress } = require('../dist/guardrails.js');

function withEnv(env, fn) {
  const keys = Object.keys(env);
  const saved = keys.map((k) => [k, process.env[k]]);
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('缺省：allowPrivateNetwork=false（secure by default），私网纳入管控', () => {
  withEnv(
    {
      GUARDRAIL_ALLOW_PRIVATE_NETWORK: undefined,
      GUARDRAIL_NETWORK_MODE: 'allowlist',
      GUARDRAIL_ALLOWED_DOMAINS: 'example.com'
    },
    () => {
      const pol = resolveDefaultPolicy();
      assert.strictEqual(pol.network?.allowPrivateNetwork, false);
      // 缺省收紧：loopback / 私网一律拒绝（SSRF 防护默认生效）
      assert.ok(checkEgress('http://127.0.0.1:8080/x', pol.network), 'loopback 应被拒');
      assert.ok(checkEgress('http://10.1.2.3/x', pol.network), '私网应被拒');
    }
  );
});

test('GUARDRAIL_ALLOW_PRIVATE_NETWORK=false：私网纳入管控（SSRF 收紧）', () => {
  withEnv(
    {
      GUARDRAIL_ALLOW_PRIVATE_NETWORK: 'false',
      GUARDRAIL_NETWORK_MODE: 'allowlist',
      GUARDRAIL_ALLOWED_DOMAINS: 'example.com'
    },
    () => {
      const pol = resolveDefaultPolicy();
      assert.strictEqual(pol.network?.allowPrivateNetwork, false);
      assert.ok(
        checkEgress('http://127.0.0.1:8080/x', pol.network),
        'loopback 应被拒'
      );
      assert.ok(checkEgress('http://10.1.2.3/x', pol.network), '私网应被拒');
      // 公网 allowlist 命中不受影响
      assert.strictEqual(checkEgress('https://example.com/a', pol.network), null);
    }
  );
});

test('开关对 denylist/allowlist 均写入策略；0/off 变体等价 false', () => {
  // 注：同步 checkEgress 在 denylist 模式下对「未列入 denylist 的私网」本就按
  // 域名规则放行（strict 私网拒绝发生在 checkEgressAsync 的 DNS 展开路径），
  // 因此这里验证策略字段写入与 allowlist 模式的实际拒绝行为。
  withEnv(
    {
      GUARDRAIL_ALLOW_PRIVATE_NETWORK: '0',
      GUARDRAIL_NETWORK_MODE: 'denylist',
      GUARDRAIL_DENIED_DOMAINS: 'evil.com'
    },
    () => {
      const pol = resolveDefaultPolicy();
      assert.strictEqual(pol.network?.allowPrivateNetwork, false);
    }
  );
  withEnv(
    {
      GUARDRAIL_ALLOW_PRIVATE_NETWORK: '0',
      GUARDRAIL_NETWORK_MODE: 'allowlist',
      GUARDRAIL_ALLOWED_DOMAINS: 'example.com'
    },
    () => {
      const pol = resolveDefaultPolicy();
      assert.strictEqual(pol.network?.allowPrivateNetwork, false);
      assert.ok(checkEgress('http://192.168.1.1/x', pol.network), '0 变体：私网被拒');
    }
  );
  withEnv(
    {
      GUARDRAIL_ALLOW_PRIVATE_NETWORK: 'off',
      GUARDRAIL_NETWORK_MODE: 'denylist',
      GUARDRAIL_DENIED_DOMAINS: 'evil.com'
    },
    () => {
      const pol = resolveDefaultPolicy();
      assert.strictEqual(pol.network?.allowPrivateNetwork, false);
    }
  );
  withEnv(
    {
      GUARDRAIL_ALLOW_PRIVATE_NETWORK: 'true',
      GUARDRAIL_NETWORK_MODE: 'denylist',
      GUARDRAIL_DENIED_DOMAINS: 'evil.com'
    },
    () => {
      const pol = resolveDefaultPolicy();
      assert.strictEqual(pol.network?.allowPrivateNetwork, true);
      assert.strictEqual(checkEgress('http://192.168.1.1/x', pol.network), null);
    }
  );
});

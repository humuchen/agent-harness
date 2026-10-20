// mobile 插件 wrapper 契约测试（README 所称「interface + default impl 可测性」的落地）。
//
// 通过 setPluginsForTest 注入 mock 插件注册表，覆盖：
// - offline-cache：set/get 往返、TTL 过期（get→null / getWithMeta→stale）、损坏 JSON 隔离、clear
// - biometric-auth：token AES-GCM 加密落盘往返（Node webcrypto）、信封损坏→null（fail-safe）、
//   clearToken 连密钥一并清除、每安装密钥跨调用稳定
// - push-notification / deep-link：非原生环境（isNative=false）全部 no-op
// - haptics：impact/notification/selection/vibrate → 原生插件映射、用户开关
//   （ah:haptics:enabled=false 时全部静默）、原生抛错 fail-safe、非原生 no-op
//
// 运行：pnpm --filter @agent-harness/mobile run test（先以 tsconfig.test.json 编译 src → dist-test）
const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');

// 上游打包缺陷（@aparajita/capacitor-biometric-auth@10.0.0）：exports["."]["require"]
// 指向不存在的 dist/plugin.cjs，实际产物 plugin.cjs.js 又位于 "type":"module" 包内
// （内含 require 调用，CJS 加载必然 ReferenceError）——该包无法被任何 CJS 消费者加载。
// 生产构建走 ESM（Vite import 条件）不受影响；测试内以「原生不可用」stub 替代，
// 只验证封装层的 fail-safe 语义（isAvailable/authenticate 的 catch 分支）。
const origModuleLoad = Module._load;
const BIOMETRIC_STUB = {
  BiometricAuth: {
    checkBiometry: async () => {
      throw new Error('native only');
    },
    authenticate: async () => {
      throw new Error('native only');
    },
  },
  BiometryType: { none: 0, touchId: 1, faceId: 2, fingerprintAuthentication: 3, faceAuthentication: 4, irisAuthentication: 5 },
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
Module._load = function (request, ...rest) {
  if (request === '@aparajita/capacitor-biometric-auth') return BIOMETRIC_STUB;
  return origModuleLoad.call(this, request, ...rest);
};

let nodeMajorOk = true;
try {
  require(process.cwd() + '/dist-test/plugins/offline-cache.js');
} catch (e) {
  nodeMajorOk = false;
  console.warn('[mobile-test] dist-test 缺失（先跑 tsc -p tsconfig.test.json）：', e.message);
}

const BUILT = nodeMajorOk;
const SKIP = { skip: !BUILT };

// ─── mock 插件注册表 ──────────────────────────────────────────────────────────

function makePrefsMock() {
  const store = new Map();
  return {
    async get({ key }) {
      return { value: store.has(key) ? store.get(key) : null };
    },
    async set({ key, value }) {
      store.set(key, String(value));
    },
    async remove({ key }) {
      store.delete(key);
    },
    async clear() {
      store.clear();
    },
    _store: store,
  };
}

function inject({ prefs, isNative = false, haptics } = {}) {
  const { setPluginsForTest } = require(process.cwd() + '/dist-test/bridge/register-plugins.js');
  setPluginsForTest({
    preferences: prefs ?? makePrefsMock(),
    isNative,
    ...(haptics ? { haptics } : {}),
  });
}

function reset() {
  const { setPluginsForTest } = require(process.cwd() + '/dist-test/bridge/register-plugins.js');
  setPluginsForTest(null);
}

// ─── offline-cache ────────────────────────────────────────────────────────────

test('offline-cache: set/get 往返 + 命名空间前缀', SKIP, async () => {
  const { offlineCacheController } = require(process.cwd() + '/dist-test/plugins/offline-cache.js');
  const prefs = makePrefsMock();
  inject({ prefs });
  try {
    await offlineCacheController.set('workspace', { hello: 'world' });
    assert.deepStrictEqual(await offlineCacheController.get('workspace'), { hello: 'world' });
    // 落盘带 ah:cache: 前缀（与 webapp 侧键空间隔离）
    assert.ok(prefs._store.has('ah:cache:workspace'), '缓存键应带 ah:cache: 前缀');
    assert.strictEqual(await offlineCacheController.get('missing'), null);
  } finally {
    reset();
  }
});

test('offline-cache: TTL 过期 —— get 返回 null，getWithMeta 标记 stale', SKIP, async () => {
  const { offlineCacheController } = require(process.cwd() + '/dist-test/plugins/offline-cache.js');
  inject({});
  try {
    await offlineCacheController.set('k', { v: 1 }, 100); // 100ms TTL
    assert.deepStrictEqual(await offlineCacheController.getWithMeta('k'), { data: { v: 1 }, stale: false });
    // 时钟拨过 TTL
    const origNow = Date.now;
    Date.now = () => origNow() + 200;
    try {
      assert.strictEqual(await offlineCacheController.get('k'), null, '过期后 get 应返回 null');
      const meta = await offlineCacheController.getWithMeta('k');
      assert.strictEqual(meta.stale, true, 'getWithMeta 应标记 stale（UI 可显示「数据可能不是最新」）');
      assert.deepStrictEqual(meta.data, { v: 1 });
    } finally {
      Date.now = origNow;
    }
  } finally {
    reset();
  }
});

test('offline-cache: 损坏 JSON → null（不抛错）+ clear 清空', SKIP, async () => {
  const { offlineCacheController } = require(process.cwd() + '/dist-test/plugins/offline-cache.js');
  const prefs = makePrefsMock();
  inject({ prefs });
  try {
    prefs._store.set('ah:cache:broken', '{not json');
    assert.strictEqual(await offlineCacheController.get('broken'), null, '损坏条目应视作未命中');
    assert.strictEqual(await offlineCacheController.getWithMeta('broken'), null);
    await offlineCacheController.set('a', 1);
    await offlineCacheController.set('b', 2);
    await offlineCacheController.clear();
    assert.strictEqual(await offlineCacheController.get('a'), null);
    assert.strictEqual(await offlineCacheController.get('b'), null);
  } finally {
    reset();
  }
});

// ─── biometric-auth（AES-GCM token 信封）─────────────────────────────────────

test('biometric: saveToken/getToken 往返（AES-GCM 密文落盘）', SKIP, async () => {
  const { biometricAuthController } = require(process.cwd() + '/dist-test/plugins/biometric-auth.js');
  const prefs = makePrefsMock();
  inject({ prefs });
  try {
    const token = 'tok_' + 'x'.repeat(64);
    await biometricAuthController.saveToken(token);
    assert.strictEqual(await biometricAuthController.getToken(), token);
    // 落盘的是信封（iv:ct base64），绝不存明文
    const envelope = prefs._store.get('auth_token');
    assert.ok(envelope && !envelope.includes(token), '明文 token 不得落盘');
    assert.match(envelope, /^[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/, '信封应为 iv:ct base64 形态');
    // 每安装密钥：同一次会话内多次加解密复用同一密钥
    const key1 = prefs._store.get('auth_token_key');
    await biometricAuthController.saveToken('second');
    assert.strictEqual(prefs._store.get('auth_token_key'), key1, '密钥应跨调用稳定（每安装随机一次）');
    assert.strictEqual(await biometricAuthController.getToken(), 'second');
  } finally {
    reset();
  }
});

test('biometric: 信封损坏 / 被篡改 → getToken 返回 null（fail-safe）', SKIP, async () => {
  const { biometricAuthController } = require(process.cwd() + '/dist-test/plugins/biometric-auth.js');
  const prefs = makePrefsMock();
  inject({ prefs });
  try {
    // 无信封
    assert.strictEqual(await biometricAuthController.getToken(), null);
    // 无分隔符的信封
    prefs._store.set('auth_token', 'garbage');
    assert.strictEqual(await biometricAuthController.getToken(), null);
    // 密文被篡改（GCM 认证标签校验失败）
    await biometricAuthController.saveToken('secret');
    const env = prefs._store.get('auth_token');
    const [iv, ct] = env.split(':');
    const flipped = ct.slice(0, -4) + (ct.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    prefs._store.set('auth_token', `${iv}:${flipped}`);
    assert.strictEqual(await biometricAuthController.getToken(), null, '篡改的密文必须被拒绝');
  } finally {
    reset();
  }
});

test('biometric: clearToken 连密钥一并清除（换账号新密钥）', SKIP, async () => {
  const { biometricAuthController } = require(process.cwd() + '/dist-test/plugins/biometric-auth.js');
  const prefs = makePrefsMock();
  inject({ prefs });
  try {
    await biometricAuthController.saveToken('t1');
    assert.ok(prefs._store.has('auth_token') && prefs._store.has('auth_token_key'));
    await biometricAuthController.clearToken();
    assert.strictEqual(await biometricAuthController.getToken(), null);
    assert.ok(!prefs._store.has('auth_token'), 'token 应被清除');
    assert.ok(!prefs._store.has('auth_token_key'), '密钥应一并清除（避免旧密钥残留）');
    // 清除后重新 saveToken 生成全新密钥
    await biometricAuthController.saveToken('t2');
    assert.strictEqual(await biometricAuthController.getToken(), 't2');
  } finally {
    reset();
  }
});

test('biometric: 原生不可用时 isAvailable/authenticate fail-safe（catch 分支）', SKIP, async () => {
  const { biometricAuthController } = require(process.cwd() + '/dist-test/plugins/biometric-auth.js');
  inject({});
  try {
    // stub 的 checkBiometry/authenticate 恒抛错（模拟原生插件缺失/拒绝）
    assert.deepStrictEqual(await biometricAuthController.isAvailable(), { available: false });
    assert.strictEqual(await biometricAuthController.authenticate('验证身份以登录'), false);
  } finally {
    reset();
  }
});

// ─── 非 no-op 边界：isNative=false 时全部安全 no-op ──────────────────────────

test('非原生环境：push/deep-link 控制器安全 no-op', SKIP, async () => {
  const { pushNotificationController } = require(process.cwd() + '/dist-test/plugins/push-notification.js');
  const { deepLinkController } = require(process.cwd() + '/dist-test/plugins/deep-link.js');
  inject({ isNative: false });
  try {
    await assert.doesNotReject(() => pushNotificationController.register(), 'web 环境注册应静默跳过');
    assert.doesNotThrow(() => pushNotificationController.onNotification(() => {}));
    assert.strictEqual(await deepLinkController.getInitialUrl(), null, 'web 环境无初始 Deep Link');
  } finally {
    reset();
  }
});

// ─── haptics（触感反馈）──────────────────────────────────────────────────────

function makeHapticsMock() {
  const calls = [];
  return {
    calls,
    impact: async (o) => { calls.push(['impact', o]); },
    notification: async (o) => { calls.push(['notification', o]); },
    selectionStart: async () => { calls.push(['selectionStart']); },
    selectionChanged: async () => { calls.push(['selection']); },
    selectionEnd: async () => { calls.push(['selectionEnd']); },
    vibrate: async (o) => { calls.push(['vibrate', o]); },
  };
}

test('haptics: 原生环境 impact/notification/selection/vibrate 映射到插件调用', SKIP, async () => {
  const { hapticsController } = require(process.cwd() + '/dist-test/plugins/haptics.js');
  const haptics = makeHapticsMock();
  inject({ isNative: true, haptics });
  try {
    await hapticsController.impact('light');
    assert.deepStrictEqual(haptics.calls.pop(), ['impact', { style: 'LIGHT' }]);
    await hapticsController.impact();
    assert.deepStrictEqual(haptics.calls.pop(), ['impact', { style: 'MEDIUM' }], '默认 medium');
    await hapticsController.impact('heavy');
    assert.deepStrictEqual(haptics.calls.pop(), ['impact', { style: 'HEAVY' }]);
    await hapticsController.notification('success');
    assert.deepStrictEqual(haptics.calls.pop(), ['notification', { type: 'SUCCESS' }]);
    await hapticsController.notification('warning');
    assert.deepStrictEqual(haptics.calls.pop(), ['notification', { type: 'WARNING' }]);
    await hapticsController.notification('error');
    assert.deepStrictEqual(haptics.calls.pop(), ['notification', { type: 'ERROR' }]);
    await hapticsController.selection();
    assert.deepStrictEqual(haptics.calls.pop(), ['impact', { style: 'LIGHT' }], 'selection 走 impact(LIGHT)：Android selectionChanged 有 selectionStart 门禁，单飞会被静默丢弃');
    await hapticsController.vibrate(200);
    assert.deepStrictEqual(haptics.calls.pop(), ['vibrate', { duration: 200 }]);
  } finally {
    reset();
  }
});

test('haptics: 开关关闭后全部静默 no-op（ah:haptics:enabled 持久化）', SKIP, async () => {
  const { hapticsController } = require(process.cwd() + '/dist-test/plugins/haptics.js');
  const prefs = makePrefsMock();
  const haptics = makeHapticsMock();
  inject({ prefs, isNative: true, haptics });
  try {
    assert.strictEqual(await hapticsController.isEnabled(), true, '默认开启');
    await hapticsController.setEnabled(false);
    assert.strictEqual(prefs._store.get('ah:haptics:enabled'), 'false', '开关应持久化');
    assert.strictEqual(await hapticsController.isEnabled(), false);
    await hapticsController.impact('heavy');
    await hapticsController.notification('error');
    await hapticsController.selection();
    await hapticsController.vibrate(300);
    assert.strictEqual(haptics.calls.length, 0, '关闭后不得触发任何原生触感');
    await hapticsController.setEnabled(true);
    await hapticsController.impact();
    assert.strictEqual(haptics.calls.length, 1, '重新开启后恢复触发');
  } finally {
    reset();
  }
});

test('haptics: 原生调用抛错 fail-safe（插件缺失/被拒绝不阻断业务）', SKIP, async () => {
  const { hapticsController } = require(process.cwd() + '/dist-test/plugins/haptics.js');
  const broken = {
    impact: async () => { throw new Error('native only'); },
    notification: async () => { throw new Error('native only'); },
    selectionChanged: async () => { throw new Error('native only'); },
    vibrate: async () => { throw new Error('native only'); },
  };
  inject({ isNative: true, haptics: broken });
  try {
    await assert.doesNotReject(() => hapticsController.impact());
    await assert.doesNotReject(() => hapticsController.notification('success'));
    await assert.doesNotReject(() => hapticsController.selection());
    await assert.doesNotReject(() => hapticsController.vibrate());
  } finally {
    reset();
  }
});

test('haptics: 非原生环境安全 no-op（Node 无 Vibration API，isEnabled=false）', SKIP, async () => {
  const { hapticsController } = require(process.cwd() + '/dist-test/plugins/haptics.js');
  const haptics = makeHapticsMock();
  inject({ isNative: false, haptics });
  try {
    await assert.doesNotReject(() => hapticsController.impact('light'));
    await assert.doesNotReject(() => hapticsController.notification('error'));
    await assert.doesNotReject(() => hapticsController.selection());
    await assert.doesNotReject(() => hapticsController.vibrate());
    assert.strictEqual(haptics.calls.length, 0, '非原生不得调用原生桥');
    assert.strictEqual(await hapticsController.isEnabled(), false, '无 Vibration API 时视为关闭');
  } finally {
    reset();
  }
});

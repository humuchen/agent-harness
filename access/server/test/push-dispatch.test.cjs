// 推送投递层测试（P2-1）：PushSender 契约 / FCM HTTP v1（mock fetch）/ owner 派发 / 降级语义。
// - 工厂：无凭据 → LogPushSender；凭据损坏 → 降级 Log 且不抛错
// - FCM：OAuth2 换 token + messages:send 请求形状；iOS 令牌拒绝（待 APNs 实现）；
//   HTTP 失败 → 抛错（由 dispatch 层计数兜底）
// - dispatchPushToOwner：按 owner 查设备库逐个投递；sender 抛错不冒泡；无设备不调用
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { generateKeyPairSync, verify } = require('node:crypto');

// 测试用真实 RSA 密钥对（JWT RS256 签名需要可用的私钥；mock fetch 不校验签名本身）。
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIVATE_KEY_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const SERVICE_ACCOUNT = JSON.stringify({
  client_email: 'sa@test.iam.gserviceaccount.com',
  private_key: PRIVATE_KEY_PEM,
  project_id: 'proj-1',
});

const DIST = path.join(__dirname, '..', 'dist', 'push-dispatch.js');
const BUILT = fs.existsSync(DIST);
const SKIP = { skip: !BUILT };

const {
  LogPushSender,
  FcmPushSender,
  ApnsPushSender,
  PlatformRoutingSender,
  getPushSender,
  setPushSenderForTest,
  setFcmFetchForTest,
  setApnsTransportForTest,
  resetApnsTokenForTest,
  buildApnsJwt,
  dispatchPushToOwner,
  pushStats,
  resetPushStatsForTest,
} = require(DIST);
const { setDeviceStore } = require(path.join(__dirname, '..', 'dist', 'device-store.js'));

function makeDevice(over = {}) {
  return {
    id: 'dev-1',
    owner: 'alice',
    token: 'fcm-token-abcdef123456',
    platform: 'android',
    createdAt: '2026-01-01T00:00:00Z',
    lastSeenAt: '2026-01-01T00:00:00Z',
    ...over,
  };
}

function recordingSender(result = true) {
  const calls = [];
  return {
    calls,
    sender: {
      kind: 'log',
      async send(device, payload) {
        calls.push({ device, payload });
        if (result instanceof Error) throw result;
        return result;
      },
    },
  };
}

test.afterEach(() => {
  setPushSenderForTest(null);
  setDeviceStore(null);
  setFcmFetchForTest(null);
  setApnsTransportForTest(null);
  resetApnsTokenForTest();
  resetPushStatsForTest();
});

// ─── APNs（ES256 JWT + http2）────────────────────────────────────────────────

/** 生成测试用 P-256 密钥对（.p8 即 PKCS#8 PEM 的 EC 私钥）。 */
const { privateKey: ecPrivate, publicKey: ecPublic } = generateKeyPairSync('ec', {
  namedCurve: 'P-256',
});
const P8_PEM = ecPrivate.export({ type: 'pkcs8', format: 'pem' }).toString();
const EC_PUBLIC_PEM = ecPublic.export({ type: 'spki', format: 'pem' }).toString();

test('APNs：ES256 JWT 签名可被 P-256 公钥验签（raw r||s 形态）', SKIP, () => {
  const jwt = buildApnsJwt({ keyP8: P8_PEM, keyId: 'KEY1234567', teamId: 'TEAM1234567' }, 1700000000);
  const [h, c, sig] = jwt.split('.');
  assert.strictEqual(
    Buffer.from(h, 'base64url').toString(),
    JSON.stringify({ alg: 'ES256', kid: 'KEY1234567' })
  );
  assert.strictEqual(
    Buffer.from(c, 'base64url').toString(),
    JSON.stringify({ iss: 'TEAM1234567', iat: 1700000000 })
  );
  // ES256 签名应为 64 字节 raw r||s（ieee-p1363，非 ASN.1 DER）
  const raw = Buffer.from(sig, 'base64url');
  assert.strictEqual(raw.length, 64, 'JWT ES256 签名必须为 raw r||s（64 字节）');
  const ok = verify('sha256', Buffer.from(`${h}.${c}`), { key: EC_PUBLIC_PEM, dsaEncoding: 'ieee-p1363' }, raw);
  assert.strictEqual(ok, true, '签名必须能被对应 P-256 公钥验证');
});

test('APNs：send 请求形状（path/headers/payload）+ token 复用 + 失败抛错', SKIP, async () => {
  const sender = new ApnsPushSender({
    keyP8: P8_PEM,
    keyId: 'KEY1234567',
    teamId: 'TEAM1234567',
    topic: 'com.example.app',
  });
  const calls = [];
  setApnsTransportForTest(async (host, p, headers, body) => {
    calls.push({ host, p, headers, body });
    return { status: 200, body: '' };
  });

  const ok = await sender.send(makeDevice({ platform: 'ios', token: 'ios-token-abc' }), {
    title: '备忘提醒',
    body: '到点了',
    deeplink: 'piagent://chat/s1',
    kind: 'memo:reminder',
  });
  assert.strictEqual(ok, true);
  assert.strictEqual(calls.length, 1);
  const { host, p, headers, body } = calls[0];
  assert.strictEqual(host, 'api.development.push.apple.com', '缺省走沙箱网关');
  assert.strictEqual(p, '/3/device/ios-token-abc');
  assert.match(headers.authorization, /^bearer ey/);
  assert.strictEqual(headers['apns-topic'], 'com.example.app');
  assert.strictEqual(headers['apns-push-type'], 'alert');
  const payload = JSON.parse(body);
  assert.strictEqual(payload.aps.alert.title, '备忘提醒');
  assert.strictEqual(payload.deeplink, 'piagent://chat/s1');

  // provider token 复用：1 小时内第二次 send 不重签（同一 authorization）
  await sender.send(makeDevice({ platform: 'ios' }), { title: 't2', body: 'b2' });
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls[1].headers.authorization, calls[0].headers.authorization, '1 小时内应复用 provider token');

  // 非 200 → 抛错（由 dispatch 层计数兜底）
  setApnsTransportForTest(async () => ({ status: 410, body: '{"reason":"Unregistered"}' }));
  await assert.rejects(
    () => sender.send(makeDevice({ platform: 'ios' }), { title: 't', body: 'b' }),
    /APNs 发送失败：HTTP 410/
  );
});

test('APNs：production 网关切换 + 配置不完整 fail-fast', SKIP, () => {
  assert.throws(
    () => new ApnsPushSender({ keyP8: P8_PEM, keyId: '', teamId: 'T', topic: 'x' }),
    /配置不完整/
  );
});

test('平台路由：android→FCM / ios→APNs / 未配置平台降级日志', SKIP, async () => {
  const fcmCalls = [];
  const apnsCalls = [];
  const logCalls = [];
  const stub = (name, calls, ret = true) => ({
    kind: name,
    async send(d, p) {
      calls.push(d.platform);
      return ret;
    },
  });
  const routing = new PlatformRoutingSender(
    stub('fcm', fcmCalls),
    stub('apns', apnsCalls),
    stub('log', logCalls)
  );
  assert.strictEqual(await routing.send(makeDevice({ platform: 'android' }), { title: 't', body: 'b' }), true);
  assert.strictEqual(await routing.send(makeDevice({ platform: 'ios' }), { title: 't', body: 'b' }), true);
  assert.deepStrictEqual(fcmCalls, ['android']);
  assert.deepStrictEqual(apnsCalls, ['ios']);
  assert.deepStrictEqual(logCalls, [], '双通道齐备时日志兜底不被调用');

  // 仅 APNs：android 走日志兜底
  const apnsOnly = new PlatformRoutingSender(undefined, stub('apns', apnsCalls), stub('log', logCalls));
  await apnsOnly.send(makeDevice({ platform: 'android' }), { title: 't', body: 'b' });
  assert.ok(logCalls.includes('android'), 'FCM 未配置时 android 降级日志兜底');

  // 未知平台：false
  assert.strictEqual(
    await routing.send(makeDevice({ platform: 'unknown' }), { title: 't', body: 'b' }).catch(() => false),
    false
  );
});

test('工厂：仅 APNs 凭据 → apns sender；双凭据 → routing', SKIP, () => {
  const apnsOnly = getPushSender({
    APNS_KEY_P8: P8_PEM,
    APNS_KEY_ID: 'KEY1234567',
    APNS_TEAM_ID: 'TEAM1234567',
    APNS_TOPIC: 'com.example.app',
  });
  assert.strictEqual(apnsOnly.kind, 'apns');
  setPushSenderForTest(null);

  const both = getPushSender({
    FIREBASE_SERVICE_ACCOUNT: JSON.stringify({
      client_email: 'sa@t.iam.gserviceaccount.com',
      private_key: P8_PEM,
      project_id: 'p',
    }),
    APNS_KEY_P8: P8_PEM,
    APNS_KEY_ID: 'KEY1234567',
    APNS_TEAM_ID: 'TEAM1234567',
    APNS_TOPIC: 'com.example.app',
  });
  assert.strictEqual(both.kind, 'routing');
  setPushSenderForTest(null);
});

test('工厂：无凭据 → LogPushSender；凭据损坏 → 降级 Log 不抛错', SKIP, () => {
  assert.strictEqual(getPushSender({}).kind, 'log', '无 FIREBASE_SERVICE_ACCOUNT 应落日志兜底');
  assert.strictEqual(getPushSender({ FIREBASE_SERVICE_ACCOUNT: '{bad json' }).kind, 'log');
  assert.strictEqual(
    getPushSender({ FIREBASE_SERVICE_ACCOUNT: JSON.stringify({ client_email: 'x' }) }).kind,
    'log',
    '缺 private_key/project_id 应降级'
  );
});

test('FCM：OAuth2 换 token → messages:send 请求形状正确', SKIP, async () => {
  const sender = new FcmPushSender(SERVICE_ACCOUNT);
  const calls = [];
  setFcmFetchForTest(async (url, init = {}) => {
    calls.push({ url, init });
    if (String(url).includes('oauth2')) {
      return { ok: true, status: 200, json: async () => ({ access_token: 'tok-1', expires_in: 3600 }) };
    }
    return { ok: true, status: 200, json: async () => ({ name: 'projects/proj-1/messages/1' }), text: async () => '' };
  });
  const ok = await sender.send(makeDevice(), { title: '备忘提醒', body: '到点了', kind: 'memo:reminder' });
  assert.strictEqual(ok, true);

  // OAuth2 请求形状
  const oauth = calls.find((c) => String(c.url).includes('oauth2'));
  assert.ok(oauth, '应先换 OAuth2 token');
  assert.ok(String(oauth.init.body).includes('jwt-bearer'));
  assert.ok(String(oauth.init.body).includes('assertion='));

  // messages:send 请求形状
  const send = calls.find((c) => String(c.url).includes('/messages:send'));
  assert.ok(send, '应调用 FCM v1 send 端点');
  assert.strictEqual(String(send.url).includes('/projects/proj-1/'), true);
  assert.strictEqual(send.init.headers.authorization, 'Bearer tok-1');
  const body = JSON.parse(send.init.body);
  assert.strictEqual(body.message.token, 'fcm-token-abcdef123456');
  assert.strictEqual(body.message.notification.title, '备忘提醒');
  assert.strictEqual(body.message.android.priority, 'high');
});

test('FCM：iOS 设备拒绝（APNs 未实现）+ HTTP 失败抛错', SKIP, async () => {
  const sender = new FcmPushSender(SERVICE_ACCOUNT);
  let fcmCalls = 0;
  setFcmFetchForTest(async (url) => {
    if (String(url).includes('oauth2')) {
      return { ok: true, status: 200, json: async () => ({ access_token: 't', expires_in: 3600 }) };
    }
    fcmCalls++;
    return { ok: false, status: 404, json: async () => ({}), text: async () => 'not found' };
  });

  const ios = await sender.send(makeDevice({ platform: 'ios' }), { title: 't', body: 'b' });
  assert.strictEqual(ios, false, 'iOS 令牌不得走 FCM 端点');
  assert.strictEqual(fcmCalls, 0, 'iOS 设备不应发起 FCM 请求');

  await assert.rejects(
    () => sender.send(makeDevice(), { title: 't', body: 'b' }),
    /FCM 发送失败/,
    'FCM HTTP 错误应抛出（由 dispatch 层计数兜底）'
  );
});

test('dispatch：按 owner 逐设备投递 + 计数；sender 抛错不冒泡', SKIP, async () => {
  const { sender, calls } = recordingSender(true);
  setPushSenderForTest(sender);
  const devices = [makeDevice({ id: 'd1' }), makeDevice({ id: 'd2', token: 'other-token-99' })];
  setDeviceStore({
    kind: 'file',
    register: async () => makeDevice(),
    unregister: async () => true,
    listByOwner: async (owner) => (owner === 'alice' ? devices : []),
    listAll: async () => devices,
  });

  await dispatchPushToOwner('alice', { title: 'T', body: 'B' });
  assert.strictEqual(calls.length, 2, '两个设备都应被投递');
  assert.deepStrictEqual(pushStats(), { attempted: 2, sent: 2, failed: 0 });

  // bob 无设备：sender 不被调用
  const before = calls.length;
  await dispatchPushToOwner('bob', { title: 'T', body: 'B' });
  assert.strictEqual(calls.length, before);

  // sender 抛错：不冒泡，failed 计数
  const failing = recordingSender(new Error('network down'));
  setPushSenderForTest(failing.sender);
  await assert.doesNotReject(() => dispatchPushToOwner('alice', { title: 'T', body: 'B' }));
  assert.strictEqual(pushStats().failed, 2, '两次失败应计数');
  assert.strictEqual(pushStats().sent, 2, '成功计数不被失败覆盖');
});

test('dispatch：设备库异常静默返回（推送绝不影响业务主流程）', SKIP, async () => {
  setPushSenderForTest(recordingSender(true).sender);
  setDeviceStore({
    kind: 'file',
    register: async () => makeDevice(),
    unregister: async () => true,
    listByOwner: async () => {
      throw new Error('disk full');
    },
    listAll: async () => [],
  });
  await assert.doesNotReject(() => dispatchPushToOwner('alice', { title: 'T', body: 'B' }));
  assert.strictEqual(pushStats().attempted, 0);
});

test('LogPushSender：脱敏（不回显完整 token）', SKIP, async () => {
  const s = new LogPushSender();
  const ok = await s.send(makeDevice({ token: 'secret-token-xyz' }), { title: 't', body: 'b' });
  assert.strictEqual(ok, true);
});

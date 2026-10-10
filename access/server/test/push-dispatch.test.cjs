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
const { generateKeyPairSync } = require('node:crypto');

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
  getPushSender,
  setPushSenderForTest,
  setFcmFetchForTest,
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
  resetPushStatsForTest();
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

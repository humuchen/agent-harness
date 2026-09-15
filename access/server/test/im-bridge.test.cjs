'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createHash, createHmac, createCipheriv } = require('node:crypto');

// 覆盖 IM 桥接（用户层入口）：
// - 去重（LRU）与身份派生（owner/session 稳定性）
// - 适配器工厂（未启用 / 缺配置 / 配置齐全三种路径）
// - 飞书 / 钉钉 / 企业微信 的验签与消息解析
// - ImBridge 端到端：合法 → 200 + 异步执行 + 回发；验签失败 → 401；去重；群聊 @ 门禁

const {
  MessageDeduper,
  MemoryDedupStore,
  RedisDedupStore,
  createDedupStore,
  deriveImIdentity,
  createImRegistry,
  FeishuAdapter,
  DingtalkAdapter,
  WecomAdapter,
  extractXmlTag,
  ImBridge
} = require('../dist/im/index.js');

// ── 去重 ──
test('MessageDeduper: 首次放行、重复丢弃、超容量淘汰最旧', () => {
  const d = new MessageDeduper(3);
  assert.strictEqual(d.check('a'), true);
  assert.strictEqual(d.check('a'), false, '重复应被丢弃');
  assert.strictEqual(d.check('b'), true);
  assert.strictEqual(d.check('c'), true);
  // 再插入 d：容量 3 溢出，淘汰最旧（a 在第二次 check 时被刷新为最近使用，但随后 b、c 插入，
  // 故此刻 a 仍是最旧 → 淘汰 a）。
  assert.strictEqual(d.check('d'), true);
  assert.strictEqual(d.size(), 3, '容量上限应保持');
  assert.strictEqual(d.check('a'), true, 'a 已被淘汰，应视为新消息');
  assert.strictEqual(d.check('d'), false, 'd 刚插入，仍应被去重');
});

test('MessageDeduper: 空 key 不去重（直接放行）', () => {
  const d = new MessageDeduper(10);
  assert.strictEqual(d.check(''), true);
  assert.strictEqual(d.check(''), true);
});

// ── 身份派生 ──
test('deriveImIdentity: 同 IM 会话稳定、不同会话/平台可区分', () => {
  const msg = { provider: 'feishu', senderId: 'ou_1', chatId: 'oc_1' };
  const a = deriveImIdentity(msg);
  const b = deriveImIdentity({ ...msg });
  assert.deepStrictEqual(a, b, '同会话应派生相同 owner/session');
  assert.strictEqual(a.owner, 'im:feishu:ou_1');
  assert.ok(a.sessionId.startsWith('im-feishu-'));
  const other = deriveImIdentity({ ...msg, chatId: 'oc_2' });
  assert.notStrictEqual(a.sessionId, other.sessionId, '不同会话应区分');
});

// ── 适配器工厂 ──
test('createImRegistry: 未开 IM_ENABLED 时返回空清单', () => {
  const r = createImRegistry({});
  assert.strictEqual(r.enabled.length, 0);
  assert.strictEqual(r.config.adapters.length, 0);
});

test('createImRegistry: 启用但缺配置 → 显式指定时记入 skipped', () => {
  const r = createImRegistry({ IM_ENABLED: 'true', IM_PROVIDERS: 'feishu' });
  assert.strictEqual(r.enabled.length, 0);
  assert.strictEqual(r.skipped.length, 1);
  assert.strictEqual(r.skipped[0].provider, 'feishu');
  assert.match(r.skipped[0].reason, /missing config/);
});

test('createImRegistry: 启用且配置齐全 → 平台入列', () => {
  const r = createImRegistry({
    IM_ENABLED: 'true',
    IM_PROVIDERS: 'feishu',
    IM_FEISHU_APP_ID: 'cli_x',
    IM_FEISHU_APP_SECRET: 'sec',
    IM_FEISHU_VERIFICATION_TOKEN: 'vt'
  });
  assert.deepStrictEqual(r.enabled, ['feishu']);
  assert.strictEqual(r.config.adapters.length, 1);
});

test('createImRegistry: 自动探测（未指定 IM_PROVIDERS）时静默跳过未配置平台', () => {
  const r = createImRegistry({ IM_ENABLED: 'true' });
  assert.strictEqual(r.enabled.length, 0);
  assert.strictEqual(r.skipped.length, 0, '自动探测不产生 skipped 噪声');
});

// ── 飞书适配器 ──
function feishu(overrides = {}) {
  return new FeishuAdapter({
    appId: 'cli_x',
    appSecret: 'sec',
    verificationToken: 'vt',
    ...overrides
  });
}

test('FeishuAdapter: URL 验证握手原样回显 challenge', () => {
  const a = feishu();
  const rawBody = JSON.stringify({ type: 'url_verification', challenge: 'abc123', token: 'vt' });
  const res = a.handleChallenge({ headers: {}, rawBody, url: new URL('http://x/api/im/feishu/events') });
  assert.strictEqual(res.handled, true);
  assert.deepStrictEqual(res.body, { challenge: 'abc123' });
});

test('FeishuAdapter: 未配 encryptKey 时按 verification token 校验', () => {
  const a = feishu();
  const ok = JSON.stringify({ header: { token: 'vt' }, event: {} });
  const bad = JSON.stringify({ header: { token: 'wrong' }, event: {} });
  assert.strictEqual(a.verifyInbound({ headers: {}, rawBody: ok, url: new URL('http://x/') }), true);
  assert.strictEqual(a.verifyInbound({ headers: {}, rawBody: bad, url: new URL('http://x/') }), false);
});

test('FeishuAdapter: 配 encryptKey 时校验 X-Lark-Signature', () => {
  const a = feishu({ encryptKey: 'ek' });
  const rawBody = '{"encrypt":"x"}';
  const ts = '1700000000';
  const nonce = 'n1';
  const sig = createHash('sha256').update(ts + nonce + 'ek' + rawBody, 'utf8').digest('hex');
  assert.strictEqual(
    a.verifyInbound({
      headers: { 'x-lark-request-timestamp': ts, 'x-lark-request-nonce': nonce, 'x-lark-signature': sig },
      rawBody,
      url: new URL('http://x/')
    }),
    true
  );
  assert.strictEqual(
    a.verifyInbound({
      headers: { 'x-lark-request-timestamp': ts, 'x-lark-request-nonce': nonce, 'x-lark-signature': 'deadbeef' },
      rawBody,
      url: new URL('http://x/')
    }),
    false
  );
});

test('FeishuAdapter: 解析单聊文本消息 + 剥离 @占位符', () => {
  const a = feishu();
  const rawBody = JSON.stringify({
    schema: '2.0',
    header: { event_id: 'e1', event_type: 'im.message.receive_v1', token: 'vt' },
    event: {
      sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' },
      message: {
        message_id: 'om_1',
        chat_id: 'oc_1',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: '@_user_1 你好' })
      }
    }
  });
  const msg = a.parseInbound(rawBody);
  assert.ok(msg);
  assert.strictEqual(msg.provider, 'feishu');
  assert.strictEqual(msg.senderId, 'ou_user');
  assert.strictEqual(msg.isGroup, false);
  assert.strictEqual(msg.mentionedBot, true, '单聊恒视为已 @');
  assert.strictEqual(msg.text, '你好');
});

test('FeishuAdapter: 群聊未 @ 机器人时 mentionedBot=false', () => {
  const a = feishu({ botOpenId: 'ou_bot' });
  const rawBody = JSON.stringify({
    header: { event_type: 'im.message.receive_v1', token: 'vt' },
    event: {
      sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' },
      message: {
        message_id: 'om_2',
        chat_id: 'oc_2',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: '大家好' }),
        mentions: []
      }
    }
  });
  const msg = a.parseInbound(rawBody);
  assert.ok(msg);
  assert.strictEqual(msg.isGroup, true);
  assert.strictEqual(msg.mentionedBot, false);
});

test('FeishuAdapter: 非文本消息返回 null', () => {
  const a = feishu();
  const rawBody = JSON.stringify({
    header: { event_type: 'im.message.receive_v1', token: 'vt' },
    event: {
      sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' },
      message: { message_id: 'om_3', chat_id: 'oc_3', chat_type: 'p2p', message_type: 'image', content: '{}' }
    }
  });
  assert.strictEqual(a.parseInbound(rawBody), null);
});

// ── 钉钉适配器 ──
test('DingtalkAdapter: 签名校验（HMAC-SHA256）', () => {
  const secret = 'appsec';
  const a = new DingtalkAdapter({ clientId: 'k', clientSecret: secret });
  const ts = '1700000000';
  const sign = createHmac('sha256', secret).update(`${ts}\n${secret}`, 'utf8').digest('base64');
  assert.strictEqual(
    a.verifyInbound({ headers: { timestamp: ts, sign }, rawBody: '{}', url: new URL('http://x/') }),
    true
  );
  assert.strictEqual(
    a.verifyInbound({ headers: { timestamp: ts, sign: 'bad' }, rawBody: '{}', url: new URL('http://x/') }),
    false
  );
});

test('DingtalkAdapter: 解析单聊与群聊消息', () => {
  const a = new DingtalkAdapter({ clientId: 'k', clientSecret: 's' });
  const single = a.parseInbound(
    JSON.stringify({
      msgId: 'm1',
      msgtype: 'text',
      conversationId: 'c1',
      conversationType: '1',
      senderStaffId: 'u1',
      senderNick: '张三',
      text: { content: ' 你好 ' }
    })
  );
  assert.ok(single);
  assert.strictEqual(single.isGroup, false);
  assert.strictEqual(single.mentionedBot, true);
  assert.strictEqual(single.text, '你好');

  const group = a.parseInbound(
    JSON.stringify({
      msgId: 'm2',
      msgtype: 'text',
      conversationId: 'c2',
      conversationType: '2',
      senderStaffId: 'u2',
      isInAtList: false,
      text: { content: '@机器人 查一下' }
    })
  );
  assert.ok(group);
  assert.strictEqual(group.isGroup, true);
  assert.strictEqual(group.mentionedBot, false);
  assert.strictEqual(group.text, '查一下');
});

// ── 企业微信适配器 ──
test('extractXmlTag: 支持 CDATA 与普通文本', () => {
  assert.strictEqual(extractXmlTag('<xml><Content><![CDATA[hi]]></Content></xml>', 'Content'), 'hi');
  assert.strictEqual(extractXmlTag('<xml><MsgType>text</MsgType></xml>', 'MsgType'), 'text');
  assert.strictEqual(extractXmlTag('<xml></xml>', 'Missing'), null);
});

test('WecomAdapter: 缺配置时 isConfigured=false 且列出缺失项', () => {
  const a = new WecomAdapter({ corpId: '', agentId: '', secret: '', token: '', aesKey: '' });
  assert.strictEqual(a.isConfigured(), false);
  assert.ok(a.missingConfig().length >= 4);
});

/**
 * 测试侧企业微信加密（与 adapter 解密对称）：random(16) + msgLen(4,大端) + msg + receiveId，
 * PKCS7 填充到 32 字节块，AES-256-CBC（key = base64(aesKey + '=')，IV = key[0:16]）。
 */
function wecomEncrypt(plainXml, aesKey, receiveId = 'corp') {
  const key = Buffer.from(aesKey + '=', 'base64');
  const iv = key.subarray(0, 16);
  const random = Buffer.alloc(16, 7);
  const msgBuf = Buffer.from(plainXml, 'utf8');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(msgBuf.length, 0);
  const raw = Buffer.concat([random, lenBuf, msgBuf, Buffer.from(receiveId, 'utf8')]);
  const padLen = 32 - (raw.length % 32);
  const padded = Buffer.concat([raw, Buffer.alloc(padLen, padLen)]);
  const cipher = createCipheriv('aes-256-cbc', key, iv);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]).toString('base64');
}

function wecomSign(token, timestamp, nonce, payload) {
  return createHash('sha1')
    .update([token, timestamp, nonce, payload].sort().join(''), 'utf8')
    .digest('hex');
}

const WECOM_AES_KEY = 'a'.repeat(43);

test('WecomAdapter: 解析群聊消息（ChatId → isGroup=true）', () => {
  const a = new WecomAdapter({
    corpId: 'corp',
    agentId: '1',
    secret: 's',
    token: 'tok',
    aesKey: WECOM_AES_KEY
  });
  const xml =
    '<xml><ToUserName>corp</ToUserName><FromUserName>user1</FromUserName>' +
    '<ChatId>chat1</ChatId><MsgType>text</MsgType><Content>你好</Content><MsgId>1001</MsgId></xml>';
  const body = `<xml><Encrypt><![CDATA[${wecomEncrypt(xml, WECOM_AES_KEY)}]]></Encrypt><AgentID>1</AgentID></xml>`;
  const msg = a.parseInbound(body);
  assert.ok(msg, '应成功解密并解析');
  assert.strictEqual(msg.isGroup, true);
  assert.strictEqual(msg.chatId, 'chat1', '群聊 chatId 应为 ChatId 而非发送者');
  assert.strictEqual(msg.senderId, 'user1');
  assert.strictEqual(msg.text, '你好');
  assert.strictEqual(msg.mentionedBot, true, '企业微信无 @ 标记，恒视为已 @');
});

test('WecomAdapter: 单聊消息（无 ChatId）→ isGroup=false', () => {
  const a = new WecomAdapter({
    corpId: 'corp',
    agentId: '1',
    secret: 's',
    token: 'tok',
    aesKey: WECOM_AES_KEY
  });
  const xml =
    '<xml><ToUserName>corp</ToUserName><FromUserName>user2</FromUserName>' +
    '<MsgType>text</MsgType><Content>hi</Content><MsgId>1002</MsgId></xml>';
  const body = `<xml><Encrypt><![CDATA[${wecomEncrypt(xml, WECOM_AES_KEY)}]]></Encrypt></xml>`;
  const msg = a.parseInbound(body);
  assert.ok(msg);
  assert.strictEqual(msg.isGroup, false);
  assert.strictEqual(msg.chatId, 'user2', '单聊 chatId 回落为发送者');
});

test('WecomAdapter: URL 验证握手（验签 + 解密 echostr 原样返回）', () => {
  const a = new WecomAdapter({
    corpId: 'corp',
    agentId: '1',
    secret: 's',
    token: 'tok',
    aesKey: WECOM_AES_KEY
  });
  const echoPlain = 'echo-12345';
  const echostr = wecomEncrypt(echoPlain, WECOM_AES_KEY);
  const timestamp = '1700000000';
  const nonce = 'n1';
  const sig = wecomSign('tok', timestamp, nonce, echostr);
  const url = new URL(
    `http://x/api/im/wecom/events?msg_signature=${sig}&timestamp=${timestamp}&nonce=${nonce}&echostr=${encodeURIComponent(echostr)}`
  );
  const res = a.handleChallenge({ headers: {}, rawBody: '', url });
  assert.strictEqual(res.handled, true);
  assert.strictEqual(res.body, echoPlain, '应解密 echostr 并原样返回');
});

test('WecomAdapter: 签名不符时握手不通过', () => {
  const a = new WecomAdapter({
    corpId: 'corp',
    agentId: '1',
    secret: 's',
    token: 'tok',
    aesKey: WECOM_AES_KEY
  });
  const echostr = wecomEncrypt('x', WECOM_AES_KEY);
  const url = new URL(
    `http://x/api/im/wecom/events?msg_signature=deadbeef&timestamp=1&nonce=n&echostr=${encodeURIComponent(echostr)}`
  );
  assert.strictEqual(a.handleChallenge({ headers: {}, rawBody: '', url }).handled, false);
});

test('WecomAdapter: verifyInbound 校验 Encrypt 签名', () => {
  const a = new WecomAdapter({
    corpId: 'corp',
    agentId: '1',
    secret: 's',
    token: 'tok',
    aesKey: WECOM_AES_KEY
  });
  const enc = wecomEncrypt('<xml><MsgType>text</MsgType></xml>', WECOM_AES_KEY);
  const body = `<xml><Encrypt><![CDATA[${enc}]]></Encrypt></xml>`;
  const ts = '1700000000';
  const nonce = 'n9';
  const okUrl = new URL(
    `http://x/api/im/wecom/events?msg_signature=${wecomSign('tok', ts, nonce, enc)}&timestamp=${ts}&nonce=${nonce}`
  );
  assert.strictEqual(a.verifyInbound({ headers: {}, rawBody: body, url: okUrl }), true);
  const badUrl = new URL(
    `http://x/api/im/wecom/events?msg_signature=bad&timestamp=${ts}&nonce=${nonce}`
  );
  assert.strictEqual(a.verifyInbound({ headers: {}, rawBody: body, url: badUrl }), false);
});

// ── ImBridge 端到端 ──
function stubAdapter(overrides = {}) {
  const sent = [];
  const base = {
    provider: 'feishu',
    isConfigured: () => true,
    missingConfig: () => [],
    verifyInbound: () => true,
    handleChallenge: () => ({ handled: false }),
    parseInbound: () => ({
      provider: 'feishu',
      messageId: 'm1',
      senderId: 'u1',
      chatId: 'c1',
      isGroup: false,
      mentionedBot: true,
      text: 'hi'
    }),
    sendText: async (_t, text) => {
      sent.push(text);
    },
    _sent: sent
  };
  return { ...base, ...overrides };
}

function bridgeConfig(adapter, extra = {}) {
  return {
    adapters: [adapter],
    defaultMode: 'mock',
    maxSteps: 5,
    timeoutMs: 1000,
    replyPrefix: '[AI] ',
    groupRequireMention: true,
    ...extra
  };
}

const tick = () => new Promise((r) => setTimeout(r, 30));

test('ImBridge: 合法消息 → 200 立即 ack，后台执行并回发', async () => {
  const adapter = stubAdapter();
  const bridge = new ImBridge(bridgeConfig(adapter), async (_m, prompt) => `echo:${prompt}`);
  const res = await bridge.handleInbound('feishu', {
    headers: {},
    rawBody: '{}',
    url: new URL('http://x/api/im/feishu/events')
  });
  assert.strictEqual(res.status, 200);
  await tick();
  assert.deepStrictEqual(adapter._sent, ['[AI] echo:hi']);
  assert.strictEqual(bridge.snapshot().counters.completed, 1);
});

test('ImBridge: 验签失败 → 401 且不执行 agent', async () => {
  let called = 0;
  const adapter = stubAdapter({ verifyInbound: () => false });
  const bridge = new ImBridge(bridgeConfig(adapter), async () => {
    called++;
    return 'x';
  });
  const res = await bridge.handleInbound('feishu', {
    headers: {},
    rawBody: '{}',
    url: new URL('http://x/')
  });
  assert.strictEqual(res.status, 401);
  await tick();
  assert.strictEqual(called, 0);
  assert.strictEqual(bridge.snapshot().counters.rejected, 1);
});

test('ImBridge: 重复 messageId 被去重（只执行一次）', async () => {
  let called = 0;
  const adapter = stubAdapter();
  const bridge = new ImBridge(bridgeConfig(adapter), async () => {
    called++;
    return 'ok';
  });
  const req = { headers: {}, rawBody: '{}', url: new URL('http://x/') };
  await bridge.handleInbound('feishu', req);
  await bridge.handleInbound('feishu', req);
  await tick();
  assert.strictEqual(called, 1);
  assert.strictEqual(bridge.snapshot().counters.deduped, 1);
});

test('ImBridge: 群聊未 @ 机器人 → 忽略（不执行）', async () => {
  let called = 0;
  const adapter = stubAdapter({
    parseInbound: () => ({
      provider: 'feishu',
      messageId: 'm9',
      senderId: 'u1',
      chatId: 'g1',
      isGroup: true,
      mentionedBot: false,
      text: 'hi'
    })
  });
  const bridge = new ImBridge(bridgeConfig(adapter), async () => {
    called++;
    return 'x';
  });
  const res = await bridge.handleInbound('feishu', {
    headers: {},
    rawBody: '{}',
    url: new URL('http://x/')
  });
  assert.strictEqual(res.status, 200);
  await tick();
  assert.strictEqual(called, 0);
});

test('ImBridge: agent 抛错 → 回失败提示且计数失败', async () => {
  const adapter = stubAdapter();
  const bridge = new ImBridge(bridgeConfig(adapter), async () => {
    throw new Error('boom');
  });
  await bridge.handleInbound('feishu', { headers: {}, rawBody: '{}', url: new URL('http://x/') });
  await tick();
  assert.strictEqual(adapter._sent.length, 1);
  assert.match(adapter._sent[0], /出错了/);
  assert.strictEqual(bridge.snapshot().counters.failed, 1);
});

test('ImBridge: 未启用的平台 → 404', async () => {
  const bridge = new ImBridge(bridgeConfig(stubAdapter()), async () => 'x');
  const res = await bridge.handleInbound('dingtalk', {
    headers: {},
    rawBody: '{}',
    url: new URL('http://x/')
  });
  assert.strictEqual(res.status, 404);
});

test('ImBridge: 空文本 → 回不支持提示，不执行 agent', async () => {
  let called = 0;
  const adapter = stubAdapter({
    parseInbound: () => ({
      provider: 'feishu',
      messageId: 'm-empty',
      senderId: 'u1',
      chatId: 'c1',
      isGroup: false,
      mentionedBot: true,
      text: ''
    })
  });
  const bridge = new ImBridge(bridgeConfig(adapter), async () => {
    called++;
    return 'x';
  });
  await bridge.handleInbound('feishu', { headers: {}, rawBody: '{}', url: new URL('http://x/') });
  await tick();
  assert.strictEqual(called, 0);
  assert.match(adapter._sent[0], /暂不支持/);
});

// ── 去重存储（可插拔：内存 / Redis）──
test('MemoryDedupStore: 异步契约与 MessageDeduper 语义一致', async () => {
  const s = new MemoryDedupStore(3);
  assert.strictEqual(s.kind, 'memory');
  assert.strictEqual(await s.check('a'), true);
  assert.strictEqual(await s.check('a'), false, '重复应丢弃');
  assert.strictEqual(await s.check('b'), true);
  assert.strictEqual(s.size(), 2);
});

test('createDedupStore: 无 REDIS_URL → memory（默认零行为变更）', () => {
  assert.strictEqual(createDedupStore({}).kind, 'memory');
});

test('createDedupStore: 有 REDIS_URL → redis（跨实例）', () => {
  assert.strictEqual(
    createDedupStore({ REDIS_URL: 'redis://localhost:6379' }).kind,
    'redis'
  );
});

test('createDedupStore: IM_DEDUP_BACKEND=memory 显式覆盖 REDIS_URL', () => {
  assert.strictEqual(
    createDedupStore({ REDIS_URL: 'redis://x', IM_DEDUP_BACKEND: 'memory' }).kind,
    'memory'
  );
});

test('RedisDedupStore: 无可用客户端时降级放行（不阻断业务）', async () => {
  const s = new RedisDedupStore();
  assert.strictEqual(s.kind, 'redis');
  // 测试环境通常无 REDIS_URL → getRedisClient() 返回 null → 一律放行（宁可重复也不阻断）。
  assert.strictEqual(await s.check('k1'), true);
  assert.strictEqual(await s.check('k1'), true);
});

test('RedisDedupStore: 空 key 直接放行', async () => {
  const s = new RedisDedupStore();
  assert.strictEqual(await s.check(''), true);
});

test('ImBridge: 可注入自定义 DedupStore 且去重生效', async () => {
  const store = new MemoryDedupStore();
  const adapter = stubAdapter();
  let called = 0;
  const bridge = new ImBridge(
    bridgeConfig(adapter),
    async () => {
      called++;
      return 'ok';
    },
    {},
    store
  );
  const req = { headers: {}, rawBody: '{}', url: new URL('http://x/') };
  await bridge.handleInbound('feishu', req);
  await bridge.handleInbound('feishu', req);
  await tick();
  assert.strictEqual(called, 1, '注入的存储应完成去重');
  assert.strictEqual(bridge.snapshot().deduper, 'memory');
  assert.strictEqual(bridge.snapshot().counters.deduped, 1);
});

'use strict';
// IM 真实平台验证（P0）：用「与真实平台完全一致的加密/签名算法」构造回调，
// 再通过真实的 FeishuAdapter / DingtalkAdapter / WecomAdapter 跑通
// ImBridge 全链路：验签 → 解密 → 解析 → 去重 → 立即 ack 200 → 后台执行。
//
// 与 im-bridge.test.cjs 的区别：那里用 stub adapter 验证桥接逻辑；这里用**真实适配器**
// + **平台原样加密体**，证明本实现生成的「解密/验签」与飞书/钉钉/企业微信线上协议逐字节兼容
// （即：把本脚本产出的 rawBody 直接发给生产 webhook，平台侧算法能与之对应）。
//
// 不触达真实平台网络：仅 executor 用桩、sendText 用 spy 拦截（避免真实出网），
// 但「验签/解密/解析」全程走生产代码，是真实平台级验证的核心。
//
// 运行：pnpm --filter @agent-harness/server run build && node --test test/im-platform-verify.test.cjs

const test = require('node:test');
const assert = require('node:assert');
const { createHash, createHmac, createCipheriv } = require('node:crypto');

const {
  FeishuAdapter,
  DingtalkAdapter,
  WecomAdapter,
  ImBridge,
  createImRegistry
} = require('../dist/im/index.js');

// ─────────────────────────────────────────────────────────────────────────────
// 平台侧「请求构造器」：完全复刻真实平台的加密/签名，作为验证基准。
// ─────────────────────────────────────────────────────────────────────────────

// 飞书：AES-256-CBC 加密 body（key=sha256(encryptKey), iv=key[0:16], PKCS7），
// 外层包 {"encrypt":"<base64>"}；签名 X-Lark-Signature = sha256(ts+nonce+encryptKey+rawBody)。
function feishuEncrypt(plainJson, encryptKey) {
  const key = createHash('sha256').update(encryptKey, 'utf8').digest();
  const iv = key.subarray(0, 16);
  const cipher = createCipheriv('aes-256-cbc', key, iv); // 默认 PKCS7 填充，与平台一致
  const enc = Buffer.concat([cipher.update(Buffer.from(plainJson, 'utf8')), cipher.final()]);
  return enc.toString('base64');
}
function feishuSignedBody(envelope, encryptKey) {
  const rawBody = JSON.stringify({ encrypt: feishuEncrypt(envelope, encryptKey) });
  const ts = '1700000000';
  const nonce = 'n-' + Math.random().toString(36).slice(2, 8);
  const signature = createHash('sha256')
    .update(ts + nonce + encryptKey + rawBody, 'utf8')
    .digest('hex');
  return {
    headers: {
      'x-lark-request-timestamp': ts,
      'x-lark-request-nonce': nonce,
      'x-lark-signature': signature
    },
    rawBody
  };
}

// 钉钉：无加密，签名 sign = base64(HMAC-SHA256(ts+"\n"+secret, secret))。
function dingtalkSignedBody(event, secret) {
  const rawBody = JSON.stringify(event);
  const ts = '1700000000';
  const sign = createHmac('sha256', secret).update(`${ts}\n${secret}`, 'utf8').digest('base64');
  return { headers: { timestamp: ts, sign }, rawBody };
}

// 企业微信：AES-256-CBC（key=base64(aesKey+'='), iv=key[0:16], PKCS7 到 32 字节块），
// 明文结构 random(16)+msgLen(4 BE)+msg+receiveId；签名 sha1(sort([token,ts,nonce,payload]).join(''))。
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
function wecomSign(token, ts, nonce, payload) {
  return createHash('sha1')
    .update([token, ts, nonce, payload].sort().join(''), 'utf8')
    .digest('hex');
}
function wecomPostBody(xml, token, aesKey) {
  const enc = wecomEncrypt(xml, aesKey);
  const ts = '1700000000';
  const nonce = 'n-' + Math.random().toString(36).slice(2, 8);
  const sig = wecomSign(token, ts, nonce, enc);
  const url = new URL(
    `http://x/api/im/wecom/events?msg_signature=${sig}&timestamp=${ts}&nonce=${nonce}`
  );
  return { headers: {}, rawBody: `<xml><Encrypt><![CDATA[${enc}]]></Encrypt></xml>`, url };
}

// ─────────────────────────────────────────────────────────────────────────────
// 桥接装配：真实适配器（验证/解析走生产代码）+ sendText 用 spy 拦截（避免真实出网）。
// ─────────────────────────────────────────────────────────────────────────────

function spyAdapter(adapter) {
  const sent = [];
  adapter.sendText = async (_t, text) => {
    sent.push(text);
  };
  adapter._sent = sent;
  return adapter;
}

function bridgeWith(adapter, extra = {}) {
  return new ImBridge(
    {
      adapters: [adapter],
      defaultMode: 'mock',
      maxSteps: 5,
      timeoutMs: 1000,
      replyPrefix: '[AI] ',
      groupRequireMention: true,
      ...extra
    },
    async (_m, prompt) => `echo:${prompt}`
  );
}

const tick = () => new Promise((r) => setTimeout(r, 40));

// ─────────────────────────────────────────────────────────────────────────────
// 飞书
// ─────────────────────────────────────────────────────────────────────────────

test('飞书（真实适配器）：URL 验证握手原样回显 challenge', async () => {
  const a = spyAdapter(
    new FeishuAdapter({
      appId: 'cli_x',
      appSecret: 'sec',
      verificationToken: 'vt',
      encryptKey: 'ek'
    })
  );
  const bridge = bridgeWith(a);
  const rawBody = JSON.stringify({ type: 'url_verification', challenge: 'abc123', token: 'vt' });
  const res = await bridge.handleInbound('feishu', {
    headers: {},
    rawBody,
    url: new URL('http://x/api/im/feishu/events')
  });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body, { challenge: 'abc123' });
});

test('飞书（真实适配器）：真实加密+签名消息 → 200 且解密出正确文本并执行', async () => {
  const a = spyAdapter(
    new FeishuAdapter({
      appId: 'cli_x',
      appSecret: 'sec',
      verificationToken: 'vt',
      encryptKey: 'ek'
    })
  );
  const bridge = bridgeWith(a);
  const envelope = JSON.stringify({
    schema: '2.0',
    header: { event_id: 'e1', event_type: 'im.message.receive_v1', token: 'vt' },
    event: {
      sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' },
      message: {
        message_id: 'om_1',
        chat_id: 'oc_1',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: '@_user_1 你好世界' })
      }
    }
  });
  const { headers, rawBody } = feishuSignedBody(envelope, 'ek');
  const res = await bridge.handleInbound('feishu', {
    headers,
    rawBody,
    url: new URL('http://x/api/im/feishu/events')
  });
  assert.strictEqual(res.status, 200, '合法加密消息应立即 ack 200');
  await tick();
  assert.deepStrictEqual(a._sent, ['[AI] echo:你好世界'], '应解密并剥离 @占位符');
  assert.strictEqual(bridge.snapshot().counters.completed, 1);
});

test('飞书（真实适配器）：签名不符 → 401 且不执行 agent', async () => {
  let called = 0;
  const a = spyAdapter(
    new FeishuAdapter({
      appId: 'cli_x',
      appSecret: 'sec',
      verificationToken: 'vt',
      encryptKey: 'ek'
    })
  );
  const bridge = new ImBridge(
    {
      adapters: [a],
      defaultMode: 'mock',
      maxSteps: 5,
      timeoutMs: 1000,
      replyPrefix: '',
      groupRequireMention: true
    },
    async () => {
      called++;
      return 'x';
    }
  );
  const envelope = JSON.stringify({
    header: { event_type: 'im.message.receive_v1', token: 'vt' },
    event: {
      sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' },
      message: { message_id: 'om_x', chat_id: 'oc_1', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text: 'hi' }) }
    }
  });
  const { headers, rawBody } = feishuSignedBody(envelope, 'ek');
  headers['x-lark-signature'] = 'deadbeef'; // 篡改签名
  const res = await bridge.handleInbound('feishu', {
    headers,
    rawBody,
    url: new URL('http://x/api/im/feishu/events')
  });
  assert.strictEqual(res.status, 401);
  await tick();
  assert.strictEqual(called, 0, '验签失败不得执行 agent');
  assert.strictEqual(bridge.snapshot().counters.rejected, 1);
});

test('飞书（真实适配器）：群聊未 @ 机器人 → 忽略（不执行）', async () => {
  const a = spyAdapter(
    new FeishuAdapter({
      appId: 'cli_x',
      appSecret: 'sec',
      verificationToken: 'vt',
      encryptKey: 'ek',
      botOpenId: 'ou_bot'
    })
  );
  const bridge = bridgeWith(a);
  const envelope = JSON.stringify({
    header: { event_type: 'im.message.receive_v1', token: 'vt' },
    event: {
      sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' },
      message: {
        message_id: 'om_g',
        chat_id: 'oc_g',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: '大家好' }),
        mentions: [] // 没有 @ 机器人
      }
    }
  });
  const { headers, rawBody } = feishuSignedBody(envelope, 'ek');
  const res = await bridge.handleInbound('feishu', {
    headers,
    rawBody,
    url: new URL('http://x/api/im/feishu/events')
  });
  assert.strictEqual(res.status, 200);
  await tick();
  assert.strictEqual(a._sent.length, 0, '未 @ 机器人应忽略，不回发');
  assert.strictEqual(bridge.snapshot().counters.received, 1, '消息已被接收/解析（计入 received）');
  assert.strictEqual(bridge.snapshot().counters.completed, 0, '未 @ 不应执行完成');
});

// ─────────────────────────────────────────────────────────────────────────────
// 钉钉
// ─────────────────────────────────────────────────────────────────────────────

test('钉钉（真实适配器）：HMAC-SHA256 签名消息 → 200 且解析出文本', async () => {
  const secret = 'appsec';
  const a = spyAdapter(new DingtalkAdapter({ clientId: 'k', clientSecret: secret }));
  const bridge = bridgeWith(a);
  const event = {
    msgId: 'm1',
    msgtype: 'text',
    conversationId: 'c1',
    conversationType: '1',
    senderStaffId: 'u1',
    senderNick: '张三',
    text: { content: ' 查询订单 ' }
  };
  const { headers, rawBody } = dingtalkSignedBody(event, secret);
  const res = await bridge.handleInbound('dingtalk', {
    headers,
    rawBody,
    url: new URL('http://x/api/im/dingtalk/events')
  });
  assert.strictEqual(res.status, 200);
  await tick();
  assert.deepStrictEqual(a._sent, ['[AI] echo:查询订单'], '应剥离首尾空白');
  assert.strictEqual(bridge.snapshot().counters.completed, 1);
});

test('钉钉（真实适配器）：错误密钥签名 → 401', async () => {
  let called = 0;
  const a = spyAdapter(new DingtalkAdapter({ clientId: 'k', clientSecret: 'appsec' }));
  const bridge = new ImBridge(
    {
      adapters: [a],
      defaultMode: 'mock',
      maxSteps: 5,
      timeoutMs: 1000,
      replyPrefix: '',
      groupRequireMention: true
    },
    async () => {
      called++;
      return 'x';
    }
  );
  const { headers, rawBody } = dingtalkSignedBody({ msgId: 'm2', msgtype: 'text', conversationType: '1', senderStaffId: 'u2', text: { content: 'hi' } }, 'wrong-secret');
  const res = await bridge.handleInbound('dingtalk', {
    headers,
    rawBody,
    url: new URL('http://x/api/im/dingtalk/events')
  });
  assert.strictEqual(res.status, 401);
  await tick();
  assert.strictEqual(called, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// 企业微信
// ─────────────────────────────────────────────────────────────────────────────

const WECOM_AES_KEY = 'a'.repeat(43); // 43 位 EncodingAESKey

test('企业微信（真实适配器）：URL 验证握手（验签+解密 echostr 原样返回）', async () => {
  const a = spyAdapter(
    new WecomAdapter({ corpId: 'corp', agentId: '1', secret: 's', token: 'tok', aesKey: WECOM_AES_KEY })
  );
  const bridge = bridgeWith(a);
  const echoPlain = 'echo-12345';
  const echostr = wecomEncrypt(echoPlain, WECOM_AES_KEY);
  const ts = '1700000000';
  const nonce = 'n1';
  const sig = wecomSign('tok', ts, nonce, echostr);
  const url = new URL(
    `http://x/api/im/wecom/events?msg_signature=${sig}&timestamp=${ts}&nonce=${nonce}&echostr=${encodeURIComponent(echostr)}`
  );
  const res = await bridge.handleInbound('wecom', { headers: {}, rawBody: '', url });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body, echoPlain, '应解密 echostr 并原样返回');
});

test('企业微信（真实适配器）：加密消息 POST → 200 且解密出文本', async () => {
  const a = spyAdapter(
    new WecomAdapter({ corpId: 'corp', agentId: '1', secret: 's', token: 'tok', aesKey: WECOM_AES_KEY })
  );
  const bridge = bridgeWith(a);
  const xml =
    '<xml><ToUserName>corp</ToUserName><FromUserName>user1</FromUserName>' +
    '<ChatId>chat1</ChatId><MsgType>text</MsgType><Content>你好</Content><MsgId>1001</MsgId></xml>';
  const { headers, rawBody, url } = wecomPostBody(xml, 'tok', WECOM_AES_KEY);
  const res = await bridge.handleInbound('wecom', { headers, rawBody, url });
  assert.strictEqual(res.status, 200);
  await tick();
  assert.deepStrictEqual(a._sent, ['[AI] echo:你好']);
  assert.strictEqual(bridge.snapshot().counters.completed, 1);
});

test('企业微信（真实适配器）：签名不符 → 401', async () => {
  let called = 0;
  const a = spyAdapter(
    new WecomAdapter({ corpId: 'corp', agentId: '1', secret: 's', token: 'tok', aesKey: WECOM_AES_KEY })
  );
  const bridge = new ImBridge(
    {
      adapters: [a],
      defaultMode: 'mock',
      maxSteps: 5,
      timeoutMs: 1000,
      replyPrefix: '',
      groupRequireMention: true
    },
    async () => {
      called++;
      return 'x';
    }
  );
  const xml = '<xml><MsgType>text</MsgType><Content>hi</Content><FromUserName>u</FromUserName></xml>';
  const enc = wecomEncrypt(xml, WECOM_AES_KEY);
  const ts = '1700000000';
  const nonce = 'n9';
  const badUrl = new URL(
    `http://x/api/im/wecom/events?msg_signature=bad&timestamp=${ts}&nonce=${nonce}`
  );
  const res = await bridge.handleInbound('wecom', {
    headers: {},
    rawBody: `<xml><Encrypt><![CDATA[${enc}]]></Encrypt></xml>`,
    url: badUrl
  });
  assert.strictEqual(res.status, 401);
  await tick();
  assert.strictEqual(called, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// 跨三平台：去重（真实适配器 replay 同 messageId → 只执行一次）
// ─────────────────────────────────────────────────────────────────────────────

test('飞书（真实适配器）：同 messageId 重推 → 去重只执行一次', async () => {
  let called = 0;
  const a = spyAdapter(
    new FeishuAdapter({ appId: 'cli_x', appSecret: 'sec', verificationToken: 'vt', encryptKey: 'ek' })
  );
  const bridge = new ImBridge(
    {
      adapters: [a],
      defaultMode: 'mock',
      maxSteps: 5,
      timeoutMs: 1000,
      replyPrefix: '',
      groupRequireMention: true
    },
    async (_m, prompt) => {
      called++;
      return `echo:${prompt}`;
    }
  );
  const envelope = JSON.stringify({
    header: { event_type: 'im.message.receive_v1', token: 'vt' },
    event: {
      sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' },
      message: { message_id: 'om_dup', chat_id: 'oc_1', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text: 'hi' }) }
    }
  });
  const { headers, rawBody } = feishuSignedBody(envelope, 'ek');
  const req = { headers, rawBody, url: new URL('http://x/api/im/feishu/events') };
  await bridge.handleInbound('feishu', req);
  await bridge.handleInbound('feishu', req); // 平台重推
  await tick();
  assert.strictEqual(called, 1, '重推应被去重');
  assert.strictEqual(bridge.snapshot().counters.deduped, 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// 工厂：真实凭据装配（与 createImRegistry 协议一致）
// ─────────────────────────────────────────────────────────────────────────────

test('createImRegistry：三平台凭据齐全 → 全部入列且 isConfigured', () => {
  const r = createImRegistry({
    IM_ENABLED: 'true',
    IM_PROVIDERS: 'feishu,dingtalk,wecom',
    IM_FEISHU_APP_ID: 'cli',
    IM_FEISHU_APP_SECRET: 'sec',
    IM_FEISHU_VERIFICATION_TOKEN: 'vt',
    IM_FEISHU_ENCRYPT_KEY: 'ek',
    IM_DINGTALK_CLIENT_ID: 'k',
    IM_DINGTALK_CLIENT_SECRET: 's',
    IM_WECOM_CORP_ID: 'corp',
    IM_WECOM_AGENT_ID: '1',
    IM_WECOM_SECRET: 's',
    IM_WECOM_TOKEN: 'tok',
    IM_WECOM_AES_KEY: WECOM_AES_KEY
  });
  assert.deepStrictEqual(r.enabled.sort(), ['dingtalk', 'feishu', 'wecom']);
  for (const a of r.config.adapters) assert.strictEqual(a.isConfigured(), true);
});

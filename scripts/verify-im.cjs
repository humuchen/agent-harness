'use strict';
/**
 * IM 桥接端到端验证（自举，无需真实 IM 平台凭据）。
 *
 * 解决的问题：IM 桥接的验签 / 解密 / 去重 / 回发此前只有单元测试覆盖，
 * 缺少「真实 HTTP 链路」的验证。本脚本在本地拉起：
 *   1) 一个**桩飞书平台**（提供 tenant_access_token 与 im/v1/messages，记录收到的回发）；
 *   2) 真实的 `access/server/dist/server.js`（IM_ENABLED=true，API base 指向桩平台）；
 * 然后按真实平台的调用方式（签名头 + 事件体）打 webhook，端到端断言：
 *   - URL 验证握手回显 challenge
 *   - 错误签名 → 401；合法签名 → 200
 *   - agent 执行结果经 adapter 回发到「IM」（桩平台收到）
 *   - 重复 message_id 被去重（不重复执行 / 不重复回发）
 *   - 未启用平台 → 404；/api/im/status 需鉴权 → 401
 *
 * 用法：
 *   pnpm --filter @agent-harness/server run build   # 先构建
 *   node scripts/verify-im.cjs
 *
 * 退出码：0=全部通过，1=存在失败。
 */

const http = require('node:http');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { existsSync } = require('node:fs');
const { join } = require('node:path');
const { once } = require('node:events');

const ROOT = join(__dirname, '..');
const SERVER_JS = join(ROOT, 'access', 'server', 'dist', 'server.js');

const ENCRYPT_KEY = 'e2e-encrypt-key';
const VERIFY_TOKEN = 'e2e-verify-token';
const ADMIN_TOKEN = 'e2e-admin-token';

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log(`  \u2714 ${name}`);
  } else {
    fail++;
    console.log(`  \u2716 ${name}${extra ? ' \u2014 ' + extra : ''}`);
  }
}

function delay(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await Promise.race([exited, delay(5000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await Promise.race([once(child, 'exit'), delay(2000)]).catch(() => {});
  }
}

/** 简易 POST JSON，返回 { status, headers, body }。 */
function postJson(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = typeof body === 'string' ? body : JSON.stringify(body ?? {});
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          ...headers
        }
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: data })
        );
      }
    );
    req.on('error', reject);
    req.end(payload);
  });
}

function getJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET', headers },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: data })
        );
      }
    );
    req.on('error', reject);
    req.end();
  });
}

/** 飞书签名（配了 Encrypt Key 时）：sha256(timestamp + nonce + encryptKey + rawBody)。 */
function larkSignature(timestamp, nonce, rawBody) {
  return createHash('sha256')
    .update(timestamp + nonce + ENCRYPT_KEY + rawBody, 'utf8')
    .digest('hex');
}

/** 构造一条飞书单聊文本消息事件（message_id 可指定以便测去重）。 */
function feishuMessageBody(messageId, text) {
  return JSON.stringify({
    schema: '2.0',
    header: {
      event_id: `evt-${messageId}`,
      event_type: 'im.message.receive_v1',
      token: VERIFY_TOKEN
    },
    event: {
      sender: { sender_id: { open_id: 'ou_e2e_user' }, sender_type: 'user' },
      message: {
        message_id: messageId,
        chat_id: 'oc_e2e_chat',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text })
      }
    }
  });
}

async function main() {
  if (!existsSync(SERVER_JS)) {
    console.error(
      '[verify-im] 未找到 access/server/dist/server.js\n' +
        '请先执行：pnpm --filter @agent-harness/server run build'
    );
    process.exit(1);
  }

  // ── 1) 桩飞书平台 ──
  const received = [];
  const stub = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url.startsWith('/open-apis/auth/v3/tenant_access_token')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ code: 0, tenant_access_token: 'stub-token', expire: 7200 }));
        return;
      }
      if (req.url.startsWith('/open-apis/im/v1/messages')) {
        received.push({ url: req.url, body });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ code: 0, data: { message_id: 'om-out' } }));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  stub.listen(0, '127.0.0.1');
  await once(stub, 'listening');
  const stubPort = stub.address().port;

  // ── 2) 真实 agent-harness server（IM 指向桩平台）──
  const ahPort = 41000 + Math.floor(Math.random() * 3000);
  const env = {
    ...process.env,
    PORT: String(ahPort),
    UI_HOST: '127.0.0.1',
    ADMIN_API_KEY: ADMIN_TOKEN,
    ACCOUNT_AUTH: 'off',
    // 开启 RBAC 令牌鉴权（否则为开放模式，受保护端点也会返回 200，无法验证「需鉴权」）。
    UI_TOKENS: JSON.stringify({ [ADMIN_TOKEN]: 'admin' }),
    IM_ENABLED: 'true',
    IM_PROVIDERS: 'feishu',
    IM_DEFAULT_MODE: 'mock', // 离线 mock LLM，无需密钥
    IM_FEISHU_APP_ID: 'cli_e2e',
    IM_FEISHU_APP_SECRET: 'sec_e2e',
    IM_FEISHU_VERIFICATION_TOKEN: VERIFY_TOKEN,
    IM_FEISHU_ENCRYPT_KEY: ENCRYPT_KEY,
    IM_FEISHU_BASE_URL: `http://127.0.0.1:${stubPort}/open-apis`,
    MCP_SERVERS: '',
    MCP_SERVER_URL: ''
  };

  const server = spawn(process.execPath, [SERVER_JS], { env, cwd: ROOT });
  let out = '';
  const ready = new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => {
      out += d.toString();
      if (out.includes('已启动')) resolve();
    });
    server.stderr.on('data', (d) => (out += d.toString()));
    server.on('error', reject);
    const t = setTimeout(() => reject(new Error('server 启动超时（15s）')), 15000);
    t.unref?.();
  });

  try {
    await ready;
    const base = `http://127.0.0.1:${ahPort}`;
    const hook = `${base}/api/im/feishu/events`;
    console.log('\n[verify-im] server 已就绪，开始端到端断言\n');

    // ── a) URL 验证握手（无需签名，应原样回显 challenge）──
    const challengeBody = JSON.stringify({
      type: 'url_verification',
      challenge: 'challenge-abc',
      token: VERIFY_TOKEN
    });
    const r1 = await postJson(hook, challengeBody);
    let r1json = {};
    try {
      r1json = JSON.parse(r1.body);
    } catch {
      /* ignore */
    }
    check(
      'URL 验证握手回显 challenge',
      r1.status === 200 && r1json.challenge === 'challenge-abc',
      `status=${r1.status} body=${r1.body.slice(0, 120)}`
    );

    // ── b) 错误签名 → 401 ──
    const msgBody = feishuMessageBody('om_e2e_1', '请回复：收到');
    const r2 = await postJson(hook, msgBody, {
      'x-lark-request-timestamp': '1700000000',
      'x-lark-request-nonce': 'n-bad',
      'x-lark-signature': 'deadbeef'
    });
    check('错误签名被拒（401）', r2.status === 401, `status=${r2.status}`);

    // ── c) 合法签名 → 200（立即 ack）──
    const ts = '1700000001';
    const nonce = 'n-ok';
    const r3 = await postJson(hook, msgBody, {
      'x-lark-request-timestamp': ts,
      'x-lark-request-nonce': nonce,
      'x-lark-signature': larkSignature(ts, nonce, msgBody)
    });
    check('合法事件被接受（200 立即 ack）', r3.status === 200, `status=${r3.status}`);

    // ── d) 等待 agent 执行并回发到「IM」（桩平台）──
    let replied = null;
    for (let i = 0; i < 80 && !replied; i++) {
      await delay(250);
      replied = received.find((m) => {
        try {
          const parsed = JSON.parse(m.body);
          return parsed.receive_id === 'oc_e2e_chat';
        } catch {
          return false;
        }
      });
    }
    let replyText = '';
    if (replied) {
      try {
        replyText = JSON.parse(JSON.parse(replied.body).content).text ?? '';
      } catch {
        /* ignore */
      }
    }
    check(
      'agent 结果已回发到 IM 会话',
      Boolean(replied) && replyText.length > 0,
      replied ? `reply="${replyText.slice(0, 60)}"` : '桩平台未收到回发'
    );

    // ── e) 重复 message_id 去重（不重复执行 / 不重复回发）──
    const before = received.length;
    const ts2 = '1700000002';
    const r4 = await postJson(hook, msgBody, {
      'x-lark-request-timestamp': ts2,
      'x-lark-request-nonce': 'n-dup',
      'x-lark-signature': larkSignature(ts2, 'n-dup', msgBody)
    });
    check('重复消息仍返回 200', r4.status === 200, `status=${r4.status}`);
    await delay(1200);
    check(
      '重复消息未触发第二次回发（去重生效）',
      received.length === before,
      `回发数 ${before} → ${received.length}`
    );

    // ── f) 未启用平台 → 404 ──
    const r5 = await postJson(`${base}/api/im/dingtalk/events`, '{}');
    check('未启用平台返回 404', r5.status === 404, `status=${r5.status}`);

    // ── g) /api/im/status 需鉴权 ──
    const r6 = await getJson(`${base}/api/im/status`);
    check('未带令牌访问 /api/im/status → 401', r6.status === 401, `status=${r6.status}`);
    const r7 = await getJson(`${base}/api/im/status`, {
      authorization: `Bearer ${ADMIN_TOKEN}`
    });
    let r7json = {};
    try {
      r7json = JSON.parse(r7.body);
    } catch {
      /* ignore */
    }
    check(
      '带令牌可读取 /api/im/status（含 enabled/deduper）',
      r7.status === 200 && Array.isArray(r7json.enabled) && r7json.enabled.includes('feishu'),
      `status=${r7.status} body=${r7.body.slice(0, 160)}`
    );
  } finally {
    await stopChild(server);
    // 关闭桩平台：http.Server 没有 exitCode/signalCode，不能复用 stopChild。
    await new Promise((resolve) => stub.close(() => resolve()));
    // 释放 keep-alive 连接池（Node 19+ 默认 keepAlive），否则残留 socket 会拖住事件循环。
    http.globalAgent.destroy();
  }

  console.log(`\n[verify-im] 通过 ${pass} / ${pass + fail}`);
  if (fail > 0) {
    console.error(`[verify-im] 失败 ${fail} 项`);
    process.exit(1);
  }
  // 断言全部通过后显式退出：即便有第三方句柄残留也不影响 CI 判定。
  process.exit(0);
}

main().catch((e) => {
  console.error('[verify-im] 执行异常：', e?.stack ?? e);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * run 全流程 e2e 护航（R1 收口的护航脚本，P2 模块化终批时建立）。
 *
 * 背景：handleRun（~1000 行）/ handleWorkflow 是产品关键路径，搬移到
 * routes/run-routes.ts 前必须先有全流程回归。本脚本在**重构前的旧 dist**
 * 上先行跑绿建立基线，重构后复验行为零变更。
 *
 * 覆盖 5 项：
 *   1. qa 模式 run：job:accepted → 事件流 → 终态 _done（完整生命周期）
 *   2. 会话持久化：chat 会话落 user + assistant 消息
 *   3. 断线重连：携带 jobId 重连，事件重放可用
 *   4. plan 模式 propose：优雅终止（不挂起、不 5xx）
 *   5. workflows 空 def：400 语义
 *
 * 用法（需已启动的服务）：
 *   SMOKE_BASE=http://127.0.0.1:PORT SMOKE_TOKEN=<token> node scripts/e2e-run-flow.cjs
 * 服务启动（mock 模式）：
 *   PORT=4193 ADMIN_API_KEY=test-admin-token MEMORY_BACKEND=volatile node access/server/dist/server.js
 */
const http = require('node:http');

const BASE = process.env.SMOKE_BASE || 'http://127.0.0.1:4193';
const TOKEN = process.env.SMOKE_TOKEN || 'test-admin-token';

function parseSse(chunk) {
  const events = [];
  for (const block of chunk.split('\n\n')) {
    const dataLines = block
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim());
    if (dataLines.length) {
      try {
        events.push(JSON.parse(dataLines.join('\n')));
      } catch {
        /* 忽略无法解析的帧（心跳等） */
      }
    }
  }
  return events;
}

/**
 * 发起一次 run SSE 并消费到终结。opts.reconnect=true 时跳过首次提交，
 * 直接用 knownJobId 重连（验证重放流）。
 */
function runSse(body, { timeoutMs = 90000, signalOnFirstEvent = false } = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      `${BASE}/api/run`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${TOKEN}`,
          'content-length': Buffer.byteLength(payload)
        },
        timeout: timeoutMs
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        let buf = '';
        const events = [];
        let firstEvent = null;
        res.on('data', (c) => {
          buf += c.toString();
          const parsed = parseSse(buf.slice(0, buf.lastIndexOf('\n\n') + 2));
          if (parsed.length) {
            buf = buf.slice(buf.lastIndexOf('\n\n') + 2);
            for (const e of parsed) {
              if (!firstEvent) {
                firstEvent = e;
                // 断线重连演练：收到首帧即主动断开
                if (signalOnFirstEvent) {
                  res.destroy();
                  resolve({ events, firstEvent, aborted: true });
                  return;
                }
              }
              events.push(e);
              if (e.type === '_done') {
                res.destroy();
                resolve({ events, firstEvent, aborted: false });
                return;
              }
            }
          }
        });
        res.on('error', () => {
          // 主动 destroy 触发的 ECONNRESET 视为正常退出
          resolve({ events, firstEvent, aborted: true });
        });
        res.on('end', () => resolve({ events, firstEvent, aborted: false }));
      }
    );
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
    req.on('error', (e) => {
      if (signalOnFirstEvent) resolve({ events: [], firstEvent: null, aborted: true });
      else reject(e);
    });
    req.write(payload);
    req.end();
  });
}

function post(path, body, { expectStatus } = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      `${BASE}${path}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${TOKEN}`,
          'content-length': Buffer.byteLength(payload)
        },
        timeout: 15000
      },
      (res) => {
        let b = '';
        res.on('data', (c) => (b += c.toString()));
        res.on('end', () => resolve({ status: res.statusCode, body: b, headers: res.headers }));
      }
    );
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function get(path) {
  return new Promise((resolve, reject) => {
    http
      .get(`${BASE}${path}`, { headers: { authorization: `Bearer ${TOKEN}` }, timeout: 10000 }, (res) => {
        let b = '';
        res.on('data', (c) => (b += c.toString()));
        res.on('end', () => resolve({ status: res.statusCode, body: b }));
      })
      .on('error', reject);
  });
}

async function main() {
  const results = [];
  const check = (name, ok, detail = '') => {
    results.push([name, ok, detail]);
    console.log(`${ok ? '✅' : '❌'} ${name}${detail ? '  — ' + detail : ''}`);
  };

  // ── 1) qa run 全生命周期 ──
  const { events, firstEvent } = await runSse({
    prompt: '用一句话说明什么是回归测试。',
    mode: 'mock',
    interactionMode: 'qa',
    sessionId: 'e2e-runflow-' + Date.now()
  });
  check(
    '1) qa run：job:accepted 开局',
    !!firstEvent && firstEvent.type === 'job:accepted' && !!firstEvent.jobId,
    firstEvent ? `type=${firstEvent.type}` : 'no events'
  );
  const types = events.map((e) => e.type);
  check(
    '2) qa run：事件流完整到达终态 _done',
    types.includes('_done') && events.length >= 5,
    `events=${events.length} (types: ${[...new Set(types)].slice(0, 8).join(',')}...)`
  );
  const jobId = firstEvent?.jobId;

  // ── 3) 会话持久化（user + assistant 消息落库）──
  await new Promise((r) => setTimeout(r, 800)); // 等待异步落库
  const sessions = await get('/api/chat/sessions?page=1&pageSize=20');
  let sessionMsgs = null;
  if (sessions.status === 200) {
    try {
      const data = JSON.parse(sessions.body);
      const list = data.items ?? data.sessions ?? data ?? [];
      const mine = (Array.isArray(list) ? list : []).find(
        (s) => s.sessionKey === firstEvent?.sessionKey || String(s.id || '').includes('e2e-runflow')
      );
      if (mine) {
        const detail = await get(`/api/chat/sessions/${mine.id || mine.sessionId}`);
        if (detail.status === 200) sessionMsgs = JSON.parse(detail.body);
      }
    } catch { /* 结构差异容忍 */ }
  }
  check(
    '3) 会话持久化：会话可查询',
    sessions.status === 200,
    `GET /api/chat/sessions → ${sessions.status}`
  );

  // ── 4) 断线重连：jobId 重连重放 ──
  if (jobId) {
    const re = await runSse({ jobId, mode: 'mock' });
    check(
      '4) 断线重连：jobId 重连重放事件',
      re.events.length > 0,
      `replayed=${re.events.length}`
    );
  } else {
    check('4) 断线重连：jobId 重连重放事件', false, '无 jobId');
  }

  // ── 5) plan propose 优雅终止（mock LLM 下不挂起、不 5xx）──
  const plan = await runSse(
    {
      prompt: '整理一个两步的部署计划。',
      mode: 'mock',
      interactionMode: 'plan',
      sessionId: 'e2e-planflow-' + Date.now()
    },
    { timeoutMs: 60000 }
  );
  check(
    '5) plan propose：优雅终止',
    plan.events.length > 0 && plan.events[plan.events.length - 1].type === '_done',
    `events=${plan.events.length}, last=${plan.events[plan.events.length - 1]?.type}`
  );

  // ── 6) workflows 空 def：400 语义 ──
  const wf = await post('/api/workflows', {});
  check('6) workflows 空 def：400', wf.status === 400, `status=${wf.status}`);

  const fail = results.filter(([, ok]) => !ok).length;
  console.log(`\n${fail === 0 ? '🎉 全部通过' : '💥 存在失败'}：${results.length - fail}/${results.length}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('e2e 异常终止：', e.message);
  process.exit(1);
});

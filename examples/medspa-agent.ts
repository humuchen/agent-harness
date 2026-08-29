/**
 * 医美行业智能体「对接」可运行示例（演示 POST /api/agents 运行时注册端点）。
 *
 * 这条示例回答一个具体问题：如何把一个「医美（medical-aesthetics）」行业智能体，在平台
 * 运行时动态接入并真正跑起来 —— 而不是在启动期硬编码。
 *
 * 全流程（均走真实 HTTP API，与 Web UI / 其它客户端同路径）：
 *   1) 启动服务端（本例就地 spawn `access/server/dist/server.js`，也可连已运行的实例）；
 *   2) 构造一张「医美咨询顾问」AgentCard：声明 domain=medical-aesthetics、专属能力、
 *      以及 assembly 装配配方（收敛系统提示词 + 收窄工具），并声明最低隔离级别 os
 *      （医美属 STRICT 域，跨行业不可信须强隔离）；
 *   3) POST /api/agents 在运行时注册这张卡片（即「运行时注册端点」）；
 *   4) POST /api/run 带 tenantId 跑一轮医美咨询，验证「行业 agent + 租户隔离」闭环；
 *   5) 反向演示投产加固：REQUIRE_TENANT=true 下，不带 tenantId 跑同一行业 agent 会被
 *      隔离门禁拒绝（SSE 流 warn "tenant isolation denied" + _done{error:true}）。
 *
 * 运行（需先构建 server 与 core）：
 *   pnpm -r build
 *   pnpm --filter @agent-harness/examples run medspa
 * 也可连已运行的平台：AGENT_HARNESS_URL=http://127.0.0.1:4173 node dist/medspa-agent.js
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { AgentCard } from '@agent-harness/core';

const REPO_ROOT = path.resolve(__dirname, '../..');
const SERVER_ENTRY = path.resolve(REPO_ROOT, 'access/server/dist/server.js');
const PORT = Number(process.env.MEDSPA_PORT ?? 4178);

/** 是否连已运行的平台（不就地拉起 server）。 */
const EXTERNAL_URL = process.env.AGENT_HARNESS_URL || '';
const BASE = EXTERNAL_URL || `http://127.0.0.1:${PORT}`;

let serverProc: ReturnType<typeof spawn> | null = null;

function startServer(): void {
  if (EXTERNAL_URL) return; // 连外部实例，无需拉起
  if (!existsSync(SERVER_ENTRY)) {
    console.error(
      `\n[medspa] 未找到 server 构建产物：${SERVER_ENTRY}\n` +
        `         请先构建：pnpm -r build\n`
    );
    process.exit(1);
  }
  // 开放鉴权（无 UI_TOKENS）+ 强制租户隔离（演示投产加固）。
  serverProc = spawn('node', [SERVER_ENTRY], {
    env: {
      ...process.env,
      PORT: String(PORT),
      UI_HOST: '127.0.0.1',
      REQUIRE_TENANT: 'true',
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
}

async function waitReady(timeoutMs = 20000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/api/state`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server @ ${BASE} 未在 ${timeoutMs}ms 内就绪`);
}

async function api(method: string, p: string, body?: unknown) {
  const r = await fetch(`${BASE}${p}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON */
  }
  return { status: r.status, json };
}

/** 读取 /api/run 的 SSE 流直到 _done，返回事件数组 + 最终文本。 */
async function runSse(body: unknown): Promise<{ events: any[]; final: string; denied: boolean }> {
  const res = await fetch(`${BASE}/api/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const events: any[] = [];
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let final = '';
  let denied = false;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const line = block.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      try {
        const ev = JSON.parse(line.slice(5).trim());
        events.push(ev);
        if (ev.type === 'warn' && /tenant isolation denied/.test(ev.message || '')) denied = true;
        if (ev.type === '_done') final = ev.final ?? '';
      } catch {
        /* ignore */
      }
    }
    if (events.some((e) => e.type === '_done')) break;
  }
  return { events, final, denied };
}

function buildMedspaCard(): AgentCard {
  return {
    id: 'medspa-agent',
    name: '医美咨询顾问 Agent',
    domain: 'medical-aesthetics',
    description: '医美机构咨询顾问：方案科普、项目答疑、预约引导（非诊断，不替代医生面诊）。',
    capabilities: [
      { id: 'aesthetics-consult', version: '1.0.0' },
      { id: 'appointment-book', version: '1.0.0' },
      { id: 'treatment-recommend', version: '1.0.0' },
    ],
    transport: 'local',
    version: '1.0.0',
    health: { status: 'healthy', lastHeartbeat: Date.now(), load: 0 },
    // 医美属 STRICT 隔离域：声明最低 os 级隔离（跨行业不可信，服务端会据此收敛后端）。
    isolation: 'os',
    // assembly 装配配方：把「万能 harness」收敛为「医美领域 harness」。
    assembly: {
      systemPrompt:
        '你是某正规医美机构的资深咨询顾问。职责：用通俗语言科普项目（如热玛吉/玻尿酸/水光针）' +
        '原理与注意事项、根据诉求做初步方案与预算区间建议、引导到院面诊与预约。' +
        '严格边界：不做医疗诊断、不开具处方、不承诺疗效；涉及禁忌症/并发症须提示就医。' +
        '涉及价格仅给区间参考，最终以到院面诊为准。',
      // 仅启用这些内置工具（收敛攻击面）：计算（预算区间）、联网检索（项目科普）、文件（方案存档）。
      tools: ['calculator', 'web_fetch', 'filesystem'],
      // 若有医美专属 skill，可在此声明 id 列表；缺省沿用默认技能。
      skills: [],
    },
  };
}

let failures = 0;
function check(name: string, cond: boolean): void {
  console.log(`  ${cond ? '✓' : '✗'} ${name}`);
  if (!cond) failures += 1;
}

async function main(): Promise<void> {
  startServer();
  await waitReady();

  const card = buildMedspaCard();

  console.log('\n=== 1) POST /api/agents —— 运行时注册「医美咨询顾问」===');
  const reg = await api('POST', '/api/agents', card);
  check('注册返回 200 且 ok:true', reg.status === 200 && reg.json?.ok === true);
  check('回显 domain=medical-aesthetics', reg.json?.agent?.domain === 'medical-aesthetics');
  check('回显装配配方 assembly 已保存', !!reg.json?.agent?.assembly?.systemPrompt);

  const list = await api('GET', '/api/agents');
  check('GET /api/agents 列表包含 medspa-agent', list.json?.agents?.some((a: any) => a.id === 'medspa-agent'));

  console.log('\n=== 2) POST /api/run —— 带 tenantId 跑医美咨询（行业隔离闭环）===');
  const run = await runSse({
    agentId: 'medspa-agent',
    domain: 'medical-aesthetics', // 显式领域，验证领域路由与 run:meta 透传
    mode: 'mock',
    tenantId: 'clinic-tenant-001', // 真实对接时由认证身份（SSO/网关）派生，不可客户端伪造
    prompt: '我想咨询一下热玛吉方案和价格，顺便预约下周三。',
  });
  check('运行成功（_done 无 error）', run.events.some((e) => e.type === '_done' && !e.error));
  const meta = run.events.find((e) => e.type === 'run:meta');
  check('run:meta 命中 medspa-agent（decidedBy=explicit）', meta?.agentId === 'medspa-agent' && meta?.decidedBy === 'explicit');
  check('run:meta domain=medical-aesthetics（领域路由生效）', meta?.domain === 'medical-aesthetics');
  check('run:meta 携带租户上下文 tenantId', meta?.tenantId === 'clinic-tenant-001');
  console.log('   最终回复（mock）：', JSON.stringify(run.final).slice(0, 80));

  console.log('\n=== 3) 投产加固：REQUIRE_TENANT=true 下不传 tenantId 必须被拒绝 ===');
  const deniedRun = await runSse({
    agentId: 'medspa-agent',
    mode: 'mock',
    prompt: '我想咨询一下热玛吉。',
  });
  check('无 tenantId 跑行业 agent → 被隔离门禁拒绝', deniedRun.denied);

  // 清理：注销示例 agent（演示 DELETE /api/agents/:id 写端点）。
  const del = await api('DELETE', '/api/agents/medspa-agent');
  check('DELETE /api/agents/medspa-agent 返回 ok:true', del.json?.ok === true);

  console.log(`\n=== 医美 agent 对接示例：${failures === 0 ? '全部通过 ✓' : failures + ' 项失败 ✗'} ===`);
}

main()
  .catch((e) => {
    console.error('[medspa] 失败：', e);
    failures = 1;
  })
  .finally(() => {
    if (serverProc) serverProc.kill('SIGTERM');
    process.exit(failures === 0 ? 0 : 1);
  });

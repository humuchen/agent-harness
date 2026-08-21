/**
 * 端到端 smoke：用 @agent-harness/client 打一套真实运行中的 /api/v1 server。
 * 验证：state / mcp / approvals / recipes 的 REST 读，以及 run 的 SSE 事件流
 * （job:accepted → ... → _done）。
 *
 * 自举设计（关键）：本脚本**自己负责拉起 server**，不再假设外部已有进程在跑，
 * 否则在 CI（`pnpm -r test`）里必然 ECONNREFUSED。三种运行姿态：
 *   1. 指定 AH_BASE_URL   → 直连既有 server（不 spawn，不 kill）
 *   2. server 已构建       → 在随机空闲端口 spawn access/server/dist/server.js，跑完回收
 *
 *   3. server 未构建       → 跳过（exit 0）；设 AH_SMOKE_STRICT=1 可改为失败
 *
 * 用法：
 *   pnpm -r build && pnpm --filter @agent-harness/client run test:e2e
 *   AH_BASE_URL=http://localhost:4173 node test/smoke.mjs   # 打既有实例
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_DIST = resolve(HERE, '..', 'dist', 'index.js');
const SERVER_ENTRY = resolve(HERE, '..', '..', 'server', 'dist', 'server.js');
const STRICT = process.env.AH_SMOKE_STRICT === '1';
const READY_TIMEOUT_MS = Number(process.env.AH_SMOKE_READY_TIMEOUT_MS ?? 30_000);

/** 未满足前置条件：默认跳过（CI 不因缺构建产物而红），STRICT 下升级为失败。 */
function bail(msg) {
  if (STRICT) {
    console.error(`❌ ${msg}（AH_SMOKE_STRICT=1，视为失败）`);
    process.exit(1);
  }
  console.log(`⏭️  SKIP: ${msg}`);
  process.exit(0);
}

if (!existsSync(CLIENT_DIST)) {
  bail(`未找到 client 构建产物 ${CLIENT_DIST}，请先 pnpm --filter @agent-harness/client run build`);
}

/** 借操作系统分配一个空闲端口（避开固定端口在 CI 上撞车）。 */
function freePort() {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.on('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => res(port));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 轮询 /api/v1/state 直到 200；子进程中途退出则立即失败（附日志尾部）。 */
async function waitForReady(base, child, log) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child?.exitCode !== null && child?.exitCode !== undefined) {
      throw new Error(`server 进程提前退出（code=${child.exitCode}）\n${log().slice(-2000)}`);
    }
    try {
      const res = await fetch(`${base}/api/v1/state`);
      if (res.ok) return;
    } catch {
      /* 尚未监听，继续等 */
    }
    await sleep(200);
  }
  throw new Error(`等待 ${base} 就绪超时（${READY_TIMEOUT_MS}ms）\n${log().slice(-2000)}`);
}

/**
 * 拉起 server：随机端口 + 显式开放鉴权 + 关限流，cwd 指向本包目录，
 * 避免仓库根 .env 把真实密钥/令牌带进 smoke（保证跨环境行为一致）。
 */
async function startServer() {
  const port = await freePort();
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: resolve(HERE, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      UI_HOST: '127.0.0.1',
      AUTH_PROVIDER: 'token',
      UI_AUTH_TOKEN: '',
      UI_TOKENS: '',
      RATE_LIMIT: '0',
      AUDIT_LOG: '',
      QUEUE_BACKEND: 'memory',
      AH_SMOKE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let buf = '';
  const capture = (c) => {
    buf += c.toString();
    if (buf.length > 20_000) buf = buf.slice(-20_000);
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);

  const stop = async () => {
    if (child.exitCode !== null) return;
    child.kill('SIGTERM');
    for (let i = 0; i < 40 && child.exitCode === null; i++) await sleep(100);
    if (child.exitCode === null) child.kill('SIGKILL');
  };

  return { base: `http://127.0.0.1:${port}`, child, stop, log: () => buf };
}

/* --------------------------------- 断言辅助 --------------------------------- */

let failures = 0;
function check(name, cond, extra) {
  const ok = !!cond;
  if (!ok) failures++;
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? '  ' + JSON.stringify(extra) : ''}`);
}

async function runChecks(base, token) {
  const { AgentClient } = await import(pathToFileURL(CLIENT_DIST).href);
  const client = new AgentClient({ baseUrl: base, token });

  // 1) 健康检查 / 状态
  const state = await client.getState();
  check('getState 返回对象', typeof state === 'object' && state !== null);
  check('getState.mcpServers 为数组', Array.isArray(state.mcpServers));
  check('getState.model 为字符串', typeof state.model === 'string', { model: state.model });

  // 2) MCP 列表
  const mcp = await client.getMcpServers();
  check('getMcpServers.servers 为数组', Array.isArray(mcp.servers), { n: mcp.servers.length });

  // 3) 审批列表（开放模式应为空数组，且不报错）
  const appr = await client.listApprovals();
  check('listApprovals.tickets 为数组', Array.isArray(appr.tickets), { n: appr.tickets.length });

  // 4) 配方列表（开放模式应为空数组）
  const rec = await client.listRecipes();
  check('listRecipes.recipes 为数组', Array.isArray(rec.recipes));

  // 5) run 的 SSE 事件流（mock 模式，无需审批）
  const events = [];
  let sawAccepted = false;
  let sawDone = false;
  for await (const ev of client.streamRun({ mode: 'mock', prompt: 'say hi' })) {
    events.push(ev);
    if (ev.type === 'job:accepted') sawAccepted = true;
    if (ev.type === '_done') sawDone = true;
  }
  check('streamRun 产出事件', events.length > 0, { n: events.length });
  check('streamRun 含 job:accepted', sawAccepted);
  check('streamRun 含 _done 终结帧', sawDone);

  // 6) 事件类型透传（type 字段存在）
  check('事件均含 type 字段', events.every((e) => typeof e.type === 'string'));
}

/* ----------------------------------- 主流程 ---------------------------------- */

async function main() {
  const external = process.env.AH_BASE_URL;
  let handle = null;
  let base = external;

  if (external) {
    console.log(`ℹ️  直连既有 server：${external}`);
  } else {
    if (!existsSync(SERVER_ENTRY)) {
      bail(`未找到 server 构建产物 ${SERVER_ENTRY}，请先 pnpm -r build（或设 AH_BASE_URL 指向已运行实例）`);
    }
    handle = await startServer();
    base = handle.base;
    console.log(`ℹ️  已拉起 server：${base}（pid=${handle.child.pid}）`);
  }

  try {
    await waitForReady(base, handle?.child, handle?.log ?? (() => ''));
    await runChecks(base, process.env.AH_TOKEN);
  } finally {
    if (handle) await handle.stop();
  }

  console.log(`\n${failures === 0 ? '🎉 ALL PASS' : '⚠️  FAILURES: ' + failures}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('💥 smoke crashed:', e);
  process.exit(1);
});

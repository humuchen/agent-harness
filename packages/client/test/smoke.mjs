/**
 * 端到端 smoke：用 @agent-harness/client 打一套真实运行中的 /api/v1 server。
 * 验证：state / mcp / approvals 的 REST 读，以及 run 的 SSE 事件流（job:accepted → ... → _done）。
 * 用法：先 `node packages/server/dist/server.js`（或任意已构建 server），再 `node test/smoke.mjs`。
 */
import { AgentClient } from '../dist/index.js';

const BASE = process.env.AH_BASE_URL || 'http://localhost:4178';
const client = new AgentClient({ baseUrl: BASE });

let failures = 0;
function check(name, cond, extra) {
  const ok = !!cond;
  if (!ok) failures++;
  console.log(`${ok ? '✅' : '❌'} ${name}${extra ? '  ' + JSON.stringify(extra) : ''}`);
}

async function main() {
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

  console.log(`\n${failures === 0 ? '🎉 ALL PASS' : '⚠️  FAILURES: ' + failures}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('💥 smoke crashed:', e);
  process.exit(1);
});

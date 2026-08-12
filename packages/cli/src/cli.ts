#!/usr/bin/env node
/**
 * agent-harness CLI（ah）—— 多平台客户端包的第二个下游实现 + 内部运维入口。
 *
 * 直接消费 @agent-harness/client，零运行时依赖（仅用 Node 全局 fetch）。
 *
 *   ah [--base URL] [--token TOKEN] [--json] <command> [args]
 *
 * 命令：
 *   state                      打印服务端能力状态
 *   health                     仅探活（/api/v1/state 可达即 0）
 *   metrics                    打印指标快照
 *   run  [--mode mock|real|real-mcp] [--prompt P] [--model M]
 *       [--max-steps N] [--session ID] [--reconnect JOBID]
 *       [--approval-ticket T] [--wait-approval] [--poll-timeout MS]
 *   verify
 *   env [--action create|destroy] [--branch B] [--ttl H] [--region R]
 *       [--owner O] [--env-id ID] [--wait-approval]
 *   mcp list
 *   mcp add  --name N --url U [--headers '{"k":"v"}']
 *   mcp preset --id ID [--mcp-token T]
 *   approvals list [--status pending|approved|rejected]
 *   approvals decide --id ID --decision approve|reject [--by SUB]
 *   recipes list
 *   recipes save --job JOBID [--recipe-name N]
 *   eval --job JOBID
 *   memory get    --session KEY
 *   memory clear  --session KEY
 */

import { parseArgs } from 'node:util';
import { AgentClient } from '@agent-harness/client';
import { makeClient } from './client.js';
import { runStream } from './stream.js';
import { c, err, jsonOut, out } from './output.js';

const HELP = `agent-harness CLI (ah) — 用法见源码头部注释，或 https://github.com/.../README`;

const optsConfig = {
  'base': { type: 'string' as const, default: process.env.AH_BASE ?? 'http://localhost:4173' },
  'token': { type: 'string' as const, default: process.env.AH_TOKEN },
  'json': { type: 'boolean' as const, default: false },
  'help': { type: 'boolean' as const, short: 'h' as const, default: false },
  'version': { type: 'boolean' as const, default: false },
  // run
  'mode': { type: 'string' as const },
  'prompt': { type: 'string' as const },
  'model': { type: 'string' as const },
  'max-steps': { type: 'string' as const },
  'session': { type: 'string' as const },
  'reconnect': { type: 'string' as const },
  'approval-ticket': { type: 'string' as const },
  'wait-approval': { type: 'boolean' as const, default: false },
  'poll-timeout': { type: 'string' as const, default: '120000' },
  // env
  'action': { type: 'string' as const },
  'branch': { type: 'string' as const },
  'ttl': { type: 'string' as const },
  'region': { type: 'string' as const },
  'owner': { type: 'string' as const },
  'env-id': { type: 'string' as const },
  // mcp
  'name': { type: 'string' as const },
  'url': { type: 'string' as const },
  'server-url': { type: 'string' as const },
  'command': { type: 'string' as const },
  'mcp-token': { type: 'string' as const },
  'headers': { type: 'string' as const },
  // approvals
  'id': { type: 'string' as const },
  'decision': { type: 'string' as const },
  'by': { type: 'string' as const },
  'status': { type: 'string' as const },
  // recipes / eval
  'job': { type: 'string' as const },
  'recipe-name': { type: 'string' as const },
} as const;

type Vals = Record<string, string | boolean | undefined>;

function str(v: string | boolean | undefined): string | undefined {
  return typeof v === 'string' && v.length ? v : undefined;
}
function bool(v: string | boolean | undefined): boolean {
  return v === true;
}
function num(v: string | boolean | undefined): number | undefined {
  const s = str(v);
  if (!s) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

async function main(): Promise<number> {
  const parsed = parseArgs({ options: optsConfig as any, allowPositionals: true });
  const values = parsed.values as Vals;
  const positionals = parsed.positionals;
  if (bool(values['help'])) { out(HELP); return 0; }
  if (bool(values['version'])) { out('@agent-harness/cli 0.1.0'); return 0; }

  const json = bool(values['json']);
  const base = str(values['base']) ?? 'http://localhost:4173';
  const token = str(values['token']);
  const client: AgentClient = makeClient(base, token);

  const cmd = positionals[0];
  const sub = positionals[1];

  switch (cmd) {
    case 'state': {
      const st = await client.getState();
      json ? jsonOut(st) : out(JSON.stringify(st, null, 2));
      return 0;
    }
    case 'health': {
      try {
        await client.getState();
        out(c('green', 'ok')); return 0;
      } catch (e) {
        err(c('red', `unhealthy: ${(e as Error).message}`)); return 1;
      }
    }
    case 'metrics': {
      const m = await client.getMetrics();
      json ? jsonOut(m) : out(JSON.stringify(m, null, 2));
      return 0;
    }
    case 'run': {
      const input: Record<string, unknown> = {
        mode: str(values['mode']) ?? 'mock',
        prompt: str(values['prompt']),
        model: str(values['model']),
        maxSteps: num(values['max-steps']),
        sessionId: str(values['session']),
        jobId: str(values['reconnect']),
        approvalTicket: str(values['approval-ticket']),
      };
      Object.keys(input).forEach((k) => input[k] === undefined && delete input[k]);
      return runStream(
        client,
        (t) => client.streamRun({ ...(input as any), approvalTicket: t ?? input.approvalTicket }, {}),
        { json, waitApproval: bool(values['wait-approval']), pollTimeoutMs: num(values['poll-timeout']) ?? 120_000 }
      );
    }
    case 'verify': {
      return runStream(client, () => client.streamVerify({}), {
        json, waitApproval: false, pollTimeoutMs: 120_000,
      });
    }
    case 'env': {
      const action = (str(values['action']) ?? 'create') as 'create' | 'destroy';
      const input: Record<string, unknown> = {
        action,
        branch: str(values['branch']),
        ttl_hours: num(values['ttl']),
        region: str(values['region']),
        owner: str(values['owner']),
        env_id: str(values['env-id']),
      };
      Object.keys(input).forEach((k) => input[k] === undefined && delete input[k]);
      return runStream(
        client,
        (t) => client.streamEnv({ ...(input as any), approvalTicket: t }, {}),
        { json, waitApproval: bool(values['wait-approval']), pollTimeoutMs: num(values['poll-timeout']) ?? 120_000 }
      );
    }
    case 'mcp': {
      if (sub === 'list') {
        const { servers } = await client.getMcpServers();
        json ? jsonOut(servers) : servers.forEach((s) => out(`${c('cyan', s.name)} ${s.status} tools=${s.toolCount}`));
        return 0;
      }
      if (sub === 'add') {
        const r = await client.addMcpServer({
          name: str(values['name']),
          url: str(values['url']),
          serverUrl: str(values['server-url']),
          command: str(values['command']),
          headers: str(values['headers']) ? JSON.parse(str(values['headers'])!) : undefined,
        } as any);
        json ? jsonOut(r) : out(c('green', `已添加 ${r.server.name}`));
        return 0;
      }
      if (sub === 'preset') {
        const r = await client.connectMcpPreset(str(values['id']) ?? '', str(values['mcp-token']));
        json ? jsonOut(r) : out(c('green', `已接入预设 ${r.server.name}`));
        return 0;
      }
      err(c('red', '用法: ah mcp list|add|preset ...')); return 1;
    }
    case 'approvals': {
      if (sub === 'list') {
        const { tickets } = await client.listApprovals(str(values['status']) as any);
        json ? jsonOut(tickets) : tickets.forEach((t) => out(`${c('yellow', t.id)} ${t.action} ${t.status}`));
        return 0;
      }
      if (sub === 'decide') {
        const id = str(values['id']);
        const decision = str(values['decision']) as 'approve' | 'reject';
        if (!id || !decision) { err(c('red', '需 --id 与 --decision approve|reject')); return 1; }
        const r = await client.decideApproval(id, decision, str(values['by']) ?? 'cli');
        json ? jsonOut(r) : out(c('green', `工单 ${r.ticket.id} → ${r.ticket.status}`));
        return 0;
      }
      err(c('red', '用法: ah approvals list|decide ...')); return 1;
    }
    case 'recipes': {
      if (sub === 'list') {
        const { recipes } = await client.listRecipes();
        json ? jsonOut(recipes) : recipes.forEach((r) => out(`${c('cyan', r.id)} ${r.name}`));
        return 0;
      }
      if (sub === 'save') {
        const r = await client.saveRecipe({ jobId: str(values['job']) ?? '', name: str(values['recipe-name']) });
        json ? jsonOut(r) : out(c('green', `已保存配方 ${r.recipe.id}`));
        return 0;
      }
      err(c('red', '用法: ah recipes list|save ...')); return 1;
    }
    case 'eval': {
      const jobId = str(values['job']);
      if (!jobId) { err(c('red', '需 --job JOBID')); return 1; }
      const r = await client.evalJob(jobId);
      json ? jsonOut(r) : out(JSON.stringify(r, null, 2));
      return 0;
    }
    case 'memory': {
      const key = str(values['session']);
      if (!key) { err(c('red', '需 --session KEY')); return 1; }
      if (sub === 'get') {
        const r = await client.getMemory(key);
        json ? jsonOut(r) : out(JSON.stringify(r, null, 2)); return 0;
      }
      if (sub === 'clear') {
        const r = await client.clearMemory(key);
        json ? jsonOut(r) : out(c('green', `已清空 ${r.sessionKey}`)); return 0;
      }
      err(c('red', '用法: ah memory get|clear --session KEY')); return 1;
    }
    default:
      err(c('red', `未知命令: ${cmd ?? '(空)'}`));
      out(HELP);
      return 1;
  }
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((e) => { err(c('red', `致命错误: ${(e as Error).message}`)); process.exitCode = 1; });

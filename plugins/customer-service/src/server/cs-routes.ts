import type { ServerExtension, PluginRouteHandler } from '@agent-harness/core';
import { markHandoff, recordSatisfaction, recordIntent } from '../store';

type Req = import('node:http').IncomingMessage;
type Res = import('node:http').ServerResponse;

/** 读取 JSON 请求体（无框架依赖，直连 node:http）。 */
function readJson(req: Req): Promise<any> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf-8')) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

function send(res: Res, code: number, obj: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

/** POST /api/plugins/customer-service/handoff —— 转人工 / 创建工单。 */
const handoff: PluginRouteHandler = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
  const body = await readJson(req);
  const sessionId = String(body.sessionId ?? 'anonymous');
  const reason = String(body.reason ?? '用户要求转人工');
  markHandoff(sessionId);
  if (body.intent) recordIntent(sessionId, String(body.intent));
  send(res, 200, { ok: true, handedOff: true, ticketId: `TK_${Date.now().toString(36)}`, reason });
};

/** POST /api/plugins/customer-service/satisfaction —— 记录满意度评分。 */
const satisfaction: PluginRouteHandler = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
  const body = await readJson(req);
  const sessionId = String(body.sessionId ?? 'anonymous');
  const score = Number(body.score ?? 0);
  recordSatisfaction(sessionId, score);
  send(res, 200, { ok: true, score });
};

/** POST /api/plugins/customer-service/intent —— 上报意图分类（供管理后台统计）。 */
const intent: PluginRouteHandler = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
  const body = await readJson(req);
  recordIntent(String(body.sessionId ?? 'anonymous'), String(body.intent ?? '其它'));
  send(res, 200, { ok: true });
};

/**
 * 客服插件服务端扩展：挂载三个 HTTP 路由。宿主（ServerPluginHost）把它们收敛到
 * 统一前缀 /api/plugins/customer-service/*，平台侧控制前缀与准入，插件只声明相对路径。
 */
export const csServerExtension: ServerExtension = {
  id: 'customer-service',
  mountRoutes: {
    '/handoff': handoff,
    '/satisfaction': satisfaction,
    '/intent': intent,
  },
};

/**
 * http-helpers：HTTP 传输层辅助（从 server.ts 单体拆出）。
 *
 * 收敛「请求体读取 + 响应写出」的纯传输逻辑：CORS 头解析、JSON 响应、
 * SSE 流封装、请求体读取（含 413/400 上限与 JSON 校验）。
 * 这些函数只依赖配置默认值（DEFAULTS，单一事实来源）与 node:http，不耦合 server 的
 * 鉴权 / 路由 / 业务常量，可独立测试与维护（见可维护性审计 P2：降低 server.ts 单体规模）。
 *
 * 注意：server.ts 自身仍保留一份 UI_CORS_ORIGIN / MAX_BODY_BYTES 副本用于启动期日志，
 * 两处均派生自 DEFAULTS，不存在配置漂移风险。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { DEFAULTS } from './config-defaults';

/** 恒定时间字符串比较，避免 CSRF state / token 比较泄漏时序差。长度不同直接拒。 */
export function safeEqualString(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// 本地派生（与 server.ts 同源 DEFAULTS）：避免对 server 模块常量的编译期耦合 / 循环依赖。
const UI_CORS_ORIGIN = (process.env.UI_CORS_ORIGIN ?? (DEFAULTS.UI_CORS_ORIGIN as string))
  .split(',')
  .map((s: string) => s.trim())
  .filter(Boolean);
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES ?? (DEFAULTS.MAX_BODY_BYTES as number));
const FORCE_HTTPS = (process.env.FORCE_HTTPS ?? '').toLowerCase();

/**
 * HTTP 安全响应头（P0.3 安全加固）。
 * 应用于所有 HTTP 响应，防浏览器端 XSS / 点击劫持 / 媒体类型嗅探 / 协议降级。
 * - CSP：宽松默认（'self'）+ 可选 UI_CSP_EXTEND 追加自定义指令。生产应锁定具体指令。
 * - HSTS：仅在 FORCE_HTTPS=on/1/true 时启用，避免本地 HTTP 被误伪装。
 * - X-Content-Type-Options: nosniff 始终设。
 * - X-Frame-Options: DENY 防点击劫持（CSP frame-ancestors 补充）。
 * - Referrer-Policy: strict-origin-when-cross-origin 防 Referer 泄露。
 * - Cross-Origin-* 头固化第三方隔离。
 */
export function securityHeaders(): Record<string, string> {
  const csp = ["default-src 'self'", "base-uri 'self'", "frame-ancestors 'none'"];
  const extend = process.env.UI_CSP_EXTEND;
  if (extend) {
    for (const part of extend.split(',')) {
      const t = part.trim();
      if (t) csp.push(t);
    }
  }
  const headers: Record<string, string> = {
    'content-security-policy': csp.join('; '),
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    // P1-5: require-corp 会阻断无 CORP 头的跨源资源（CDN 图片、第三方嵌入等）。
    // 改为 none，允许内部资源不经跨源检查；若后续引入第三方 iframe 资源，
    // 可通过 FORCE_HTTPS=on + 单独配 COEP 收紧。
    'cross-origin-embedder-policy': 'none',
  };
  if (FORCE_HTTPS === 'on' || FORCE_HTTPS === '1' || FORCE_HTTPS === 'true') {
    headers['strict-transport-security'] = 'max-age=31536000; includeSubDomains';
  }
  return headers;
}

/** 合并 CORS + 安全响应头到 writeHead 的 headers 参数。 */
export function safeHeaders(
  req: IncomingMessage,
  extra: Record<string, string> = {}
): Record<string, string> {
  return { ...securityHeaders(), ...corsHeaders(req), ...extra };
}

/** 依据配置解析本次响应应回的 CORS 头；未配置则返回空（仅同源）。 */
export function corsHeaders(req: IncomingMessage): Record<string, string> {
  const origin = req.headers.origin;
  if (!origin || UI_CORS_ORIGIN.length === 0) return {};
  if (UI_CORS_ORIGIN.includes('*')) {
    // P1-3: * 与凭证模式不共存——返回 * 时不加 credentials，避免缓存投毒风险。
    return {
      'access-control-allow-origin': '*',
      'vary': 'Origin',
    };
  }
  if (UI_CORS_ORIGIN.includes(origin))
    return { 'access-control-allow-origin': origin, 'vary': 'Origin' };
  return {};
}

export function sendJson(
  res: ServerResponse,
  obj: unknown,
  req?: IncomingMessage
): void {
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    ...safeHeaders(req ?? ({ headers: {} } as IncomingMessage))
  });
  res.end(JSON.stringify(obj));
}

/**
 * 判定一个错误是否为「流已结束/连接已断开」类的**良性**写入失败。
 *
 * 这类错误只说明「往一个已经关闭的响应/套接字写数据没写成」，不携带任何
 * 进程状态已损坏的语义 —— 属于客户端断连或 SSE 收尾竞态的正常产物。
 * crash-guard 据此白名单放行，避免单条 SSE 写入失败把整个服务打下线。
 */
export function isBenignStreamError(err: unknown): boolean {
  const e = err as { code?: string; name?: string; message?: string } | null;
  if (!e) return false;
  if (
    e.code === 'ERR_STREAM_WRITE_AFTER_END' ||
    e.code === 'ERR_STREAM_DESTROYED' ||
    e.code === 'ERR_STREAM_ALREADY_FINISHED' ||
    e.code === 'EPIPE' ||
    e.code === 'ECONNRESET' ||
    e.code === 'ERR_HTTP_HEADERS_SENT' ||
    e.name === 'ERR_STREAM_WRITE_AFTER_END'
  ) {
    return true;
  }
  // 部分运行时只给message 不给 code，用消息前缀兜底。
  return typeof e.message === 'string' && /write after end|stream (?:is )?destroyed/i.test(e.message);
}

export function startSse(
  res: ServerResponse,
  req?: IncomingMessage
): (obj: unknown) => void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    ...safeHeaders(req ?? ({ headers: {} } as IncomingMessage))
  });
  let closed = false;
  res.on('close', () => {
    closed = true;
  });
  // 关键兜底：ServerResponse 在 end() 之后被再次 write() 时**不抛同步异常**，
  // 而是异步 emit('error')。若无监听器，该 error 会冒泡成 uncaughtException，
  // 再被 crash-guard 的 process.exit(1) 升级为整进程退出 → 平台重启 → 全部
  // 在途请求 503（线上 SSE 长连接「跑一半就 503」的根因）。必须显式消费。
  res.on('error', () => {
    closed = true;
  });
  return (obj: unknown) =>
    writeSseFrame(res, `data: ${JSON.stringify(obj)}\n\n`, () => closed);
}

/**
 * SSE 帧写出（startSse 的 send 与 ping 心跳共用，保证守卫语义一致）。
 *
 * 三重守卫，缺一不可：
 * - `writableEnded`：**end() 已调用但 close 事件尚未异步派发**的窗口内，
 *   closed 仍为 false，仅靠 closed 会漏写并触发 ERR_STREAM_WRITE_AFTER_END；
 * - `destroyed`：底层套接字已被销毁；
 * - try/catch：兜住少数同步抛出的写入异常。
 *
 * 注意：try/catch 捕获不到异步 'error' 事件，故其不能替代 res.on('error')。
 *
 * @param frame 已格式化好的完整 SSE 帧（含结尾空行）。data 帧与注释心跳帧
 *              格式不同，故由调用方决定，不在此处拼装。
 */
export function writeSseFrame(
  res: ServerResponse,
  frame: string,
  isClosed: () => boolean
): void {
  if (isClosed()) return;
  if (res.writableEnded || res.destroyed) return;
  try {
    res.write(frame);
  } catch {
    /* 连接可能已关闭：静默丢弃该帧 */
  }
}

/**
 * SSE 收尾原语：统一「**先置 closed → 再清心跳 → 最后 end()**」的收尾顺序铁律。
 *
 * 为什么顺序不可变：
 * - `res.end()` 只是把结束写入内核队列，'close' 事件在**之后**才异步派发——该窗口内
 *   调用方闭包里的 closed 仍为 false，在途的 send / ping 会继续 write 到一个已结束的
 *   响应上，触发异步 ERR_STREAM_WRITE_AFTER_END（无监听器时冒泡 uncaughtException →
 *   crash-guard exit(1) → 平台重启 → 全部在途请求 503）。
 * - 先置 closed 能让 writeSseFrame 的三重守卫立即生效，挡住窗口期的全部写入。
 *
 * 端态判定：`writableEnded` / `destroyed` 已真时跳过 end()——幂等设计，重复收尾无害
 * （此前「end() 后又 end()」依赖 error 监听器消化 ERR_STREAM_ALREADY_FINISHED，
 * 现在从源头避免）。收尾本身的同步异常一并吞掉（连接已断属正常竞态）。
 *
 * @param markClosed 置位调用方闭包中的 closed 标志（每站点各持一份）
 * @param clearPing  可选：清理心跳定时器（引用归调用方持有，传闭包负责 clearInterval）
 */
export function endSse(
  res: ServerResponse,
  markClosed: () => void,
  clearPing?: () => void
): void {
  markClosed();
  clearPing?.();
  if (res.writableEnded || res.destroyed) return;
  try {
    res.end();
  } catch {
    /* 连接可能已断开：收尾失败无需处理 */
  }
}

/** 发送带安全头的JSON错误响应（P1-8：安全响应头全覆盖）。 */
export function sendJsonError(
  res: ServerResponse,
  status: number,
  obj: unknown,
  req?: IncomingMessage
): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    ...safeHeaders(req ?? ({ headers: {} } as IncomingMessage))
  });
  res.end(JSON.stringify(obj));
}

export async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    total += (c as Buffer).length;
    if (total > MAX_BODY_BYTES) {
      const err: any = new Error('request body too large');
      err.status = 413;
      throw err;
    }
    chunks.push(c as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf-8');
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    const err: any = new Error('invalid JSON body');
    err.status = 400;
    throw err;
  }
}

/**
 * 读取请求体的**原始字符串**（不做 JSON 解析）。
 *
 * 为什么单独提供：IM 桥接（飞书/钉钉/企业微信）的签名校验必须基于「原始字节」
 * 计算摘要，任何 JSON.parse + 重新序列化都会改变字节序（键顺序/空白），导致验签失败。
 * 同样适用于其它需要原文校验的 webhook 场景。
 */
export async function readRawBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    total += (c as Buffer).length;
    if (total > MAX_BODY_BYTES) {
      const err: any = new Error('request body too large');
      err.status = 413;
      throw err;
    }
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

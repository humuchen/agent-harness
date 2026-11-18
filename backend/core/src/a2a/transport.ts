/**
 * A2A 传输层（P1-④）。
 *
 * 解耦「派发一个 agent 任务」与「具体怎么执行」：
 * - `LocalA2ATransport`：进程内 handoff，回调由调用方注入的 `runner`（通常
 *   `assembleAgent(card)+harness.run`，server 端复用 /api/run 同款装配）。
 * - `HttpA2ATransport`：跨主机派发，向远端 agent 的 `POST /api/a2a/tasks` 投递
 *   TaskEnvelope，取回 TaskResult；带 SLA 超时主动 abort + 失败降级。
 *
 * 约定：所有传输都返回标准化的 `TaskResult`，调用方无需关心目标是本地还是远端。
 */

import type { AgentCard } from '../agents/types.js';
import type { TaskEnvelope, TaskResult } from './types.js';
import { resolveHostIsPrivate } from '../guardrails/egress.js';

// ---------------------------------------------------------------------------
// P0 SSRF 防护（a2a 出网私网判定）。
//
// 威胁面：TaskEnvelope.callback 与 HttpA2ATransport 的 baseUrl 此前不经任何
// 出网校验直接 POST——callback 来自外部信封（/api/a2a/tasks 对任意远端开放），
// baseUrl 可经远端自注册 AgentCard 注入，攻击者可诱导服务端把任务结果（可能含
// 敏感产出）投递到 169.254.169.254 云元数据 / 内网管理端点（SSRF 数据外带）。
//
// 口径（与 builtins/webfetch 的 resolveHostIsPrivate 同源，防 DNS rebinding）：
//   - 仅允许 http/https；
//   - 目标主机解析到私网/回环/链路本地段即拒绝（域名经 dns.lookup 全量展开）；
//   - 逃生舱：A2A_ALLOW_PRIVATE_NETWORK=true（内部 mesh / host.docker.internal
//     自组网部署显式放行，warn 留痕）。envelope.callback 属纯外部输入，
//     内部合法流程从不设置该字段，默认收紧对存量零回归。
// ---------------------------------------------------------------------------

/** A2A 出网校验选项（宿主可显式覆盖 env 缺省）。 */
export interface A2AEgressOptions {
  /** 允许私网/回环/链路本地目标；缺省读 env A2A_ALLOW_PRIVATE_NETWORK（默认拒绝）。 */
  allowPrivate?: boolean;
}

/** 解析 allowPrivate 最终值：显式 opts > env；env 未配置时一律拒绝私网。 */
function a2aAllowPrivate(opts?: A2AEgressOptions): boolean {
  if (opts && typeof opts.allowPrivate === 'boolean') return opts.allowPrivate;
  const raw = process.env.A2A_ALLOW_PRIVATE_NETWORK ?? '';
  if (raw.trim().toLowerCase() === 'true') {
    // eslint-disable-next-line no-console
    console.warn('[a2a] A2A_ALLOW_PRIVATE_NETWORK=true：A2A 派发/回调允许私网目标（仅限内部 mesh 部署使用）');
    return true;
  }
  return false;
}

/**
 * A2A 出网判定：返回 null 表示放行，否则为拒绝原因（供调用方落告警/错误文案）。
 * 仅校验协议与私网，不校验域名黑白名单（A2A 目标是配置态端点，非用户自由文本）。
 */
async function a2aEgressBlockReason(
  url: string,
  opts?: A2AEgressOptions
): Promise<string | null> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return `invalid URL: ${url.slice(0, 100)}`;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return `a2a egress denied to ${u.protocol}// (scheme not allowed)`;
  }
  if (a2aAllowPrivate(opts)) return null;
  if (await resolveHostIsPrivate(u.hostname)) {
    return `a2a egress denied to ${u.hostname} (private network; set A2A_ALLOW_PRIVATE_NETWORK=true for internal mesh)`;
  }
  return null;
}

/** 执行一个 agent 任务的回调（server 端注入：assembleAgent + harness.run）。 */
export type A2ARunner = (
  agentRef: string | AgentCard,
  input: unknown,
  meta: { tenantId?: string; traceId?: string; fromAgent?: string },
) => Promise<unknown>;

/** A2A 传输接口：把一个信封送到目标 agent 并返回结果。 */
export interface A2ATransport {
  send(envelope: TaskEnvelope): Promise<TaskResult>;
}

/** 进程内传输：直接回调注入的 runner（同进程多 agent 协同，零网络开销）。 */
export class LocalA2ATransport implements A2ATransport {
  constructor(
    private readonly runner: A2ARunner,
    private readonly egress?: A2AEgressOptions,
  ) {}

  async send(envelope: TaskEnvelope): Promise<TaskResult> {
    try {
      const output = await this.runner(envelope.toAgent, envelope.input, {
        tenantId: envelope.tenantId,
        traceId: envelope.traceId,
        fromAgent: envelope.fromAgent,
      });
      const result: TaskResult = { taskId: envelope.taskId, status: 'success', output };
      // 长期首片：信封带 callback 时异步回填结果（fire-and-forget，不阻塞派发方主流程）。
      deliverA2ACallback(envelope, result, fetch, this.egress).catch(() => {/* 已在 helper 内告警 */ });
      return result;
    } catch (e: any) {
      const result: TaskResult = { taskId: envelope.taskId, status: 'failed', error: e?.message ?? String(e) };
      deliverA2ACallback(envelope, result, fetch, this.egress).catch(() => {/* 已在 helper 内告警 */ });
      return result;
    }
  }
}

/**
 * 长期首片：A2A 异步回调投递 —— 此前 TaskEnvelope.callback 仅是声明字段，
 * 传输层从不消费，异步任务完成/失败后派发方无从获知。
 * 语义：任务终态时向 callback POST { taskId, status, output?, error?, traceId, fromAgent, toAgent }。
 * fire-and-forget：10s 超时、失败仅告警（重试/死信留宿主队列层），
 * 绝不影响任务结果本身（返回值已同步交给派发方）。
 */
export async function deliverA2ACallback(
  envelope: TaskEnvelope,
  result: TaskResult,
  fetchImpl: typeof fetch = fetch,
  egress?: A2AEgressOptions,
): Promise<boolean> {
  const url = envelope.callback;
  if (!url) return false;
  // P0 SSRF 防护：callback 是外部信封携带的任意 URL，投递前必须过私网判定。
  // 拦截语义与网络失败一致：warn 留痕 + return false，不影响任务结果本身。
  const blockReason = await a2aEgressBlockReason(url, egress);
  if (blockReason) {
    // eslint-disable-next-line no-console
    console.warn(`[a2a] callback 投递被出网防护拦截（不影响任务结果）：${blockReason}`);
    return false;
  }
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        taskId: result.taskId,
        status: result.status,
        ...(result.output !== undefined ? { output: result.output } : {}),
        ...(result.error !== undefined ? { error: result.error } : {}),
        ...(envelope.traceId ? { traceId: envelope.traceId } : {}),
        fromAgent: envelope.fromAgent,
        toAgent: envelope.toAgent,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      // eslint-disable-next-line no-console
      console.warn(`[a2a] callback 投递非 2xx：${res.status} → ${url}`);
      return false;
    }
    return true;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[a2a] callback 投递失败（不影响任务结果）：${e instanceof Error ? e.message : e} → ${url}`);
    return false;
  }
}

/** 跨主机传输：向远端 agent 的 /api/a2a/tasks 投递信封。fetch 可注入（测试用 mock）。 */
export class HttpA2ATransport implements A2ATransport {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly egress?: A2AEgressOptions,
  ) {}

  async send(envelope: TaskEnvelope): Promise<TaskResult> {
    // P0 SSRF 防护：baseUrl 可经远端自注册 AgentCard 注入，发起请求前先过私网判定。
    // 拦截语义与网络异常一致：映射为 TaskResult.failed（不向上抛），派发方按既有
    // 降级路径处理（run-queue 回退本地 harness），零新增异常面。
    const blockReason = await a2aEgressBlockReason(this.baseUrl, this.egress);
    if (blockReason) {
      // eslint-disable-next-line no-console
      console.warn(`[a2a] 派发被出网防护拦截：${blockReason}`);
      return {
        taskId: envelope.taskId,
        status: 'failed',
        error: blockReason,
      };
    }
    const controller = new AbortController();
    // P1 资源修复：SLA 超时 timer 此前既不 clearTimeout 也不 unref——请求成功后
    // 事件循环被空挂到 SLA 时刻；且 res.json() 无大小上限，异常远端可返回超大
    // JSON 直接进内存。
    const slaTimeout = envelope.sla?.timeoutMs && envelope.sla.timeoutMs > 0
      ? setTimeout(() => controller.abort(), envelope.sla.timeoutMs)
      : null;
    if (slaTimeout && typeof slaTimeout.unref === 'function') slaTimeout.unref();
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl.replace(/\/+$/, '')}/api/a2a/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ envelope }),
        signal: controller.signal,
      });
    } catch (e: any) {
      if (slaTimeout) clearTimeout(slaTimeout);
      return {
        taskId: envelope.taskId,
        status: 'failed',
        error: `a2a transport error: ${e?.message ?? String(e)}`,
      };
    }
    if (slaTimeout) clearTimeout(slaTimeout);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return {
        taskId: envelope.taskId,
        status: 'failed',
        error: `remote ${res.status}: ${text.slice(0, 200)}`,
      };
    }
    // 响应体上限（与 webfetch readBodyCapped 同思路）：流式读取并截断到 2MB。
    const reader = res.body?.getReader();
    let jsonText: string;
    if (reader) {
      const dec = new TextDecoder();
      const chunks: string[] = [];
      let received = 0;
      const budget = 2 * 1024 * 1024;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          const remain = budget - received;
          const take = value.subarray(0, Math.max(remain, 0));
          chunks.push(dec.decode(take, { stream: true }));
          received += take.byteLength;
          if (value.byteLength > remain) {
            try { await reader.cancel(); } catch { /* 忽略 */ }
            return {
              taskId: envelope.taskId,
              status: 'failed',
              error: `a2a response too large (> ${budget} bytes)`,
            };
          }
        }
      } finally {
        try { await reader.cancel(); } catch { /* 已结束则忽略 */ }
      }
      jsonText = chunks.join('') + dec.decode();
    } else if (typeof (res as { text?: unknown }).text === 'function') {
      jsonText = await res.text();
    } else {
      // 兼容测试 mock / 非标准 Response：仅有 json() 时退化。
      jsonText = JSON.stringify(await res.json());
    }
    let data: { result?: TaskResult; error?: string } | TaskResult | null;
    try {
      data = JSON.parse(jsonText) as
        | { result?: TaskResult; error?: string }
        | TaskResult
        | null;
    } catch {
      data = null;
    }
    if (!data) {
      return { taskId: envelope.taskId, status: 'failed', error: 'empty a2a response' };
    }
    // 兼容 `{ result: TaskResult }` 与裸 `TaskResult` 两种返回形态。
    if ('result' in data && data.result) return data.result;
    if ('error' in data && data.error && !('status' in data)) {
      return { taskId: envelope.taskId, status: 'failed', error: data.error };
    }
    return data as TaskResult;
  }
}

/** 依据 AgentCard 选择传输：a2a + endpoint → HTTP；其余 → 进程内 local runner。 */
export function transportFor(
  card: AgentCard,
  localRunner: A2ARunner,
  fetchImpl?: typeof fetch,
  egress?: A2AEgressOptions,
): A2ATransport {
  if (card.transport === 'a2a' && card.endpoint) {
    return new HttpA2ATransport(card.endpoint, fetchImpl, egress);
  }
  return new LocalA2ATransport(localRunner, egress);
}

/**
 * 一键派发：按目标 agent 的传输方式把信封送到本地或远端，返回标准 TaskResult。
 * 这是 router / run-queue 调用 A2A 的统一入口（核心只做编排，执行由注入的 runner 承担）。
 */
export async function dispatchAgentTask(
  card: AgentCard,
  envelope: TaskEnvelope,
  localRunner: A2ARunner,
  fetchImpl?: typeof fetch,
  egress?: A2AEgressOptions,
): Promise<TaskResult> {
  return transportFor(card, localRunner, fetchImpl, egress).send(envelope);
}

/**
 * 订单/售后服务：对接外部订单系统（fail-closed）。
 * 已配置 CS_ORDER_BASE_URL 时走真实 REST（Bearer token + 超时 + 重试）；
 * 未配置 / 调用失败一律返回结构化错误，绝不伪造订单数据。
 */
import { getConfig } from '../config';
import { notConfiguredResult } from '../infra/errors';

export interface OrderQueryResult {
  orderNo: string;
  status: string;
  logistics?: string;
  refundable?: boolean;
  warranty?: string;
}

export type OrderQueryFailure =
  | { error: true; code: 'NOT_CONFIGURED'; message: string }
  | { error: true; code: 'INVALID_ARGUMENT'; message: string }
  | { error: true; code: 'UPSTREAM_ERROR'; message: string };

export type OrderQueryOutcome = OrderQueryResult | OrderQueryFailure;

/** 可重试的临时性失败（网络错误 / 5xx / 408 超时 / 429 限流）。 */
function isRetryable(status: number | undefined, err?: unknown): boolean {
  if (err) return true; // fetch 抛错（DNS/连接被拒/中止）视为可重试
  if (status === undefined) return true;
  return status === 408 || status === 429 || status >= 500;
}

/** 重试退避：150ms * 2^(attempt-1)，封顶 1s。 */
function backoffMs(attempt: number): number {
  return Math.min(150 * Math.pow(2, attempt - 1), 1000);
}

/** 把上游 JSON 归一化为 OrderQueryResult；字段缺失/类型不符时容错，orderNo 缺失视为脏数据。 */
function normalizeOrder(data: Record<string, unknown>): OrderQueryResult | null {
  const orderNo = data.orderNo != null ? String(data.orderNo) : '';
  if (!orderNo) return null;
  return {
    orderNo,
    status: data.status != null ? String(data.status) : 'unknown',
    ...(data.logistics != null ? { logistics: String(data.logistics) } : {}),
    ...(data.refundable != null ? { refundable: Boolean(data.refundable) } : {}),
    ...(data.warranty != null ? { warranty: String(data.warranty) } : {}),
  };
}

/**
 * 查询订单/售后（真实 REST 客户端，Node 全局 fetch，零外部依赖）。
 * - 参数校验：orderNo 必填且非空。
 * - 上游未配置：fail-closed 返回 NOT_CONFIGURED。
 * - 已配置：GET {baseUrl}/orders/{orderNo}，带 Bearer token（若配置），
 *   AbortSignal.timeout 限时，网络/5xx/408/429 自动重试（最多 cfg.order.retries 次）。
 * - 一切失败返回结构化 error，绝不抛出未捕获异常。
 */
export async function queryOrder(input: { orderNo: string }): Promise<OrderQueryOutcome> {
  const orderNo = typeof input?.orderNo === 'string' ? input.orderNo.trim() : '';
  if (!orderNo) {
    return { error: true, code: 'INVALID_ARGUMENT', message: 'orderNo 必填且不能为空' };
  }
  const cfg = getConfig();
  if (!cfg.order.enabled || !cfg.order.baseUrl) {
    return notConfiguredResult('cs_order_query');
  }

  const url = `${cfg.order.baseUrl}/orders/${encodeURIComponent(orderNo)}`;
  const headers: Record<string, string> = { accept: 'application/json' };
  if (cfg.order.token) headers.authorization = `Bearer ${cfg.order.token}`;

  const attempts = Math.max(cfg.order.retries + 1, 1);
  let lastMsg = '';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(cfg.order.timeoutMs),
      });
      if (res.status === 404) {
        return {
          error: true,
          code: 'UPSTREAM_ERROR',
          message: `订单不存在：${orderNo}（上游 404）`,
        };
      }
      if (!res.ok) {
        lastMsg = `上游返回 ${res.status} ${res.statusText}`;
        if (!isRetryable(res.status)) {
          return { error: true, code: 'UPSTREAM_ERROR', message: `订单查询失败：${lastMsg}` };
        }
        if (attempt < attempts) {
          await new Promise((r) => setTimeout(r, backoffMs(attempt)));
          continue;
        }
        return { error: true, code: 'UPSTREAM_ERROR', message: `订单查询失败：${lastMsg}` };
      }
      const raw: unknown = await res.json();
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return { error: true, code: 'UPSTREAM_ERROR', message: '上游响应格式非法（非对象）' };
      }
      const normalized = normalizeOrder(raw as Record<string, unknown>);
      if (!normalized) {
        return { error: true, code: 'UPSTREAM_ERROR', message: '上游响应缺少 orderNo 字段' };
      }
      return normalized;
    } catch (e) {
      lastMsg = e instanceof Error ? e.message : String(e);
      if (attempt < attempts && isRetryable(undefined, e)) {
        await new Promise((r) => setTimeout(r, backoffMs(attempt)));
        continue;
      }
      return { error: true, code: 'UPSTREAM_ERROR', message: `订单查询失败：${lastMsg}` };
    }
  }
  // 理论不可达（循环内必 return），兜底防静态分析 complain。
  return { error: true, code: 'UPSTREAM_ERROR', message: '订单查询失败' };
}

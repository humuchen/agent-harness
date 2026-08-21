/**
 * 订单/售后服务：对接外部订单系统（fail-closed）。
 * 未配置上游时返回 NOT_CONFIGURED，绝不伪造订单数据。
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

/**
 * 查询订单/售后。上游未配置则 fail-closed。
 * 真实实现：对 CS_ORDER_BASE_URL 发 REST（带 Bearer token + 重试），
 * 此处保留契约与 fail-closed 行为，真实 REST 客户端留待对接期填充。
 */
export function queryOrder(input: { orderNo: string }): OrderQueryResult | { error: true; code: 'NOT_CONFIGURED'; message: string } {
  const cfg = getConfig();
  if (!cfg.order.enabled) {
    return notConfiguredResult('cs_order_query');
  }
  // TODO(对接期)：实现真实 REST 客户端后填充；目前返回接口占位结构。
  // 注意：不得在此返回假数据，未实现即视为未配置。
  return notConfiguredResult('cs_order_query');
}

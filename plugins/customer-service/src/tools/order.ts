import type { ToolRegistry } from '@agent-harness/core';
import { queryOrder } from '../services/order-service';

/**
 * cs_order_query：查询订单/售后（物流/退款/保修）。
 * 上游未配置时 fail-closed 返回 NOT_CONFIGURED，绝不伪造订单数据。
 */
export function registerOrderTools(tools: ToolRegistry): void {
  tools.register(
    'cs_order_query',
    '查询客户订单/售后状态（物流、退款、保修）。订单系统未接入时如实告知不可用，不编造。',
    {
      type: 'object',
      properties: {
        orderNo: { type: 'string', description: '订单号' },
      },
      required: ['orderNo'],
    },
    async (args: Record<string, unknown>) => {
      return queryOrder({ orderNo: String(args.orderNo ?? '') });
    }
  );
}

import type { ToolRegistry } from '@agent-harness/core';
import { captureLead } from '../services/lead-service';
import { errorResult } from '../infra/errors';

/**
 * lead_capture：在用户明确授权后留资（微信/手机号/姓名），推进到 captured 阶段（真实落库）。
 * 合规：必须用户主动提供或同意，不在未授权时索要隐私；未授权/无联系方式均据实报错。
 */
export function registerCaptureTool(tools: ToolRegistry): void {
  tools.register(
    'lead_capture',
    '在用户明确同意/主动提供联系方式后，记录其微信/手机号/姓名，推进到 captured 阶段（真实落库，并异步同步 CRM）。',
    {
      type: 'object',
      properties: {
        leadId: { type: 'string', description: '客资 id' },
        wechat: { type: 'string', description: '微信（用户已授权）' },
        phone: { type: 'string', description: '手机号（用户已授权）' },
        name: { type: 'string', description: '称呼/姓名（用户已授权）' },
        consent: { type: 'boolean', description: '是否已获用户授权收集该信息' },
      },
      required: ['leadId', 'consent'],
    },
    async (args: Record<string, unknown>) => {
      try {
        return await captureLead({
          leadId: String(args.leadId ?? ''),
          consent: args.consent === true || args.consent === 'true',
          wechat: args.wechat ? String(args.wechat) : undefined,
          phone: args.phone ? String(args.phone) : undefined,
          name: args.name ? String(args.name) : undefined,
        });
      } catch (e) {
        return errorResult(e);
      }
    }
  );
}

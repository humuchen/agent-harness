import type { ToolRegistry } from '@agent-harness/core';
import { captureLead } from '../store';

/**
 * lead_capture：在用户明确授权/主动提供后留资（微信/手机号/姓名），推进到 captured 阶段。
 * 合规前置：必须 consent=true，否则返回 needConsent，避免未授权收集隐私（个保法）。
 */
export function registerCaptureTool(tools: ToolRegistry): void {
  tools.register(
    'lead_capture',
    '在用户主动提供或明确同意收集联系方式后，记录其微信/手机号/姓名，推进到 captured 阶段。',
    {
      type: 'object',
      properties: {
        leadId: { type: 'string', description: '客资 id' },
        wechat: { type: 'string', description: '微信号（用户已授权）' },
        phone: { type: 'string', description: '手机号（用户已授权）' },
        name: { type: 'string', description: '称呼 / 姓名（用户已授权）' },
        consent: { type: 'boolean', description: '是否已获用户授权收集该信息' },
      },
      required: ['leadId'],
    },
    async (args: Record<string, unknown>) => {
      const leadId = String(args.leadId ?? '').trim();
      if (!leadId) return { ok: false, error: 'leadId required' };
      const consent = args.consent === true || args.consent === 'true';
      if (!consent) {
        return { ok: false, needConsent: true, message: '请在用户主动提供或明确同意后再留资' };
      }
      const wechat = args.wechat ? String(args.wechat) : undefined;
      const phone = args.phone ? String(args.phone) : undefined;
      const name = args.name ? String(args.name) : undefined;
      if (!wechat && !phone && !name) {
        return { ok: false, error: '至少提供一项联系方式' };
      }
      captureLead(leadId, { wechat, phone, name });
      return { ok: true, leadId, stage: 'captured', captured: { wechat, phone, name } };
    }
  );
}

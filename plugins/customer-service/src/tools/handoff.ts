import type { ToolRegistry } from '@agent-harness/core';
import { handoff as handoffSession } from '../services/session-service';
import { getPluginContext } from '../runtime';
import { errorResult } from '../infra/errors';

/**
 * cs_handoff：转接人工坐席。将当前会话状态置为 handoff，
 * 并通过 A2A 触发人工坐席 agent（若上游已配置 AGENT_A2A_BASE_URL）。
 */
export function registerHandoffTool(tools: ToolRegistry): void {
  tools.register(
    'cs_handoff',
    '将当前会话转接人工坐席：标记会话为 handoff，并（若已配置）经 A2A 通知人工坐席接管。',
    {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '当前会话 id' },
        reason: { type: 'string', description: '转人工原因（可选）' },
      },
      required: ['sessionId'],
    },
    async (args: Record<string, unknown>) => {
      try {
        const sessionId = String(args.sessionId ?? '');
        const sess = handoffSession({ sessionId });
        // 经 A2A 通知人工坐席（可选；未配置则仅更新本地状态）。
        const ctx = getPluginContext();
        if (ctx?.a2a) {
          try {
            await ctx.a2a.send({
              type: 'task',
              taskId: `handoff-${sessionId}`,
              agentId: 'human-agent',
              input: { sessionId, reason: args.reason ?? 'customer requested handoff' },
              replyTo: undefined,
            } as never);
          } catch {
            /* A2A 失败不影响本地转接标记 */
          }
        }
        return { sessionId, status: sess?.status ?? 'handoff', handedOff: true };
      } catch (e) {
        return errorResult(e);
      }
    }
  );
}

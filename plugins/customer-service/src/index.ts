import type { PluginModule, PluginContext } from '@agent-harness/core';
import { csManifest } from './manifest';
import { registerTicketTools } from './tools/ticket';
import { registerKbTools } from './tools/kb';
import { registerOrderTools } from './tools/order';
import { registerHandoffTool } from './tools/handoff';
import { csServerExtension } from './server/routes';
import { csDashboardView } from './web/dashboard';
import { setPluginContext } from './runtime';
import { getDb } from './infra/db';
import { configSummary } from './config';
import { insertReminders } from './repo/reminder-repo';
import { csRemindersTriggerPlugin } from './plugins/reminders-trigger';

/** 事件订阅注销句柄（onUnload 时对称清理）。 */
let offEvents: (() => void) | undefined;
/** 对话记录事件订阅注销句柄。 */
let offTranscript: (() => void) | undefined;
/** 分析完成事件订阅注销句柄。 */
let offAnalysis: (() => void) | undefined;

/**
 * 解析 agent 分析输出的 JSON。
 * 输出格式：{ type: "reminder.inactive_lead", generatedAt: number, items: [...] }
 */
function parseAnalysisOutput(finalText: string): {
  type: string;
  generatedAt: number;
  items: Array<{
    leadId: string;
    name?: string | null;
    phone?: string | null;
    project?: string | null;
    lastVisit?: string | null;
    daysSince?: number | null;
    activityTitle?: string | null;
    activityId?: string | null;
  }>;
} | null {
  if (!finalText || !finalText.trim()) return null;
  // 尝试提取 JSON（可能包裹在 ```json ... ``` 中）
  const text = finalText.trim();
  let jsonStr = text;
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch?.[1]) {
    jsonStr = fenceMatch[1].trim();
  }
  try {
    const parsed = JSON.parse(jsonStr);
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.items)) {
      return parsed;
    }
  } catch {
    // 解析失败
  }
  return null;
}

/** 提醒触发器上下文（用于 onStop 清理）。 */
let _reminderCtx: PluginContext | null = null;

/**
 * 智能客服插件模块（PluginModule 主入口）。
 * 只通过 PluginContext 调用 core 已导出的公共 API，不 import / 修改 core 源码。
 *
 * 真实数据链路：
 * 工具(cs_ticket_create 等) → services 层 → repo 层(参数化 SQL, node:sqlite)。
 * 渠道入口预留：webhook → 验签落库 → A2A 触发本 agent → 工具 → 真实库。
 */
export const csPlugin: PluginModule = {
  manifest: csManifest,

  async setup(ctx: PluginContext): Promise<void> {
    // 捕获 ctx 供 routes(webhook) 经 ctx.a2a 触发 agent
    setPluginContext(ctx);

    // 1) 注册工具（loader 启用时自动加 customer-service__ 前缀合并进进程共享插件工具表）
    registerTicketTools(ctx.tools);
    registerKbTools(ctx.tools);
    registerOrderTools(ctx.tools);
    registerHandoffTool(ctx.tools);

    // 2) 注册服务端扩展：统计 / 工单 / 知识库（前缀 /api/plugins/customer-service/*）
    ctx.server?.registerExtension(csServerExtension);

    // 3) 注册前端客服看板视图（webapp 动态渲染为「客服看板」Tab）
    ctx.web?.registerView(csDashboardView);

    // 4) 订阅核心事件（示例：把 cs.* 事件落日志）
    offEvents = ctx.events.on((e) => {
      if (String(e.type).startsWith('cs.')) ctx.logger.info('cs event', { type: e.type });
    });

    // 5) 订阅分析完成事件 → 解析 JSON → 写入 cs_reminder 表
    offAnalysis = ctx.events.on((e) => {
      if (e.type !== 'cs:reminder:analysis_complete') return;
      const finalText = (e as unknown as { finalText?: string }).finalText;
      const slot = (e as unknown as { slot?: number }).slot;
      if (!finalText) return;
      const parsed = parseAnalysisOutput(finalText);
      if (!parsed || parsed.items.length === 0) {
        ctx.logger.info('cs-reminders: analysis returned no items', { slot });
        return;
      }
      try {
        const count = insertReminders(parsed.items.map((item) => ({
          ...item,
          sourceSlot: slot ?? null,
        })));
        ctx.logger.info('cs-reminders: reminders inserted', { slot, count });
      } catch (err) {
        ctx.logger.warn('cs-reminders: insert failed', { error: String(err) });
      }
    });

    // 6) 懒初始化 DB（首次访问时建表），确保插件启用后即可落库。
    try {
      getDb();
    } catch (e) {
      ctx.logger.warn('customer-service db init failed', { error: String(e) });
    }

    ctx.logger.info('customer-service plugin setup complete', { config: configSummary() });
  },

  async onStart(ctx: PluginContext): Promise<void> {
    ctx.logger.info('customer-service plugin started');
    // 启动客服提醒定时触发器（复用 trigger 插件的 onStart）
    _reminderCtx = ctx;
    await csRemindersTriggerPlugin.onStart?.(ctx);
  },

  async onStop(ctx: PluginContext): Promise<void> {
    // 停止客服提醒定时触发器
    await csRemindersTriggerPlugin.onStop?.(ctx);
    _reminderCtx = null;
    // 不在此关闭 DB：getDbAdapter 是进程级单例（按 backend:file 缓存），
    // 停用插件只是「禁用」而非「关闭进程数据库」，关闭会波及其它仍有效的插件请求，
    // 且单例缓存仍持有已关闭实例导致后续无法复用。进程的数据库连接在进程退出时统一回收。
    ctx.logger.info('customer-service plugin stopped');
  },

  async onUnload(ctx: PluginContext): Promise<void> {
    await csRemindersTriggerPlugin.onUnload?.(ctx);
    offEvents?.();
    offEvents = undefined;
    offTranscript?.();
    offTranscript = undefined;
    offAnalysis?.();
    offAnalysis = undefined;
    _reminderCtx = null;
    setPluginContext({} as PluginContext);
    ctx.logger.info('customer-service plugin unloaded');
  },
};

export default csPlugin;

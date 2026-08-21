/**
 * 前端客服看板视图（webapp 动态渲染为「客服看板」Tab）。
 * 返回可直接注入内容区的 HTML 字符串（无框架耦合）。
 */
import type { PluginUIView } from '@agent-harness/core';
import { listTickets } from '../repo/ticket-repo';
import { listSessions } from '../repo/session-repo';

export const csDashboardView: PluginUIView = {
  tabId: 'customer-service',
  label: '客服看板',
  render(): string {
    const tickets = listTickets(undefined, 50);
    const sessions = listSessions(50);
    const open = tickets.filter((t) => t.status === 'open').length;
    const handoff = sessions.filter((s) => s.status === 'handoff').length;
    const rows = tickets
      .map(
        (t) =>
          `<tr><td>${t.ticketId}</td><td>${escapeHtml(t.subject)}</td><td>${t.priority}</td><td>${t.status}</td><td>${t.assignee ?? '-'}</td></tr>`
      )
      .join('');

    return `
      <section class="cs-dashboard">
        <h2>智能客服看板</h2>
        <div class="cs-metrics">
          <span>工单总数：<b>${tickets.length}</b></span>
          <span>待处理：<b>${open}</b></span>
          <span>转人工会话：<b>${handoff}</b></span>
          <span>会话总数：<b>${sessions.length}</b></span>
        </div>
        <table class="cs-table">
          <thead><tr><th>工单号</th><th>主题</th><th>优先级</th><th>状态</th><th>处理人</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="5">暂无工单</td></tr>'}</tbody>
        </table>
      </section>`;
  },
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string
  );
}

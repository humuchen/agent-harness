/**
 * 前端客服看板视图（webapp 动态渲染为「客服看板」Tab）。
 * 返回可直接注入内容区的 HTML 字符串（无框架耦合）。
 *
 * 样式遵循 --ah-* 语义令牌，与插件管理台 / 客资看板视觉一致：
 *   - 卡片容器 + 圆角面板 + 指标卡片行 + 规范表格 + 状态/优先级色标 + 药丸按钮。
 */
import type { PluginUIView } from '@agent-harness/core';
import { listTickets } from '../repo/ticket-repo';
import { listSessions } from '../repo/session-repo';
import { listPendingReminders } from '../repo/reminder-repo';

/** HTML 转义。 */
function esc(s: unknown): string {
  return String(s ?? '').replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string
  );
}

/** 优先级 → 色标与中文标签。 */
const PRIORITY_MAP: Record<string, { label: string; color: string }> = {
  critical: { label: '紧急', color: '#E8684A' },
  high: { label: '高', color: '#F6BD16' },
  medium: { label: '中', color: '#5B8FF9' },
  low: { label: '低', color: '#5D7092' }
};

/** 工单状态 → 色标与中文标签。 */
const STATUS_MAP: Record<string, { label: string; color: string }> = {
  open: { label: '待处理', color: '#F6BD16' },
  in_progress: { label: '处理中', color: '#5B8FF9' },
  resolved: { label: '已解决', color: '#5AD8A6' },
  closed: { label: '已关闭', color: '#5D7092' }
};

export const csDashboardView: PluginUIView = {
  tabId: 'customer-service',
  label: '客服看板',
  render(): string | Promise<string> {
    return (async () => {
      const tickets = await Promise.resolve(listTickets(undefined, 50));
      const sessions = await Promise.resolve(listSessions(50));
      const reminders = await Promise.resolve(listPendingReminders(20));
      const open = tickets.filter((t) => t.status === 'open').length;
      const handoff = sessions.filter((s) => s.status === 'handoff').length;
      const resolved = tickets.filter((t) => t.status === 'resolved').length;

      const cards = [
        { k: '工单总数', v: String(tickets.length) },
        { k: '待处理', v: String(open), highlight: open > 0 },
        { k: '已解决', v: String(resolved) },
        { k: '转人工会话', v: String(handoff) },
        { k: '会话总数', v: String(sessions.length) },
        { k: '待提醒', v: String(reminders.length), highlight: reminders.length > 0 },
      ]
        .map(
          (c) =>
            `<div class="cs-card${c.highlight ? ' cs-card-warn' : ''}"><div class="cs-card-v">${esc(c.v)}</div><div class="cs-card-k">${esc(c.k)}</div></div>`
        )
        .join('');

      const rows = tickets
        .map((t) => {
          const pri = PRIORITY_MAP[t.priority] ?? { label: t.priority, color: '#5D7092' };
          const st = STATUS_MAP[t.status] ?? { label: t.status, color: '#5D7092' };
          return `<tr>
            <td><code>${esc(t.ticketId)}</code></td>
            <td>${esc(t.subject)}</td>
            <td><span class="cs-badge" style="background:${pri.color}20;color:${pri.color}">${esc(pri.label)}</span></td>
            <td><span class="cs-badge" style="background:${st.color}20;color:${st.color}">${esc(st.label)}</span></td>
            <td>${esc(t.assignee ?? '-')}</td>
          </tr>`;
        })
        .join('');

      return `
      <div class="cs-dash">
        <h2>智能客服 · 客服看板</h2>
        <div class="cs-cards">${cards}</div>

        <section class="cs-panel">
          <h3>工单列表</h3>
          <div class="cs-table-wrap">
            <table class="cs-table">
              <thead><tr><th>工单号</th><th>主题</th><th>优先级</th><th>状态</th><th>处理人</th></tr></thead>
              <tbody>${rows || '<tr><td colspan="5">暂无工单</td></tr>'}</tbody>
            </table>
          </div>
        </section>

        ${reminders.length > 0 ? `
        <section class="cs-panel" style="margin-top:16px;border-color:var(--ah-accent);">
          <h3>📋 待提醒客户 <small style="color:var(--ah-text-muted);font-weight:400;">(agent 自动分析)</small></h3>
          <div class="cs-table-wrap">
            <table class="cs-table">
              <thead><tr><th>客户</th><th>项目</th><th>距上次到院</th><th>关联活动</th><th>操作</th></tr></thead>
              <tbody>
                ${reminders.map((r) => `<tr>
                  <td>${esc(r.name ?? r.leadId)}</td>
                  <td>${esc(r.project ?? '-')}</td>
                  <td>${r.daysSince != null ? `<strong style="color:var(--ah-accent)">${r.daysSince} 天</strong>` : '-'}</td>
                  <td>${esc(r.activityTitle ?? '-')}</td>
                  <td>
                    <button class="cs-btn" data-id="${esc(r.id)}" data-action="reminded" onclick="window.handleReminder(this)">已提醒</button>
                    <button class="cs-btn cs-btn-ghost" data-id="${esc(r.id)}" data-action="ignored" onclick="window.handleReminder(this)">忽略</button>
                  </td>
                </tr>`).join('')}
              </tbody>
            </table>
          </div>
        </section>
        ` : ''}

        <style>
          .cs-dash, .cs-dash * { box-sizing:border-box; }
          .cs-dash { color: var(--ah-text); font-family: var(--ah-font-sans); }
          .cs-dash h2 { font-size:18px; margin:0 0 12px; }
          .cs-dash h3 { font-size:14px; margin:0 0 10px; color: var(--ah-text-muted); font-weight:600; }

          /* 指标卡片行 */
          .cs-cards { display:flex; flex-wrap:wrap; gap:10px; margin-bottom:16px; }
          .cs-card { background: var(--ah-surface-1); border:1px solid var(--ah-border); border-radius:10px; padding:10px 14px; min-width:96px; flex:1 1 auto; }
          .cs-card.cs-card-warn { border-color: var(--ah-accent); box-shadow: 0 0 0 1px var(--ah-accent-alpha, rgba(41,151,255,.15)); }
          .cs-card-v { font-size:20px; font-weight:600; }
          .cs-card-k { font-size:12px; color: var(--ah-text-muted); margin-top:2px; }

          /* 面板容器（圆角卡片） */
          .cs-panel { background: var(--ah-surface-1); border:1px solid var(--ah-border); border-radius:12px; padding:14px; }

          /* 表格（对齐截图风格：暗底、细线分隔、色标徽章） */
          .cs-table-wrap { overflow-x:auto; -webkit-overflow-scrolling:touch; }
          .cs-table { width:100%; border-collapse:collapse; font-size:12px; min-width:100%; }
          .cs-table th, .cs-table td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--ah-border); vertical-align:top; white-space:nowrap; }
          .cs-table th { color: var(--ah-text-muted); font-weight:500; }
          .cs-table td { white-space:normal; }
          .cs-table code { background: var(--ah-surface-3); padding:1px 5px; border-radius:4px; font-size:11px; }

          /* 色标徽章（药丸形） */
          .cs-badge { display:inline-block; padding:2px 10px; border-radius:999px; font-size:11px; font-weight:500; line-height:1.6; }

          /* 操作按钮 */
          .cs-btn { background: var(--ah-accent); color: #fff; border: none; border-radius:6px; padding:4px 10px; font-size:11px; cursor:pointer; }
          .cs-btn:hover { opacity: 0.9; }
          .cs-btn-ghost { background: transparent; color: var(--ah-text-muted); border: 1px solid var(--ah-border); box-shadow: none; }

          @media (max-width: 600px) {
            .cs-dash h2 { font-size:16px; }
            .cs-card { padding:8px 12px; min-width:0; flex:0 0 calc(50% - 5px); }
            .cs-panel { padding:10px; }
            .cs-table th, .cs-table td { padding:6px 7px; font-size:11px; }
          }
          @media (max-width: 360px) {
            .cs-card { flex:0 0 100%; }
          }
        </style>

        <script>
          /** 处理提醒按钮点击（已提醒 / 忽略）。 */
          window.handleReminder = function(btn) {
            const id = btn.getAttribute('data-id');
            const action = btn.getAttribute('data-action');
            fetch('/api/plugins/customer-service/reminder', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ id, action })
            }).then(r => r.json()).then(() => {
              // 移除该行或刷新面板
              const tr = btn.closest('tr');
              if (tr) tr.remove();
            }).catch(() => {});
          };

          /** SSE 监听客服业务提醒（role=service）。 */
          (function() {
            const src = new EventSource('/api/events?role=service');
            src.addEventListener('cs:reminder:analysis_complete', function(e) {
              // 可播放音效或弹窗
              const evt = new CustomEvent('ah-cs-reminder', { detail: e.data });
              window.dispatchEvent(evt);
            });
          })();
        </script>
      </div>`;
    })();
  },
};

import type { PluginUIView } from '@agent-harness/core';
import { listRecords, satisfactionStats } from '../store';

/** HTML 转义，避免会话 id 等字段注入。 */
function esc(s: string): string {
  return s.replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string)
  );
}

/**
 * 客服管理后台视图（前端 Tab）。render() 在 server 侧被 /api/plugins 调用，实时反映
 * 进程内会话记录与满意度统计。webapp 仅把返回的 HTML 注入「客服后台」Tab，不感知任何业务语义。
 */
export const csAdminView: PluginUIView = {
  tabId: 'cs-admin',
  label: '客服后台',
  render(): string {
    const recs = listRecords();
    const stats = satisfactionStats();
    const avg = stats.avg == null ? '暂无' : stats.avg.toFixed(2);
    const rows = recs
      .slice(0, 50)
      .map(
        (r) => `<tr>
          <td>${esc(r.sessionId)}</td>
          <td>${esc(r.lastIntent ?? '-')}</td>
          <td>${r.handedOff ? '已转人工' : '自助'}</td>
          <td>${typeof r.satisfaction === 'number' ? r.satisfaction : '-'}</td>
          <td>${new Date(r.updatedAt).toLocaleString()}</td>
        </tr>`
      )
      .join('');
    return `<div class="cs-admin">
      <h2>智能客服 · 管理后台</h2>
      <div class="cs-stats">
        <span>会话总数：<b>${recs.length}</b></span>
        <span>已转人工：<b>${recs.filter((r) => r.handedOff).length}</b></span>
        <span>满意度评分：<b>${avg}</b>（${stats.count} 条）</span>
      </div>
      <table class="cs-table">
        <thead><tr><th>会话</th><th>意图</th><th>处理方式</th><th>满意度</th><th>更新时间</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="5">暂无数据</td></tr>'}</tbody>
      </table>
    </div>`;
  },
};

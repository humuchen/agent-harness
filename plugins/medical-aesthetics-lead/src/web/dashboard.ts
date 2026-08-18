import type { PluginUIView } from '@agent-harness/core';
import { computeStats, listLeads } from '../repo/lead-repo';
import { outboxSnapshot } from '../services/outbox-worker';
import { dbHealth } from '../infra/db';

/** HTML 转义，避免客资字段注入。 */
function esc(s: unknown): string {
  return String(s ?? '').replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string)
  );
}

/** 横向柱状图（SVG 字符串，服务端渲染）。 */
function barChart(items: { label: string; value: number }[], color = '#7F77DD'): string {
  const w = 460, rowH = 24, top = 4, labelW = 96, barX = labelW + 8;
  const max = Math.max(1, ...items.map((i) => i.value));
  const h = top * 2 + items.length * rowH;
  const bars = items
    .map((it, i) => {
      const y = top + i * rowH;
      const bw = Math.max(2, Math.round((it.value / max) * (w - barX - 42)));
      return `<g>
        <text x="0" y="${y + 15}" font-size="12" fill="#c9d1d9">${esc(it.label)}</text>
        <rect x="${barX}" y="${y + 4}" width="${bw}" height="15" rx="3" fill="${color}"/>
        <text x="${barX + bw + 6}" y="${y + 16}" font-size="12" fill="#8b949e">${it.value}</text>
      </g>`;
    })
    .join('');
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" preserveAspectRatio="xMinYMin meet" style="max-width:480px">${bars}</svg>`;
}

/** 转化漏斗（SVG 字符串，居中渐宽条形）。 */
function funnel(stages: { label: string; value: number }[]): string {
  const w = 480, rowH = 30, top = 6, cx = w / 2;
  const max = Math.max(1, ...stages.map((s) => s.value));
  const h = top * 2 + stages.length * rowH;
  const palette = ['#5B8FF9', '#5AD8A6', '#5D7092', '#F6BD16', '#E8684A', '#6DC8EC', '#9270CA'];
  const bars = stages
    .map((s, i) => {
      const y = top + i * rowH;
      const bw = Math.max(10, Math.round((s.value / max) * (w - 140)));
      const x = cx - bw / 2;
      return `<g>
        <rect x="${x}" y="${y + 4}" width="${bw}" height="20" rx="4" fill="${palette[i % palette.length]}"/>
        <text x="10" y="${y + 18}" font-size="12" fill="#c9d1d9">${esc(s.label)}</text>
        <text x="${w - 10}" y="${y + 18}" font-size="12" fill="#8b949e" text-anchor="end">${s.value}</text>
      </g>`;
    })
    .join('');
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" preserveAspectRatio="xMinYMin meet" style="max-width:520px">${bars}</svg>`;
}

/**
 * 客资看板视图（前端 Tab）。render() 在 server 侧被 /api/plugins 调用，实时反映真实库中的
 * 客资漏斗与队列（SQL 聚合），并展示 CRM/HIS 同步健康（发件箱状态）。
 */
export const leadDashboardView: PluginUIView = {
  tabId: 'ma-lead',
  label: '客资看板',
  render(): string {
    const stats = computeStats();
    const recs = listLeads(40, 0);
    const ob = outboxSnapshot();
    const db = dbHealth();

    const funnelStages = ['new', 'contacted', 'qualified', 'captured', 'booked', 'arrived', 'deal'].map(
      (s) => ({ label: s, value: stats.funnel[s as keyof typeof stats.funnel] ?? 0 })
    );

    const channelItems = Object.entries(stats.channelDist)
      .sort((a, b) => b[1] - a[1])
      .map(([label, value]) => ({ label, value }));
    const gradeItems = Object.entries(stats.gradeDist)
      .sort((a, b) => b[1] - a[1])
      .map(([label, value]) => ({ label: `${label}级`, value }));

    const crmItems = Object.entries(stats.crmSync)
      .filter(([, v]) => v > 0)
      .map(([label, value]) => ({ label: `CRM·${label}`, value }));

    const cards = [
      { k: '总客资', v: stats.total },
      { k: '到店率', v: `${stats.arriveRate}%` },
      { k: '成交率', v: `${stats.dealRate}%` },
      { k: '待跟进', v: stats.followupQueue.length },
      { k: '待认领', v: stats.handoffQueue.length },
      { k: '同步待投', v: ob.stats.pending },
    ]
      .map((c) => `<div class="ma-card"><div class="ma-card-v">${esc(c.v)}</div><div class="ma-card-k">${esc(c.k)}</div></div>`)
      .join('');

    const rows = recs
      .map(
        (r) => `<tr>
          <td><code>${esc(r.leadId)}</code></td>
          <td>${esc(r.channel)}</td>
          <td>${esc(r.project ?? '-')}</td>
          <td>${esc(r.grade ?? '-')}</td>
          <td>${esc(r.stage)}</td>
          <td>${r.handedOff ? (r.consultedBy ? `已认领(${esc(r.consultedBy)})` : '待认领') : '自助'}</td>
          <td>${esc(r.crmSyncState)}</td>
          <td>${esc(r.intent ?? '-')}</td>
          <td>${new Date(r.updatedAt).toLocaleString()}</td>
        </tr>`
      )
      .join('');

    const handoffRows = stats.handoffQueue.length
      ? stats.handoffQueue
          .map(
            (r) => `<tr>
              <td><code>${esc(r.leadId)}</code></td>
              <td>${esc(r.grade ?? '-')}</td>
              <td>${esc(r.project ?? '-')}</td>
              <td>
                <form method="POST" target="_blank" action="/api/plugins/medical-aesthetics-lead/handoffs/claim" class="ma-claim">
                  <input type="hidden" name="leadId" value="${esc(r.leadId)}"/>
                  <input name="consultant" placeholder="咨询师名" class="ma-input"/>
                  <button type="submit" class="ma-btn">认领</button>
                </form>
              </td>
            </tr>`
          )
          .join('')
      : '<tr><td colspan="4">暂无待认领客资</td></tr>';

    const followupRows = stats.followupQueue.length
      ? stats.followupQueue
          .map(
            (r) => `<tr>
              <td><code>${esc(r.leadId)}</code></td>
              <td>${esc(r.grade ?? '-')}</td>
              <td>${esc(r.channel)}</td>
              <td>${esc(r.project ?? '-')}</td>
            </tr>`
          )
          .join('')
      : '<tr><td colspan="4">暂无待跟进客资</td></tr>';

    const syncLine = `CRM 同步：已投 ${ob.stats.sent} / 待投 ${ob.stats.pending} / 失败 ${ob.stats.failed}（CRM ${ob.crmEnabled ? '已配置' : '未配置'} · HIS ${ob.hisEnabled ? '已配置' : '未配置'}）｜ 库行数：${JSON.stringify((db.counts as Record<string, number>) ?? {})}`;

    return `<div class="ma-dash">
      <h2>医美客资 · 客资看板</h2>
      <div class="ma-cards">${cards}</div>

      <div class="ma-grid">
        <section class="ma-panel">
          <h3>转化漏斗（真实 SQL 聚合）</h3>
          ${funnel(funnelStages)}
        </section>
        <section class="ma-panel">
          <h3>渠道分布</h3>
          ${channelItems.length ? barChart(channelItems, '#5B8FF9') : '<p class="ma-empty">暂无渠道数据（请经 webhook 或工具落客资）</p>'}
        </section>
        <section class="ma-panel">
          <h3>意向等级分布</h3>
          ${gradeItems.length ? barChart(gradeItems, '#F6BD16') : '<p class="ma-empty">暂无等级数据</p>'}
        </section>
      </div>

      <div class="ma-panel">
        <h3>CRM 同步健康</h3>
        ${
          crmItems.length
            ? barChart(crmItems, '#5AD8A6')
            : '<p class="ma-empty">暂无同步记录</p>'
        }
        <p class="ma-sync">${esc(syncLine)}</p>
      </div>

      <section class="ma-panel">
        <h3>转人工队列（认领）</h3>
        <div class="ma-table-wrap">
          <table class="ma-table">
            <thead><tr><th>客资</th><th>等级</th><th>项目</th><th>认领</th></tr></thead>
            <tbody>${handoffRows}</tbody>
          </table>
        </div>
      </section>

      <section class="ma-panel">
        <h3>待跟进队列（C 级 / 未转化）</h3>
        <div class="ma-table-wrap">
          <table class="ma-table">
            <thead><tr><th>客资</th><th>等级</th><th>渠道</th><th>项目</th></tr></thead>
            <tbody>${followupRows}</tbody>
          </table>
        </div>
      </section>

      <section class="ma-panel">
        <h3>客资明细（最近 ${recs.length} 条）</h3>
        <div class="ma-table-wrap">
          <table class="ma-table ma-detail">
            <thead><tr><th>ID</th><th>渠道</th><th>项目</th><th>等级</th><th>阶段</th><th>处理</th><th>同步</th><th>诉求</th><th>更新时间</th></tr></thead>
            <tbody>${rows || '<tr><td colspan="9">暂无数据</td></tr>'}</tbody>
          </table>
        </div>
      </section>
    </div>

    <style>
      .ma-dash, .ma-dash * { box-sizing:border-box; }
      .ma-dash { color:#e6edf3; font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif; }
      .ma-dash h2 { font-size:18px; margin:0 0 12px; }
      .ma-dash h3 { font-size:14px; margin:0 0 10px; color:#c9d1d9; font-weight:600; }
      .ma-cards { display:flex; flex-wrap:wrap; gap:10px; margin-bottom:16px; }
      .ma-card { background:#161b22; border:1px solid #30363d; border-radius:10px; padding:10px 14px; min-width:96px; flex:1 1 auto; }
      .ma-card-v { font-size:20px; font-weight:600; }
      .ma-card-k { font-size:12px; color:#8b949e; margin-top:2px; }
      .ma-grid { display:flex; flex-wrap:wrap; gap:14px; margin-bottom:16px; }
      .ma-panel { background:#161b22; border:1px solid #30363d; border-radius:12px; padding:14px; flex:1 1 280px; min-width:260px; }
      .ma-sync { color:#8b949e; font-size:12px; margin:8px 0 0; word-break:break-all; }
      .ma-table-wrap { overflow-x:auto; -webkit-overflow-scrolling:touch; }
      .ma-table { width:100%; border-collapse:collapse; font-size:12px; min-width:100%; }
      .ma-table.ma-detail { min-width:760px; }
      .ma-table th, .ma-table td { text-align:left; padding:6px 8px; border-bottom:1px solid #21262d; vertical-align:top; }
      .ma-table th { color:#8b949e; font-weight:500; white-space:nowrap; }
      .ma-table td { white-space:normal; }
      .ma-empty { color:#8b949e; font-size:13px; }
      .ma-claim { display:flex; gap:6px; align-items:center; flex-wrap:wrap; }
      .ma-input { background:#0d1117; border:1px solid #30363d; border-radius:6px; color:#e6edf3; padding:4px 6px; font-size:12px; width:84px; }
      .ma-btn { background:#238636; border:0; border-radius:6px; color:#fff; padding:4px 10px; font-size:12px; cursor:pointer; }
      code { background:#0d1117; padding:1px 5px; border-radius:4px; font-size:11px; }
      @media (max-width: 600px) {
        .ma-dash h2 { font-size:16px; }
        .ma-card { padding:8px 12px; min-width:0; flex:0 0 calc(50% - 5px); }
        .ma-grid { gap:10px; }
        .ma-panel { padding:10px; min-width:0; }
        .ma-table th, .ma-table td { padding:5px 6px; font-size:11px; }
        .ma-table.ma-detail { min-width:560px; }
        .ma-claim { flex-direction:column; align-items:stretch; gap:6px; }
        .ma-claim .ma-input { width:auto; }
      }
      @media (max-width: 360px) {
        .ma-card { flex:0 0 100%; }
      }
    </style>`;
  },
};

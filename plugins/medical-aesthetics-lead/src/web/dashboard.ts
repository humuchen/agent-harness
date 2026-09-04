import type { PluginUIView } from '@agent-harness/core';
import { computeStats, listLeads } from '../repo/lead-repo';
import { outboxSnapshot } from '../services/outbox-worker';
import { dbHealth } from '../infra/db';
import { runAnalyticsQuery } from '../analytics/analytics-service';
import { listAppointmentsByDate } from '../repo/schedule-repo';

/** HTML 转义，避免客资字段注入。 */
function esc(s: unknown): string {
  return String(s ?? '').replace(
    /[&<>"]/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string)
  );
}

/** 横向柱状图（SVG 字符串，服务端渲染）。 */
function barChart(
  items: { label: string; value: number }[],
  color = '#7F77DD'
): string {
  const w = 460,
    rowH = 24,
    top = 4,
    labelW = 96,
    barX = labelW + 8;
  const max = Math.max(1, ...items.map((i) => i.value));
  const h = top * 2 + items.length * rowH;
  const bars = items
    .map((it, i) => {
      const y = top + i * rowH;
      const bw = Math.max(2, Math.round((it.value / max) * (w - barX - 42)));
      return `<g>
        <text class="ma-lab" x="0" y="${y + 15}" font-size="12">${esc(
        it.label
      )}</text>
        <rect x="${barX}" y="${
        y + 4
      }" width="${bw}" height="15" rx="3" fill="${color}"/>
        <text class="ma-val" x="${barX + bw + 6}" y="${
        y + 16
      }" font-size="12">${it.value}</text>
      </g>`;
    })
    .join('');
  return `<svg class="ma-chart" viewBox="0 0 ${w} ${h}" width="100%" preserveAspectRatio="xMinYMin meet" style="max-width:480px">${bars}</svg>`;
}

/** 转化漏斗（饼/环图 SVG 字符串，服务端渲染；环心显示进入漏斗的客资总数）。 */
function pieChart(stages: { label: string; value: number }[]): string {
  const total = stages.reduce((a, s) => a + s.value, 0);
  if (total === 0) {
    return '<p class="ma-empty">暂无漏斗数据（请经 webhook 或工具落客资）</p>';
  }
  const palette = [
    '#5B8FF9',
    '#5AD8A6',
    '#5D7092',
    '#F6BD16',
    '#E8684A',
    '#6DC8EC',
    '#9270CA'
  ];
  const cx = 100,
    cy = 100,
    r = 86,
    ri = 50;
  const TWO_PI = Math.PI * 2;
  let a = 0;
  const slices = stages
    .map((s, i) => {
      const frac = s.value / total;
      const a1 = a + frac * TWO_PI;
      const color = palette[i % palette.length];
      const pct = Math.round(frac * 1000) / 10;
      let shape: string;
      if (frac >= 0.9999) {
        // 满环：起止点重合时 SVG 弧不绘制，改用描边圆表示整圈。
        const rmid = (r + ri) / 2;
        shape = `<circle cx="${cx}" cy="${cy}" r="${rmid}" fill="none" stroke="${color}" stroke-width="${r - ri}"/>`;
      } else {
        const large = a1 - a > Math.PI ? 1 : 0;
        const x0o = cx + r * Math.sin(a),
          y0o = cy - r * Math.cos(a);
        const x1o = cx + r * Math.sin(a1),
          y1o = cy - r * Math.cos(a1);
        const x0i = cx + ri * Math.sin(a),
          y0i = cy - ri * Math.cos(a);
        const x1i = cx + ri * Math.sin(a1),
          y1i = cy - ri * Math.cos(a1);
        shape = `<path d="M${x0o.toFixed(2)},${y0o.toFixed(2)} A${r},${r} 0 ${large} 1 ${x1o.toFixed(2)},${y1o.toFixed(2)} L${x1i.toFixed(2)},${y1i.toFixed(2)} A${ri},${ri} 0 ${large} 0 ${x0i.toFixed(2)},${y0i.toFixed(2)} Z" fill="${color}" stroke="#fff" stroke-width="1"/>`;
      }
      a = a1;
      return `${shape}<title>${esc(s.label)}: ${s.value}（${pct}%）</title>`;
    })
    .join('');
  const entered = stages[0]?.value ?? 0;
  const legend = stages
    .map((s, i) => {
      const pct = Math.round((s.value / total) * 1000) / 10;
      const y = 26 + i * 24;
      return `<g>
        <rect x="210" y="${y - 12}" width="12" height="12" rx="2" fill="${palette[i % palette.length]}"/>
        <text class="ma-lab" x="228" y="${y - 1}" font-size="12">${esc(s.label)}</text>
        <text class="ma-val" x="470" y="${y - 1}" font-size="12" text-anchor="end">${s.value} · ${pct}%</text>
      </g>`;
    })
    .join('');
  const h = Math.max(200, 26 + stages.length * 24 + 10);
  return `<svg class="ma-chart" viewBox="0 0 480 ${h}" width="100%" preserveAspectRatio="xMinYMin meet" style="max-width:520px">
    ${slices}
    <text class="ma-donut-center" x="${cx}" y="${cy - 4}" font-size="20" text-anchor="middle">${entered}</text>
    <text class="ma-donut-sub" x="${cx}" y="${cy + 16}" font-size="11" text-anchor="middle">进入漏斗</text>
    ${legend}
  </svg>`;
}

/**
 * 客资看板视图（前端 Tab）。render() 在 server 侧被 /api/plugins 调用，实时反映真实库中的
 * 客资漏斗与队列（SQL 聚合），并展示 CRM/HIS 同步健康（发件箱状态）。
 */
export const leadDashboardView: PluginUIView = {
  tabId: 'ma-lead',
  label: '客资看板',
  render(): string | Promise<string> {
    return (async () => {
      const stats = await computeStats();
      const recs = await listLeads(40, 0);
      const ob = await outboxSnapshot();
      const db = await dbHealth();

    const funnelStages = [
      'new',
      'contacted',
      'qualified',
      'captured',
      'booked',
      'arrived',
      'deal'
    ].map((s) => ({
      label: s,
      value: stats.funnel[s as keyof typeof stats.funnel] ?? 0
    }));

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
      { k: '同步待投', v: ob.stats.pending }
    ]
      .map(
        (c) =>
          `<div class="ma-card"><div class="ma-card-v">${esc(
            c.v
          )}</div><div class="ma-card-k">${esc(c.k)}</div></div>`
      )
      .join('');

    const rows = recs
      .map(
        (r) => `<tr>
          <td><code>${esc(r.leadId)}</code></td>
          <td>${esc(r.channel)}</td>
          <td>${esc(r.project ?? '-')}</td>
          <td>${esc(r.grade ?? '-')}</td>
          <td>${esc(r.stage)}</td>
          <td>${
            r.handedOff
              ? r.consultedBy
                ? `已认领(${esc(r.consultedBy)})`
                : '待认领'
              : '自助'
          }</td>
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

    const syncLine = `CRM 同步：已投 ${ob.stats.sent} / 待投 ${
      ob.stats.pending
    } / 失败 ${ob.stats.failed}（CRM ${
      ob.crmEnabled ? '已配置' : '未配置'
    } · HIS ${ob.hisEnabled ? '已配置' : '未配置'}）｜ 库行数：${JSON.stringify(
      (db.counts as Record<string, number>) ?? {}
    )}`;

    return `<div class="ma-dash">
      <h2>医美客资 · 客资看板</h2>
      <div class="ma-cards">${cards}</div>

      <div class="ma-grid">
        <section class="ma-panel">
          <h3>转化漏斗（饼图）</h3>
          ${pieChart(funnelStages)}
        </section>
        <section class="ma-panel">
          <h3>渠道分布</h3>
          ${
            channelItems.length
              ? barChart(channelItems, '#5B8FF9')
              : '<p class="ma-empty">暂无渠道数据（请经 webhook 或工具落客资）</p>'
          }
        </section>
        <section class="ma-panel">
          <h3>意向等级分布</h3>
          ${
            gradeItems.length
              ? barChart(gradeItems, '#F6BD16')
              : '<p class="ma-empty">暂无等级数据</p>'
          }
        </section>
      </div>

      <div class="crm ma-panel">
        <h3>CRM 同步健康</h3>
        ${
          crmItems.length
            ? barChart(crmItems, '#5AD8A6')
            : '<p class="ma-empty">暂无同步记录</p>'
        }
        <p class="ma-sync">${esc(syncLine)}</p>
      </div>

      <section class="user-handoff ma-panel">
        <h3>转人工队列（认领）</h3>
        <div class="ma-table-wrap">
          <table class="ma-table">
            <thead><tr><th>客资</th><th>等级</th><th>项目</th><th>认领</th></tr></thead>
            <tbody>${handoffRows}</tbody>
          </table>
        </div>
      </section>

      <section class="pending-followup ma-panel">
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
      .ma-dash { color: var(--ah-text); font-family: var(--ah-font-sans); }
      .ma-dash h2 { font-size:18px; margin:0 0 12px; }
      .ma-dash h3 { font-size:14px; margin:0 0 10px; color: var(--ah-text-muted); font-weight:600; }
      .ma-cards { display:flex; flex-wrap:wrap; gap:10px; margin-bottom:16px; }
      .ma-card { background: var(--ah-surface-1); border:1px solid var(--ah-border); border-radius:10px; padding:10px 14px; min-width:96px; flex:1 1 auto; }
      .ma-card-v { font-size:20px; font-weight:600; }
      .ma-card-k { font-size:12px; color: var(--ah-text-muted); margin-top:2px; }
      .ma-grid { display:flex; flex-wrap:wrap; gap:14px; margin-bottom:16px; }
      .ma-panel { background: var(--ah-surface-1); border:1px solid var(--ah-border); border-radius:12px; padding:14px; flex:1 1 280px; min-width:260px; }
      .crm.ma-panel,
      .user-handoff.ma-panel,
      .pending-followup.ma-panel{ margin-bottom:15px; }
      .ma-sync { color: var(--ah-text-muted); font-size:12px; margin:8px 0 0; word-break:break-all; }
      .ma-table-wrap { overflow-x:auto; -webkit-overflow-scrolling:touch; }
      .ma-table { width:100%; border-collapse:collapse; font-size:12px; min-width:100%; }
      .ma-table.ma-detail { min-width:760px; }
      .ma-table th, .ma-table td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--ah-border); vertical-align:top; }
      .ma-table th { color: var(--ah-text-muted); font-weight:500; white-space:nowrap; }
      .ma-table td { white-space:normal; }
      .ma-empty { color: var(--ah-text-muted); font-size:13px; }
      .ma-claim { display:flex; gap:6px; align-items:center; flex-wrap:wrap; }
      .ma-input { background: var(--ah-surface-2); border:1px solid var(--ah-border); border-radius:6px; color: var(--ah-text); padding:4px 6px; font-size:12px; width:84px; }
      .ma-btn { background: var(--ah-accent); border:0; border-radius:6px; color:#fff; padding:4px 10px; font-size:12px; cursor:pointer; }
      .ma-btn:hover { background: var(--ah-accent-strong); }
      .ma-dash code { background: var(--ah-surface-3); padding:1px 5px; border-radius:4px; font-size:11px; }
      /* SVG 图表文字随主题切换：柱体/漏斗保留数据系列配色，轴标签与数值改用语义令牌 */
      .ma-chart .ma-lab { fill: var(--ah-text-muted); }
      .ma-chart .ma-val { fill: var(--ah-text-faint); }
      /* 饼/环图中心文字随主题切换 */
      .ma-chart .ma-donut-center { fill: var(--ah-text); font-weight:600; }
      .ma-chart .ma-donut-sub { fill: var(--ah-text-muted); }
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
    })();
  },
};

/**
 * 运营分析看板视图（前端 Tab）。
 * 调用 analytics 服务获取真实聚合数据，渲染 SVG 图表。
 * 主题色通过 CSS 变量自适应 (var(--ah-text), var(--ah-accent), …)。
 */
export const analyticsDashboardView: PluginUIView = {
  tabId: 'ma-analytics',
  label: '运营分析',
  render(): string | Promise<string> {
    return (async () => {
      const result = await runAnalyticsQuery({ type: 'full' });
      const d = result.data as any;

      // --- 漏斗图 ---
      const funnelData = (d?.funnel ?? []).map((f: any) => ({
        label: f.stage,
        value: f.count,
        pct: f.percentage,
        avgH: f.avgHoursToNext,
      }));

      // --- 渠道柱状图 ---
      const channelData = (d?.channel ?? []).map((c: any) => ({
        label: c.channel,
        value: c.leadCount,
        rate: c.dealRate,
      }));

      // --- 院区柱状图 ---
      const clinicData = (d?.clinic ?? []).map((c: any) => ({
        label: c.clinicName,
        value: c.dealCount,
        util: c.slotUtilization,
      }));

      // --- 项目柱状图 ---
      const projectData = (d?.project ?? []).map((p: any) => ({
        label: p.project,
        value: p.dealCount,
        rev: p.estimatedRevenue,
      }));

      // --- 趋势折线 ---
      const trendData = (d?.trend ?? []).map((t: any) => ({
        period: t.period,
        leads: t.leadCount,
        deals: t.dealCount,
      }));

      const funnelBars = barChart(
        funnelData.map((f: any) => ({ label: f.label, value: f.value })),
        'var(--ah-accent)'
      );

      const channelBars = barChart(
        channelData.map((c: any) => ({ label: c.label, value: c.value })),
        '#5B8FF9'
      );

      const clinicBars = barChart(
        clinicData.map((c: any) => ({ label: c.label, value: c.value })),
        '#5AD8A6'
      );

      const projectBars = barChart(
        projectData.map((p: any) => ({ label: p.label, value: p.value })),
        '#F6BD16'
      );

      // 趋势折线图
      const trendMax = Math.max(1, ...trendData.map((t: any) => t.leads));
      const trendW = 420, trendH = 140, trendPad = { top: 20, right: 10, bottom: 30, left: 40 };
      const trendX = (i: number) => trendPad.left + (i / Math.max(1, trendData.length - 1)) * (trendW - trendPad.left - trendPad.right);
      const trendY = (v: number) => trendH - trendPad.bottom - (v / trendMax) * (trendH - trendPad.top - trendPad.bottom);
      const trendPath = trendData.map((t: any, i: number) => `${trendX(i).toFixed(1)},${trendY(t.leads).toFixed(1)}`).join(' ');
      const trendLine = `M${trendPath.replace(/ /g, ' L')}`;

      const funnelTable = funnelData.length
        ? '<table class="ma-table">' +
          '<thead><tr><th>阶段</th><th>人数</th><th>占比</th><th>平均流转(小时)</th></tr></thead>' +
          '<tbody>' +
          funnelData.map((f: any) =>
            `<tr><td>${esc(f.label)}</td><td>${f.value}</td><td>${f.pct}%</td><td>${f.avgH ?? '-'}</td></tr>`
          ).join('') +
          '</tbody></table>'
        : '<p class="ma-empty">暂无漏斗数据</p>';

      const channelTable = channelData.length
        ? '<table class="ma-table">' +
          '<thead><tr><th>渠道</th><th>线索数</th><th>成交率</th></tr></thead>' +
          '<tbody>' +
          channelData.map((c: any) =>
            `<tr><td>${esc(c.label)}</td><td>${c.value}</td><td>${c.rate}%</td></tr>`
          ).join('') +
          '</tbody></table>'
        : '<p class="ma-empty">暂无渠道数据</p>';

      const clinicTable = clinicData.length
        ? '<table class="ma-table">' +
          '<thead><tr><th>院区</th><th>成交数</th><th>号源利用率</th></tr></thead>' +
          '<tbody>' +
          clinicData.map((c: any) =>
            `<tr><td>${esc(c.label)}</td><td>${c.value}</td><td>${c.util}%</td></tr>`
          ).join('') +
          '</tbody></table>'
        : '<p class="ma-empty">暂无院区数据</p>';

      const projectTable = projectData.length
        ? '<table class="ma-table">' +
          '<thead><tr><th>项目</th><th>成交数</th><th>预估收入(元)</th></tr></thead>' +
          '<tbody>' +
          projectData.map((p: any) =>
            `<tr><td>${esc(p.label)}</td><td>${p.value}</td><td>${p.rev.toLocaleString()}</td></tr>`
          ).join('') +
          '</tbody></table>'
        : '<p class="ma-empty">暂无项目数据</p>';

      const trendEmpty = trendData.length === 0;

      // --- 当天预约（到院/完成打卡） ---
      const today = new Date().toISOString().slice(0, 10);
      const todayAppts = await listAppointmentsByDate(today);
      const apptRows = todayAppts.length
        ? todayAppts.map((a) => {
            const isArrived = a.status === 'arrived';
            const isCompleted = a.status === 'completed';
            const markArrivedBtn = isCompleted
              ? ''
              : isArrived
                ? ''
                : `<form method="POST" action="/api/plugins/medical-aesthetics-lead/appointments/mark" class="ma-claim" style="display:inline">
                    <input type="hidden" name="appointmentId" value="${esc(a.appointmentId)}"/>
                    <input type="hidden" name="action" value="arrived"/>
                    <button type="submit" class="ma-btn" style="padding:2px 8px;font-size:11px">到院</button>
                  </form>`;
            const markCompletedBtn = isCompleted
              ? ''
              : !isArrived
                ? ''
                : `<form method="POST" action="/api/plugins/medical-aesthetics-lead/appointments/mark" class="ma-claim" style="display:inline">
                    <input type="hidden" name="appointmentId" value="${esc(a.appointmentId)}"/>
                    <input type="hidden" name="action" value="completed"/>
                    <button type="submit" class="ma-btn" style="padding:2px 8px;font-size:11px">完成</button>
                  </form>`;
            return `<tr>
              <td><code>${esc(a.appointmentId)}</code></td>
              <td>${esc(a.leadId)}</td>
              <td>${esc(a.date)}</td>
              <td>${esc(a.time)}</td>
              <td>${esc(a.status === 'arrived' ? '到院' : a.status === 'completed' ? '完成' : a.status)}</td>
              <td>${markArrivedBtn}${markCompletedBtn}</td>
            </tr>`;
          }).join('')
        : '<tr><td colspan="6">今日暂无预约</td></tr>';

      return `<div class="ma-analytics">
  <h2>医美运营分析</h2>
  <p class="ma-empty" style="font-size:12px; margin-bottom:12px;">数据更新于 ${new Date(result.generatedAt).toLocaleString()} · 全部来自真实数据库聚合</p>

  <div class="ma-grid">
    <section class="ma-panel">
      <h3>转化漏斗</h3>
      ${funnelBars}
      ${funnelTable}
    </section>
    <section class="ma-panel">
      <h3>渠道业绩</h3>
      ${channelBars}
      ${channelTable}
    </section>
  </div>

  <div class="ma-grid">
    <section class="ma-panel">
      <h3>院区业绩</h3>
      ${clinicBars}
      ${clinicTable}
    </section>
    <section class="ma-panel">
      <h3>项目毛利</h3>
      ${projectBars}
      ${projectTable}
    </section>
  </div>

  <section class="ma-panel">
    <h3>趋势曲线（日）</h3>
    ${
      trendEmpty
        ? '<p class="ma-empty">暂无趋势数据</p>'
        : `<svg class="ma-chart" viewBox="0 0 ${trendW} ${trendH}" width="100%" style="max-width:480px">
          <line x1="${trendPad.left}" y1="${trendH - trendPad.bottom}" x2="${trendW - trendPad.right}" y2="${trendH - trendPad.bottom}" stroke="var(--ah-border)" stroke-width="1"/>
          <polyline fill="none" stroke="var(--ah-accent)" stroke-width="2" points="${trendPath}"/>
          ${trendData.map((t: any, i: number) =>
            `<text class="ma-lab" x="${trendX(i).toFixed(1)}" y="${(trendH - trendPad.bottom + 15).toFixed(1)}" font-size="10" text-anchor="middle">${esc(t.period)}</text>`
          ).join('')}
          ${trendData.map((t: any, i: number) =>
            `<text class="ma-val" x="${trendX(i).toFixed(1)}" y="${(trendY(t.leads) - 4).toFixed(1)}" font-size="10" text-anchor="middle">${t.leads}</text>`
          ).join('')}
        </svg>`
    }
  </section>

  <section class="ma-panel">
    <h3>今日到院打卡</h3>
    <div class="ma-table-wrap">
      <table class="ma-table">
        <thead>
          <tr>
            <th>预约单</th>
            <th>客资</th>
            <th>日期</th>
            <th>时间</th>
            <th>状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>${apptRows}</tbody>
      </table>
    </div>
  </section>

  <style>
    .ma-analytics { color: var(--ah-text); font-family: var(--ah-font-sans); }
    .ma-analytics h2 { font-size:18px; margin:0 0 12px; }
    .ma-analytics h3 { font-size:14px; margin:0 0 10px; color: var(--ah-text-muted); font-weight:600; }
    .ma-grid { display:flex; flex-wrap:wrap; gap:14px; margin-bottom:16px; }
    .ma-panel { background: var(--ah-surface-1); border:1px solid var(--ah-border); border-radius:12px; padding:14px; flex:1 1 280px; min-width:260px; }
    .ma-table-wrap { overflow-x:auto; -webkit-overflow-scrolling:touch; }
    .ma-table { width:100%; border-collapse:collapse; font-size:12px; margin-top:8px; }
    .ma-table th, .ma-table td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--ah-border); vertical-align:top; }
    .ma-table th { color: var(--ah-text-muted); font-weight:500; white-space:nowrap; }
    .ma-empty { color: var(--ah-text-muted); font-size:13px; }
    .ma-chart .ma-lab { fill: var(--ah-text-muted); }
    .ma-chart .ma-val { fill: var(--ah-text-faint); }
    @media (max-width: 600px) {
      .ma-analytics h2 { font-size:16px; }
      .ma-grid { gap:10px; }
      .ma-panel { padding:10px; min-width:0; }
      .ma-table { font-size:11px; }
    }
  </style>
</div>`;
    })();
  },
};

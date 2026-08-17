import type { PluginUIView } from '@agent-harness/core';
import { listRecords, fullStats, handoffQueue } from '../store';

/** HTML 转义，避免会话 id 等字段注入。 */
function esc(s: unknown): string {
  return String(s ?? '').replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string)
  );
}

/** 横向柱状图（SVG 字符串，服务端渲染，注入 webapp 后无需 JS 即可显示）。 */
function barChart(items: { label: string; value: number }[], color = '#378ADD'): string {
  const w = 460, rowH = 24, top = 4, labelW = 104, barX = labelW + 8;
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

/** 环形图（SVG 字符串）。 */
function donut(segments: { label: string; value: number; color: string }[]): string {
  const total = segments.reduce((s, x) => s + x.value, 0);
  const size = 120, cx = 60, cy = 60, r = 44, sw = 16, c = 2 * Math.PI * r;
  if (total === 0) {
    return `<svg viewBox="0 0 ${size} ${size}" width="100%" style="max-width:140px"><circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#30363d" stroke-width="${sw}"/><text x="${cx}" y="${cy + 4}" font-size="12" fill="#8b949e" text-anchor="middle">暂无</text></svg>`;
  }
  let off = 0;
  const arcs = segments
    .map((s) => {
      const len = (s.value / total) * c;
      const seg = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${s.color}" stroke-width="${sw}" stroke-dasharray="${len.toFixed(2)} ${(c - len).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}" transform="rotate(-90 ${cx} ${cy})"/>`;
      off += len;
      return seg;
    })
    .join('');
  return `<svg viewBox="0 0 ${size} ${size}" width="100%" style="max-width:140px">${arcs}<text x="${cx}" y="${cy + 4}" font-size="13" fill="#c9d1d9" text-anchor="middle">${total}</text></svg>`;
}

/** 取对话记录的可见片段：最后一条用户问 + 最后一条助手答。 */
function snippet(transcript?: { role: string; text: string }[]): string {
  if (!transcript || transcript.length === 0) return '-';
  const user = [...transcript].reverse().find((t) => t.role === 'user');
  const asst = [...transcript].reverse().find((t) => t.role === 'assistant');
  const parts = [user ? `问：${user.text}` : '', asst ? `答：${asst.text}` : ''].filter(Boolean);
  const s = parts.join(' ｜ ');
  return s.length > 160 ? s.slice(0, 160) + '…' : s;
}

/**
 * 客服管理后台视图（前端 Tab）。render() 在 server 侧被 /api/plugins 调用，实时反映
 * 共享存储中的会话记录与满意度统计（多副本下任意副本写入均可见）。
 * webapp 仅把返回的 HTML 注入「客服后台」Tab，不感知任何业务语义。
 * 约束：render() 无参数、注入经 unsafeHTML（不执行 <script>），故交互均走原生
 * HTML（<form method=POST target=_blank> 认领），图表用内联 SVG 渲染。
 */
export const csAdminView: PluginUIView = {
  tabId: 'cs-admin',
  label: '客服后台',
  render(): string {
    const stats = fullStats();
    const recs = listRecords().slice(0, 40);
    const queue = handoffQueue();

    const intentItems = Object.entries(stats.intentDist)
      .sort((a, b) => b[1] - a[1])
      .map(([label, value]) => ({ label, value }));
    const satItems = [5, 4, 3, 2, 1].map((s) => ({ label: `${s}★`, value: stats.satisfactionDist[s] ?? 0 }));

    const cards = [
      { k: '会话总数', v: stats.total },
      { k: '已解决', v: stats.resolved },
      { k: '转人工', v: stats.handedOff },
      { k: '转人工率', v: `${stats.handoffRate}%` },
      { k: '平均满意度', v: stats.avgSatisfaction == null ? '暂无' : stats.avgSatisfaction.toFixed(2) },
      { k: 'CSAT(4-5★)', v: `${stats.csatPct}%` },
    ]
      .map((c) => `<div class="cs-card"><div class="cs-card-v">${esc(c.v)}</div><div class="cs-card-k">${esc(c.k)}</div></div>`)
      .join('');

    const rows = recs
      .map(
        (r) => `<tr>
          <td><code>${esc(r.sessionId)}</code></td>
          <td>${r.kind === 'run' ? '运行' : '会话'}</td>
          <td>${esc(r.lastIntent ?? '-')}</td>
          <td>${r.handedOff ? (r.claimedBy ? `已认领(${esc(r.claimedBy)})` : '待认领') : '自助'}</td>
          <td>${typeof r.satisfaction === 'number' ? `${r.satisfaction}★` : '-'}</td>
          <td class="cs-snip">${esc(snippet(r.transcript))}</td>
          <td>${new Date(r.updatedAt).toLocaleString()}</td>
        </tr>`
      )
      .join('');

    const queueRows = queue.length
      ? queue
          .map(
            (r) => `<tr>
              <td><code>${esc(r.sessionId)}</code></td>
              <td>${esc(r.lastIntent ?? '-')}</td>
              <td>${new Date(r.updatedAt).toLocaleString()}</td>
              <td>
                <form method="POST" target="_blank" action="/api/plugins/customer-service/handoffs/claim" class="cs-claim">
                  <input type="hidden" name="sessionId" value="${esc(r.sessionId)}"/>
                  <input name="claimedBy" placeholder="坐席名" class="cs-input"/>
                  <button type="submit" class="cs-btn">认领</button>
                </form>
              </td>
            </tr>`
          )
          .join('')
      : '<tr><td colspan="4">暂无待认领工单</td></tr>';

    return `<div class="cs-admin">
      <h2>智能客服 · 管理后台</h2>
      <div class="cs-cards">${cards}</div>

      <div class="cs-grid">
        <section class="cs-panel">
          <h3>意图分布</h3>
          ${intentItems.length ? barChart(intentItems, '#7F77DD') : '<p class="cs-empty">暂无意图数据</p>'}
        </section>
        <section class="cs-panel">
          <h3>满意度分布</h3>
          ${barChart(satItems, '#1D9E75')}
        </section>
        <section class="cs-panel">
          <h3>转人工占比</h3>
          ${donut([
            { label: '转人工', value: stats.handedOff, color: '#D85A30' },
            { label: '自助', value: Math.max(0, stats.total - stats.handedOff), color: '#378ADD' },
          ])}
        </section>
      </div>

      <section class="cs-panel">
        <h3>转人工队列（认领）</h3>
        <table class="cs-table">
          <thead><tr><th>会话</th><th>意图</th><th>更新时间</th><th>认领</th></tr></thead>
          <tbody>${queueRows}</tbody>
        </table>
      </section>

      <section class="cs-panel">
        <h3>对话记录（最近 ${recs.length} 条）</h3>
        <table class="cs-table">
          <thead><tr><th>ID</th><th>类型</th><th>意图</th><th>处理</th><th>满意度</th><th>片段</th><th>更新时间</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="7">暂无数据</td></tr>'}</tbody>
        </table>
      </section>
    </div>

    <style>
      .cs-admin { color:#e6edf3; font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif; }
      .cs-admin h2 { font-size:18px; margin:0 0 12px; }
      .cs-admin h3 { font-size:14px; margin:0 0 10px; color:#c9d1d9; font-weight:600; }
      .cs-cards { display:flex; flex-wrap:wrap; gap:10px; margin-bottom:16px; }
      .cs-card { background:#161b22; border:1px solid #30363d; border-radius:10px; padding:10px 14px; min-width:110px; }
      .cs-card-v { font-size:20px; font-weight:600; }
      .cs-card-k { font-size:12px; color:#8b949e; margin-top:2px; }
      .cs-grid { display:flex; flex-wrap:wrap; gap:14px; margin-bottom:16px; }
      .cs-panel { background:#161b22; border:1px solid #30363d; border-radius:12px; padding:14px; flex:1 1 280px; min-width:260px; }
      .cs-table { width:100%; border-collapse:collapse; font-size:12px; }
      .cs-table th, .cs-table td { text-align:left; padding:6px 8px; border-bottom:1px solid #21262d; vertical-align:top; }
      .cs-table th { color:#8b949e; font-weight:500; }
      .cs-snip { color:#8b949e; max-width:320px; }
      .cs-empty { color:#8b949e; font-size:13px; }
      .cs-claim { display:flex; gap:6px; align-items:center; }
      .cs-input { background:#0d1117; border:1px solid #30363d; border-radius:6px; color:#e6edf3; padding:4px 6px; font-size:12px; width:90px; }
      .cs-btn { background:#238636; border:0; border-radius:6px; color:#fff; padding:4px 10px; font-size:12px; cursor:pointer; }
      code { background:#0d1117; padding:1px 5px; border-radius:4px; font-size:11px; }
    </style>`;
  },
};

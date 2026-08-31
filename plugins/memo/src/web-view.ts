/**
 * 前端备忘看板视图（webapp 动态渲染为「备忘看板」Tab）。
 * 返回可直接注入内容区的 HTML 字符串（无框架耦合）。
 * 样式遵循 --ah-* 语义令牌，与客服看板视觉一致。
 */

import type { PluginUIView } from '@agent-harness/core';
import { listNotes } from './store';

function esc(s: unknown): string {
  return String(s ?? '').replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string
  );
}

export const memoBoardView: PluginUIView = {
  tabId: 'memo',
  label: '备忘看板',
  render(): string | Promise<string> {
    const notes = listNotes(undefined, 50);
    const cards = [
      { k: '备忘总数', v: String(notes.length) },
      { k: '带标签', v: String(notes.filter((n) => n.tag).length) },
    ]
      .map(
        (c) =>
          `<div class="memo-card"><div class="memo-card-v">${esc(c.v)}</div><div class="memo-card-k">${esc(c.k)}</div></div>`
      )
      .join('');

    const rows = notes
      .map((n) => {
        const d = new Date(n.createdAt);
        const time = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        return `<tr>
          <td><code>${esc(n.id.slice(0, 8))}</code></td>
          <td>${esc(n.text)}</td>
          <td>${n.tag ? `<span class="memo-badge">${esc(n.tag)}</span>` : '-'}</td>
          <td>${esc(time)}</td>
        </tr>`;
      })
      .join('');

    return `
    <div class="memo-dash">
      <h2>备忘助手 · 备忘看板</h2>
      <div class="memo-cards">${cards}</div>

      <section class="memo-panel">
        <h3>最近备忘</h3>
        <div class="memo-table-wrap">
          <table class="memo-table">
            <thead><tr><th>id</th><th>内容</th><th>标签</th><th>时间</th></tr></thead>
            <tbody>${rows || '<tr><td colspan="4">暂无备忘（对话中说「记一下：…」即可保存）</td></tr>'}</tbody>
          </table>
        </div>
      </section>

      <style>
        .memo-dash, .memo-dash * { box-sizing:border-box; }
        .memo-dash { color: var(--ah-text); font-family: var(--ah-font-sans); }
        .memo-dash h2 { font-size:18px; margin:0 0 12px; }
        .memo-dash h3 { font-size:14px; margin:0 0 10px; color: var(--ah-text-muted); font-weight:600; }

        .memo-cards { display:flex; flex-wrap:wrap; gap:10px; margin-bottom:16px; }
        .memo-card { background: var(--ah-surface-1); border:1px solid var(--ah-border); border-radius:10px; padding:10px 14px; min-width:96px; flex:1 1 auto; }
        .memo-card-v { font-size:20px; font-weight:600; }
        .memo-card-k { font-size:12px; color: var(--ah-text-muted); margin-top:2px; }

        .memo-panel { background: var(--ah-surface-1); border:1px solid var(--ah-border); border-radius:12px; padding:14px; }
        .memo-table-wrap { overflow-x:auto; -webkit-overflow-scrolling:touch; }
        .memo-table { width:100%; border-collapse:collapse; font-size:12px; }
        .memo-table th, .memo-table td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--ah-border); vertical-align:top; }
        .memo-table th { color: var(--ah-text-muted); font-weight:500; white-space:nowrap; }
        .memo-table code { background: var(--ah-surface-3); padding:1px 5px; border-radius:4px; font-size:11px; }

        .memo-badge { display:inline-block; padding:2px 10px; border-radius:999px; font-size:11px; font-weight:500; line-height:1.6; background: var(--ah-accent-alpha, rgba(41,151,255,.15)); color: var(--ah-accent); }
      </style>
    </div>`;
  },
};

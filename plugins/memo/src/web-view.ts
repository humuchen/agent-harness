/**
 * 前端备忘看板视图（webapp 动态渲染为「备忘看板」Tab）。
 * 返回可直接注入内容区的 HTML 字符串（无框架耦合）。
 * 样式遵循 --ah-* 语义令牌，与客服看板视觉一致。
 *
 * 用户绑定：宿主（server /api/plugins）鉴权后把当前登录用户传给 render(user)，
 * 数据按 user.sub（owner）从库中读取后服务端渲染——看板天然只展示登录人自己的备忘。
 *
 * 数据管理：本看板提供真正的服务端检索/排序/分页（而非前端 200 条上限 + 客户端过滤）：
 *   - 统计卡（总数/带标签/含提醒/已提醒）来自 noteStats；
 *   - 搜索框（oninput）、排序下拉（onchange）触发内联 fetch 到 /api/plugins/memo/board，
 *     服务端按 owner 检索后返回「表格 + 分页器」整块 HTML，直接替换 #memo-mgmt-body；
 *   - 分页器「上一页/下一页」同样走内联 fetch，offset 由服务端按本页正确计算后写回按钮；
 *   - 全部交互均为内联事件属性（innerHTML/unsafeHTML 注入后依然生效），契合 shadow DOM 限制（无 <script>）；
 *   - 单行「删除」与「删除选中 / 清空全部」沿用既有内联 fetch，成功后整页刷新。
 *
 * 行/表体渲染函数（noteRowsHtml / boardBodyHtml）同时被本文件与 server-routes 的 /board 路由复用，
 * 保证看板整页渲染与异步翻页渲染的 DOM 结构完全一致。
 */

import type { PluginUIView, PluginRouteUser } from '@agent-harness/core';
import type { MemoNote } from './store';
import {
  searchNotes,
  noteStats,
  noteTags,
  upcomingReminders,
  reminderHistory,
  DISPLAY_TZ,
  tzOffsetMs
} from './store';

/** 看板每页条数（分页粒度，服务端检索用）。 */
export const BOARD_PAGE = 20;
/** 内联 JS 辅助：读取 ah_user（与 api.ts 同步的 localStorage key），构造带 x-ah-username 头的 fetch 选项。 */
const AUTH_HEADERS_JS = `(function(){var h={};var u=localStorage.getItem('ah_user');if(u){h['x-ah-username']=u}return h})()`;

function esc(s: unknown): string {
  return String(s ?? '').replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[
        c
      ] as string)
  );
}

/** 把 epoch ms 格式化为「MM-DD HH:mm」，按 DISPLAY_TZ (默认 Asia/Shanghai) 渲染墙上时间。
 *  服务端渲染时 new Date().getHours() 受进程 TZ 影响；强制使用 tzOffsetMs 校正，
 *  保证无论服务器在 UTC 还是 CST，看板都显示用户所在时区的墙上时间，与落库 epoch ms 一致。
 */
function fmt(ts: number): string {
  const wall = ts + tzOffsetMs(ts, DISPLAY_TZ);
  const d = new Date(wall);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(
    d.getUTCHours()
  )}:${p(d.getUTCMinutes())}`;
}

/**
 * 聊天风格自定义下拉菜单：
 *  - 隐藏原生 <select>（保留 id，用于 boardUrl 获取 value）
 *  - 浮动 trigger 按钮 + 悬浮 <ul> 选项列表
 *  - 选中项显示蓝底 + 左图标 + 右勾
 *  - 点击选项 → 设置 hidden select value 触发 onchange → fetch /board
 */
function selectHtml(opts: {
  id: string;
  placeholder: string;
  value: string;
  items: { value: string; label: string; icon?: string }[];
  onChangeFetch: string;
}): string {
  const selected = opts.items.find((i) => i.value === opts.value) ??
    opts.items[0] ?? { label: opts.placeholder, icon: '•' };
  const optHtml = opts.items
    .map(
      (i) => `
      <li class="memo-select-option ${
        i.value === opts.value ? 'memo-select-option-selected' : ''
      }"
          data-value="${esc(i.value)}" onclick="document.getElementById('${
        opts.id
      }').value='${esc(
        i.value
      )}';this.dispatchEvent(new Event('change',{bubbles:true}))">${esc(
        i.icon ?? '•'
      )} ${esc(i.label)}</li>`
    )
    .join('');
  return `
    <div class="memo-select-wrap">
      <select id="${opts.id}" style="display:none" onchange="${esc(
    opts.onChangeFetch
  )}">${opts.items
    .map(
      (i) =>
        `<option value="${esc(i.value)}" ${
          i.value === opts.value ? 'selected' : ''
        }>${esc(i.label)}</option>`
    )
    .join('')}</select>
      <button type="button" class="memo-select-trigger" id="${
        opts.id
      }-trigger" onclick="var m=this.nextElementSibling;m.style.display=m.style.display==='block'?'none':'block';"><span class="memo-select-trigger-icon">${esc(
    selected.icon ?? '•'
  )}</span><span class="memo-select-trigger-label">${esc(
    selected.label
  )}</span><span class="memo-select-trigger-chevron">▼</span></button>
      <ul class="memo-select-menu" id="${
        opts.id
      }-menu" style="display:none">${optHtml}</ul>
    </div>`;
}

/** 删除按钮：内联 handler（无 CSP 环境）发 DELETE 后仅刷新当前片段（不整页 reload）。 */
function delBtn(id: string): string {
  const js = `if(confirm('确认删除这条备忘？')){fetch('/api/plugins/memo/note?id=${encodeURIComponent(
    id
  )}',{method:'DELETE',credentials:'include',headers:${AUTH_HEADERS_JS}}).then(function(){${refreshCurrentJs()}})}`;
  return `<button class="memo-del" onclick="${esc(js)}">删除</button>`;
}

/** 表头「全选」：点击切换所有行复选框。
 *  使用 onchange + event.target 而非 onclick + this，避免 unsafeHTML / Lit 重渲染时
 *  this 绑定丢失；同时用 Array.from(...).forEach 取代 for(i<cb.length) 循环，
 *  避开 esc() 对 < 转义可能在属性值解析层产生歧义。
 */
function selectAllBox(): string {
  const js = `Array.from(document.querySelectorAll('.memo-mgmt-chk')).forEach(function(c){c.checked=event.target.checked})`;
  return `<input type="checkbox" class="memo-mgmt-all" title="全选" onchange="${esc(
    js
  )}">`;
}

/** 批量删除：收集勾选项 → 确认 → DELETE /notes/batch，成功后仅刷新当前片段。 */
function batchDelBtn(): string {
  const js = `(function(){var ids=[];var cbs=document.querySelectorAll('.memo-mgmt-chk:checked');for(var i=0;i<cbs.length;i++){ids.push(cbs[i].value)}if(!ids.length){return}if(!confirm('确认删除选中的 '+ids.length+' 条备忘？此操作不可恢复')){return}fetch('/api/plugins/memo/notes/batch',{method:'DELETE',credentials:'include',headers:Object.assign((function(){var h={};var u=localStorage.getItem('ah_user');if(u){h['x-ah-username']=u}return h})(),{'content-type':'application/json'}),body:JSON.stringify({ids:ids})}).then(function(){${refreshCurrentJs()}})})()`;
  return `<button class="memo-batch-del" onclick="${esc(
    js
  )}">删除选中</button>`;
}

/** 清空全部：二次确认 → DELETE /notes/all（仅清空当前 owner），成功后仅刷新当前片段。 */
function clearAllBtn(): string {
  const js = `if(confirm('确认清空当前账号的全部备忘？此操作不可恢复')){fetch('/api/plugins/memo/notes/all',{method:'DELETE',credentials:'include',headers:Object.assign((function(){var h={};var u=localStorage.getItem('ah_user');if(u){h['x-ah-username']=u}return h})(),{'content-type':'application/json'}),body:JSON.stringify({confirm:true})}).then(function(){${refreshCurrentJs()}})}`;
  return `<button class="memo-clear-all" onclick="${esc(
    js
  )}">清空全部</button>`;
}

/** fetch 尾部：解析 JSON 并把返回 html 注入 #memo-mgmt-body（翻页/检索/删除后通用）。 */
const BOARD_FETCH_TAIL = `.then(function(r){return r.json()}).then(function(d){var b=document.getElementById('memo-mgmt-body');if(b)b.innerHTML=d.html})`;

/**
 * 构造 /board 请求 URL。offsetExpr 为 JS 表达式串（数字字面量或变量名，如 '0' / '__off'）。
 * 搜索词/排序/标签取自页面上的 #memo-search / #memo-sort / #memo-tag（均在 body 之外，翻页后依然存在）；
 * 标签为空时不拼 &tag=，避免过滤到空标签。
 */
function boardUrl(offsetExpr: string): string {
  return `('/api/plugins/memo/board?offset='+(${offsetExpr})+'&q='+encodeURIComponent((document.getElementById('memo-search')||{value:''}).value)+'&sort='+encodeURIComponent((document.getElementById('memo-sort')||{value:'newest'}).value)+(function(){var t=(document.getElementById('memo-tag')||{value:''}).value;return t?('&tag='+encodeURIComponent(t)):''})())`;
}

/** 拉取指定 offset 的 /board 片段并替换 #memo-mgmt-body（搜索 oninput / 排序 onchange / 分页 onclick 用）。 */
function goJs(offset: number): string {
  return `fetch(${boardUrl(
    String(offset)
  )},{credentials:'include',headers:${AUTH_HEADERS_JS}})${BOARD_FETCH_TAIL}`;
}

/** 删除成功后：读取片段内 #memo-offset 隐藏域的当前页码重新拉取本页（不整页 reload，体验更顺滑）。 */
function refreshCurrentJs(): string {
  return `var __o=document.getElementById('memo-offset');var __off=__o?parseInt(__o.value||'0',10):0;fetch(${boardUrl(
    '__off'
  )},{credentials:'include',headers:${AUTH_HEADERS_JS}})${BOARD_FETCH_TAIL}`;
}

/** 单行备忘（供数据管理表体）。data-text 存小写文本+标签，旧版客户端过滤兼容用。 */
export function noteRowHtml(n: MemoNote): string {
  // 按 DISPLAY_TZ 渲染墙上时间；服务器进程 TZ 不影响展示。
  const wall = n.createdAt + tzOffsetMs(n.createdAt, DISPLAY_TZ);
  const d = new Date(wall);
  const time = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(
    2,
    '0'
  )}-${String(d.getUTCDate()).padStart(2, '0')} ${String(
    d.getUTCHours()
  ).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  const remind = n.remindAt
    ? `<span class="memo-remind">⏰ ${esc(fmt(n.remindAt))}</span>`
    : '';
  const txt = (n.text + ' ' + (n.tag ?? '')).toLowerCase();
  return `<tr data-text="${esc(txt)}">
    <td class="memo-col-chk"><input type="checkbox" class="memo-mgmt-chk" value="${esc(
      n.id
    )}"></td>
    <td><code>${esc(n.id.slice(0, 8))}</code></td>
    <td>${esc(n.text)}${remind}</td>
    <td>${n.tag ? `<span class="memo-badge">${esc(n.tag)}</span>` : '-'}</td>
    <td>${esc(time)}</td>
    <td>${delBtn(n.id)}</td>
  </tr>`;
}

/** 多条备忘 → 表体行串。 */
export function noteRowsHtml(items: MemoNote[]): string {
  return items.map(noteRowHtml).join('');
}

/**
 * 数据管理表体整块（表格 + 分页器）：被整页渲染与 /board 异步翻页复用。
 * 分页器按钮的 onclick 直接内联对应 offset 的 goJs，offset 由本函数按本页正确计算。
 */
export function boardBodyHtml(args: {
  items: MemoNote[];
  total: number;
  offset: number;
  limit: number;
}): string {
  const { items, total, offset, limit } = args;
  const rows = noteRowsHtml(items);
  const count = items.length;
  const pager = `
    <div class="memo-mgmt-foot">
      <span class="memo-pager">第 ${offset + 1}–${
    offset + count
  } 条 / 共 ${total} 条</span>
      <span class="memo-pager-btns">
        ${
          offset > 0
            ? `<button class="memo-page-btn" onclick="${esc(
                goJs(offset - limit)
              )}">上一页</button>`
            : '<button class="memo-page-btn" disabled>上一页</button>'
        }
        ${
          offset + count < total
            ? `<button class="memo-page-btn" onclick="${esc(
                goJs(offset + limit)
              )}">下一页</button>`
            : '<button class="memo-page-btn" disabled>下一页</button>'
        }
      </span>
    </div>`;
  return `
    <input type="hidden" id="memo-offset" value="${offset}">
    <div class="memo-table-wrap">
      <table class="memo-table" id="memo-mgmt-table">
        <thead><tr>
          <th class="memo-col-chk">${selectAllBox()}</th>
          <th>id</th><th>内容</th><th>标签</th><th>时间</th><th>操作</th>
        </tr></thead>
        <tbody id="memo-mgmt-tbody">${
          rows ||
          '<tr><td colspan="6">暂无备忘（对话中说「记一下：…」即可保存）</td></tr>'
        }</tbody>
      </table>
    </div>
    ${pager}`;
}

export const memoBoardView: PluginUIView = {
  tabId: 'memo',
  label: '备忘看板',
  async render(user?: PluginRouteUser): Promise<string> {
    // 数据归属 = 当前登录用户（宿主传入）；无登录态（开放演示）归 anon 桶。
    const owner = user?.sub ? String(user.sub) : 'anon';
    const [page, stats, upcoming, history, tags] = await Promise.all([
      searchNotes(owner, { limit: BOARD_PAGE, offset: 0, sort: 'newest' }),
      noteStats(owner),
      upcomingReminders(owner, 20),
      reminderHistory(owner, 20),
      noteTags(owner)
    ]);

    const cards = [
      { k: '备忘总数', v: String(stats.total) },
      { k: '带标签', v: String(stats.tagged) },
      { k: '含提醒', v: String(stats.withReminder) },
      { k: '已提醒', v: String(stats.history) }
    ]
      .map(
        (c) =>
          `<div class="memo-card"><div class="memo-card-v">${esc(
            c.v
          )}</div><div class="memo-card-k">${esc(c.k)}</div></div>`
      )
      .join('');

    const bodyHtml = boardBodyHtml({
      items: page.items,
      total: page.total,
      offset: 0,
      limit: BOARD_PAGE
    });

    const remindRows = upcoming
      .map(
        (n) => `<li><span class="memo-remind-time">${esc(
          fmt(n.remindAt as number)
        )}</span>
          <span class="memo-remind-text">${esc(n.text)}</span>
          ${n.tag ? `<span class="memo-badge">${esc(n.tag)}</span>` : ''}</li>`
      )
      .join('');

    // 提醒历史：已触发过的提醒（按确认时间倒序）。错过 toast 窗口时可在此回查。
    // 时间优先取 notifiedAt（实际送到用户的时间），老数据无此字段时回退 remindAt。
    const historyRows = history
      .map((n) => {
        const at = n.notifiedAt ?? (n.remindAt as number);
        return `<li><span class="memo-history-time">${esc(fmt(at))}</span>
          <span class="memo-remind-text">${esc(n.text)}</span>
          ${
            n.tag
              ? `<span class="memo-badge memo-badge-dim">${esc(n.tag)}</span>`
              : ''
          }</li>`;
      })
      .join('');

    return `
    <div class="memo-dash">
      <h2>备忘助手 · 备忘看板<span class="memo-owner">（${esc(
        owner
      )} 的备忘）</span></h2>
      <div class="memo-cards">${cards}</div>

      <section class="memo-panel">
        <h3>数据管理</h3>
        <div class="memo-mgmt-bar">
          <input id="memo-search" class="memo-search" placeholder="搜索备忘内容 / 标签…" oninput="${esc(
            goJs(0)
          )}">
          ${selectHtml({
            id: 'memo-tag',
            placeholder: '全部标签',
            value: '',
            onChangeFetch: goJs(0),
            items: [
              { value: '', label: '全部标签', icon: '🏷️' },
              ...tags.map((t) => ({ value: t, label: t }))
            ]
          })}
          ${selectHtml({
            id: 'memo-sort',
            placeholder: '最新优先',
            value: 'newest',
            onChangeFetch: goJs(0),
            items: [
              { value: 'newest', label: '最新优先', icon: '🕒' },
              { value: 'oldest', label: '最早优先', icon: '⏮️' },
              { value: 'remind', label: '按提醒时间', icon: '⏰' }
            ]
          })}
          <span class="memo-mgmt-actions">
            ${batchDelBtn()}
            ${clearAllBtn()}
          </span>
        </div>
        <div id="memo-mgmt-body">${bodyHtml}</div>
      </section>

      <section class="memo-panel">
        <h3>待提醒（即将到来）</h3>
        <ul class="memo-remind-list">
          ${remindRows || '<li class="memo-empty">暂无待提醒的备忘</li>'}
        </ul>
      </section>

      <section class="memo-panel">
        <h3>提醒历史（已触发）</h3>
        <ul class="memo-remind-list">
          ${
            historyRows ||
            '<li class="memo-empty">还没有触发过提醒（到点后会出现在这里）</li>'
          }
        </ul>
      </section>

      <style>
        .memo-dash, .memo-dash * { box-sizing:border-box; }
        .memo-dash { color: var(--ah-text); font-family: var(--ah-font-sans); }
        .memo-dash h2 { font-size:18px; margin:0 0 12px; }
        .memo-owner { font-size:12px; font-weight:400; color: var(--ah-text-muted); margin-left:8px; }
        .memo-dash h3 { font-size:14px; margin:0 0 10px; color: var(--ah-text-muted); font-weight:600; }

        .memo-cards { display:flex; flex-wrap:wrap; gap:10px; margin-bottom:16px; }
        .memo-card { background: var(--ah-surface-1); border:1px solid var(--ah-border); border-radius:10px; padding:10px 14px; min-width:96px; flex:1 1 auto; }
        .memo-card-v { font-size:20px; font-weight:600; }
        .memo-card-k { font-size:12px; color: var(--ah-text-muted); margin-top:2px; }

        .memo-panel { background: var(--ah-surface-1); border:1px solid var(--ah-border); border-radius:12px; padding:14px; margin-bottom:16px; }
        .memo-remind-list { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:8px; }
        .memo-remind-list li { display:flex; align-items:center; gap:10px; font-size:13px; }
        .memo-remind-time { flex:none; font-variant-numeric:tabular-nums; color: var(--ah-accent); font-weight:600; }
        /* 提醒历史时间用弱化色，与「待提醒」的 accent 色区分，避免两个区块看起来一样。 */
        .memo-history-time { flex:none; font-variant-numeric:tabular-nums; color: var(--ah-text-muted); font-weight:600; }
        .memo-remind-text { flex:1 1 auto; min-width:0; overflow-wrap:anywhere; }
        .memo-remind-list .memo-empty, .memo-empty { color: var(--ah-text-muted); font-size:12px; }

        .memo-mgmt-bar { display:flex; flex-wrap:wrap; gap:10px; align-items:center; margin-bottom:10px; }
        .memo-search { flex:1 1 220px; min-width:160px; background: var(--ah-surface-3); border:none; border-radius:12px; padding:9px 14px; color: var(--ah-text); font:inherit; font-size:14px; outline:none; }
        .memo-search:focus { border:2px solid var(--ah-accent); border-radius:10px; }
        .memo-search::placeholder { color: var(--ah-text-muted); }
        /* 聊天风格自定义下拉 */
        .memo-select-wrap { position:relative; display:inline-block; }
        .memo-select-trigger {
          display:flex; align-items:center; gap:6px;
          background: var(--ah-surface-3); border:none; border-radius:12px;
          padding:5.5px 14px; color: var(--ah-text); font:inherit; font-size:14px;
          outline:none; cursor:pointer; min-width:96px;
        }
        .memo-select-trigger-chevron { font-size:10px; color: var(--ah-text-muted); }
        .memo-select-trigger:focus { border:2px solid var(--ah-accent); border-radius:10px; }
        .memo-select-trigger-icon { font-size:13px; }
        .memo-select-menu {
          position:absolute; top:100%; left:0; z-index:100;
          min-width:120px; margin-top:4px;
          background: var(--ah-surface-1); border:1px solid var(--ah-border);
          border-radius:12px; box-shadow:0 4px 16px rgba(0,0,0,0.3);
          padding:4px 0; list-style:none; margin:0;
        }
        .memo-select-option {
          display:flex; align-items:center; gap:8px;
          padding:9px 14px; cursor:pointer; font:inherit; font-size:14px; color: var(--ah-text);
        }
        .memo-select-option:hover { background: var(--ah-surface-3); }
        .memo-select-option-selected { background: var(--ah-accent); color:#fff; font-weight:600; }
        .memo-select-option-selected::after { content:'✓'; margin-left:auto; }
        .memo-mgmt-actions { display:flex; gap:8px; }
        .memo-batch-del { font:inherit; font-size:12px; padding:6px 14px; border-radius:8px; border:1px solid var(--ah-border); background:transparent; color: var(--ah-danger, #e05252); cursor:pointer; }
        .memo-batch-del:hover { border-color: var(--ah-danger, #e05252); background: var(--ah-danger-alpha, rgba(224,82,82,.12)); }
        .memo-clear-all { font:inherit; font-size:12px; padding:6px 14px; border-radius:8px; border:1px solid var(--ah-border); background:transparent; color: var(--ah-text-muted); cursor:pointer; }
        .memo-clear-all:hover { border-color: var(--ah-danger, #e05252); color: var(--ah-danger, #e05252); }
        .memo-mgmt-foot { display:flex; justify-content:space-between; align-items:center; margin-top:10px; gap:10px; flex-wrap:wrap; }
        .memo-pager { font-size:12px; color: var(--ah-text-muted); }
        .memo-pager-btns { display:flex; gap:8px; }
        .memo-page-btn { font:inherit; font-size:12px; padding:5px 14px; border-radius:8px; border:1px solid var(--ah-border); background:transparent; color: var(--ah-text); cursor:pointer; }
        .memo-page-btn:hover:not(:disabled) { border-color: var(--ah-accent); color: var(--ah-accent); }
        .memo-page-btn:disabled { opacity:.4; cursor:not-allowed; }

        .memo-table-wrap { overflow-x:auto; -webkit-overflow-scrolling:touch; }
        .memo-table { width:100%; border-collapse:collapse; font-size:12px; }
        .memo-table th, .memo-table td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--ah-border); vertical-align:top; }
        .memo-table th { color: var(--ah-text-muted); font-weight:500; white-space:nowrap; }
        .memo-table code { background: var(--ah-surface-3); padding:1px 5px; border-radius:4px; font-size:11px; }
        .memo-col-chk { width:34px; text-align:center; }

        .memo-badge { display:inline-block; padding:2px 10px; border-radius:999px; font-size:11px; font-weight:500; line-height:1.6; background: var(--ah-accent-alpha, rgba(41,151,255,.15)); color: var(--ah-accent); }
        .memo-badge-dim { background: var(--ah-surface-3); color: var(--ah-text-muted); }
        .memo-remind { display:inline-block; margin-left:8px; font-size:11px; color: var(--ah-warning, #e0a000); }
        .memo-del { font:inherit; font-size:11px; padding:2px 10px; border-radius:6px; border:1px solid var(--ah-border); background:transparent; color: var(--ah-text-muted); cursor:pointer; }
        .memo-del:hover { border-color: var(--ah-danger, #e05252); color: var(--ah-danger, #e05252); }
      </style>
    </div>`;
  }
};

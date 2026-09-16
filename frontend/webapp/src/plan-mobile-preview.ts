/**
 * 临时预览（一次性，验收后删除）：把 <ah-plan-board> 挂进「移动端应用壳」里。
 *
 * 目的：绕开登录与后端，复现 app.ts 的 .content 约束（窄屏 padding 16/14 +
 * 底部固定 Tab 栏留白）与深色主题，从而判断窄屏下的泳道布局是否成立。
 *
 * 用法：/plan-mobile-preview.html?id=demo&w=390&shell=0
 *   w      手机框宽度（默认 390）
 *   shell  0 = 不套壳、组件独占整宽（桌面回归对照用）
 */
import { installThemeStyles, setTheme } from './theme/tokens';
import type { PlanDoc } from './plan-board';
import './plan-board';

const errors: string[] = [];
window.addEventListener('error', (e) => errors.push(`ERR: ${e.message}`));
window.addEventListener('unhandledrejection', (e) =>
  errors.push(`REJ: ${String((e as PromiseRejectionEvent).reason)}`)
);

installThemeStyles();
setTheme('dark');

const params = new URLSearchParams(location.search);
const width = Number(params.get('w') ?? 390);
const withShell = params.get('shell') !== '0';

/** 造一份与线上形状一致的假计划：含空泳道（待办 0）+ 非空泳道 + 元信息。 */
const plan: PlanDoc = {
  id: 'demo',
  title:
    '制作一份关于Agent行业落地的深度研报，涵盖技术演进、行业应用案例、挑战与趋势，面向企业管理者与技术决策者',
  version: 22,
  updatedBy: 'huyang',
  updatedAt: new Date().toISOString(),
  nodes: [
    { id: 'n5', title: '5. 撰写「行业应用案例」章节（金融 / 制造 / 客服）', status: 'doing', dependsOn: ['n2'], assignee: 'huyang' },
    { id: 'n6', title: '6. 梳理技术演进时间线（Prompt → RAG → Agent 框架）', status: 'doing', dependsOn: ['n3'], comments: [{ author: 'me', text: '补 2025 年框架对比', ts: '' }] },
    { id: 'n7', title: '7. 整理挑战与风险小节，补 3 个失败案例', status: 'doing', dependsOn: [] },
    { id: 'n1', title: '1. 确认研报定位与目标读者', status: 'done', dependsOn: [] },
    { id: 'n2', title: '2. 拆解大纲：技术演进 / 应用案例 / 挑战 / 趋势', status: 'done', dependsOn: ['n1'] },
    { id: 'n3', title: '3. 检索 2024-2025 年公开研报与论文', status: 'done', dependsOn: [] },
    { id: 'n4', title: '4. 归纳 Agent 落地的四类典型场景', status: 'done', dependsOn: ['n3'], assignee: 'huyang' },
    { id: 'n8', title: '8. 汇总数据图表（市场规模 / 渗透率）', status: 'done', dependsOn: [] },
    { id: 'n9', title: '9. 校对术语一致性', status: 'done', dependsOn: [], assignee: 'lisi' },
    { id: 'n10', title: '10. 统一引用格式', status: 'done', dependsOn: [] },
    { id: 'n11', title: '11. 生成目录与摘要', status: 'done', dependsOn: [] },
    { id: 'n12', title: '12. 评审并修订第三章', status: 'done', dependsOn: [] },
    { id: 'n13', title: '13. 整理附录：厂商清单', status: 'done', dependsOn: [] },
    { id: 'n14', title: '14. 补齐参考文献', status: 'done', dependsOn: [] },
    { id: 'n15', title: '15. 排版与图示美化', status: 'done', dependsOn: [] },
    { id: 'n16', title: '16. 等待外部访谈授权（法务审批中）', status: 'blocked', dependsOn: ['n5'], assignee: 'wangwu' }
  ]
};

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}

// 桩：POST 回显请求体，便于观察「移动端改状态」是否走通乐观更新
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.includes('/api/plans') && init?.method === 'POST') {
    const patch = JSON.parse(String(init.body ?? '{}')) as Partial<PlanDoc>;
    return json({ item: { ...plan, ...patch } });
  }
  if (url.includes('/api/plans')) return json({ item: plan, items: [plan] });
  return json({ ok: true });
}) as typeof fetch;

// SSE 桩：避免 EventSource 反复重连干扰截图
class NoopEventSource {
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  close(): void {}
}
(window as unknown as { EventSource: unknown }).EventSource = NoopEventSource;

document.body.style.cssText =
  'margin:0;background:#0b0d12;display:flex;justify-content:center;align-items:flex-start';

const hostCss =
  'display:block;background:var(--ah-canvas);font-family:var(--ah-font-sans);color:var(--ah-text)';

if (withShell) {
  // 复现 app.ts 的移动端壳：固定顶栏 + .content（窄屏 padding + 底栏留白）+ 固定底栏
  const phone = document.createElement('div');
  phone.id = 'phone';
  phone.style.cssText = `position:relative;width:${width}px;height:844px;overflow:hidden;background:var(--ah-canvas);display:flex;flex-direction:column`;
  phone.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid var(--ah-border);background:var(--ah-surface-1)">
      <span style="font-size:18px;line-height:1">☰</span>
      <strong style="font-size:14px">计划</strong>
    </div>
    <div id="content" style="flex:1 1 auto;min-height:0;overflow-y:auto;padding:16px 14px calc(48px + 16px);display:block;box-sizing:border-box">
      <ah-plan-board style="${hostCss}"></ah-plan-board>
    </div>
    <nav style="position:absolute;left:0;right:0;bottom:0;height:48px;display:flex;align-items:center;justify-content:space-around;background:var(--ah-surface-1);box-shadow:0 -2px 8px rgba(0,0,0,.3);font-size:10px;color:var(--ah-text-faint)">
      <span>工作台</span><span>对话</span><span style="color:var(--ah-accent)">计划</span><span>设置</span><span>我的</span>
    </nav>`;
  document.body.appendChild(phone);
} else {
  const el = document.createElement('ah-plan-board');
  el.setAttribute('style', `${hostCss};width:100%`);
  document.body.appendChild(el);
}

const board = document.querySelector('ah-plan-board') as
  | (HTMLElement & { updateComplete?: Promise<unknown> })
  | null;

void (async () => {
  await board?.updateComplete;
  await new Promise((r) => setTimeout(r, 400));

  const sr = board?.shadowRoot;
  const q = <T extends Element>(sel: string): T | null => sr?.querySelector(sel) as T | null;
  const qa = (sel: string): Element[] => Array.from(sr?.querySelectorAll(sel) ?? []);
  const cs = (el: Element | null, prop: string): string =>
    el ? getComputedStyle(el).getPropertyValue(prop).trim() : 'n/a';
  const rect = (el: Element | null): string =>
    el ? `${Math.round(el.getBoundingClientRect().width)}x${Math.round(el.getBoundingClientRect().height)}@${Math.round(el.getBoundingClientRect().top)}` : 'n/a';

  const boardEl = q('.board');
  const moveRows = qa('.move-row');
  const empties = qa('.column-empty').filter((e) => getComputedStyle(e).display !== 'none');

  const lines = [
    `ERRORS=${errors.length ? errors.join(' | ') : 'none'}`,
    `VIEWPORT=${document.documentElement.clientWidth}x${document.documentElement.clientHeight}`,
    `NODES=${qa('.node-card').length} COLUMNS=${qa('.column').length}`,
    `BOARD_DIR=${cs(boardEl, 'flex-direction')} BOARD_RECT=${rect(boardEl)}`,
    `BOARD_OVERFLOW_X=${boardEl ? boardEl.scrollWidth - boardEl.clientWidth : -1}`,
    `HOST_OVERFLOW_X=${board ? board.scrollWidth - board.clientWidth : -1}`,
    `COL_RECTS=${qa('.column').map((c) => `${c.className.split(' ').filter((x) => x !== 'column').join('+') || 'full'}:${rect(c)}`).join(' , ')}`,
    `PROGRESS=${cs(q('.plan-progress'), 'display')} TEXT=${q('.plan-progress')?.textContent?.replace(/\s+/g, ' ').trim() ?? 'n/a'}`,
    `EMPTY_VISIBLE=${empties.length} TEXT=${empties[0]?.textContent?.trim() ?? 'n/a'}`,
    `MOVE_ROW=${moveRows.length} DISPLAY=${moveRows[0] ? getComputedStyle(moveRows[0]).display : 'n/a'}`,
    `HEADER_DIR=${cs(q('.header'), 'flex-direction')} HEADER_RECT=${rect(q('.header'))}`,
    `COLUMN_HEADER_RECT=${rect(q('.column-header'))}`,
    `PAGE_SCROLL_H=${document.getElementById('content')?.scrollHeight ?? -1}`
  ];

  const pre = document.createElement('pre');
  pre.id = 'dbg';
  pre.style.display = 'none';
  pre.textContent = lines.join('\n');
  document.body.appendChild(pre);

  // 可选：滚到指定位置再截图（验收中段 / 底部泳道）
  const scrollTop = Number(params.get('scroll') ?? 0);
  const content = document.getElementById('content');
  if (scrollTop && content) content.scrollTop = scrollTop;
})();

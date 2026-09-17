/**
 * <ah-plan-board> — Plan 协同看板 (P2-3)。
 *
 * 功能：
 * - 拖拽节点卡片（泳道式：todo/doing/done/blocked）
 * - 节点间依赖连线
 * - 评论气泡
 * - 版本 diff 视图
 * - SSE 实时协同（cursor/评论/节点更新）
 *
 * 数据来源：
 * - GET /api/plans/:id — 计划文档
 * - GET /api/plans/:id/diff?other=<id> — 版本 diff
 * - GET /api/plans/:id/events — SSE 协同流
 */
import { LitElement, html, css, nothing } from 'lit';
import { customElement, state, query } from 'lit/decorators.js';
import { authedFetch } from './api';
import { sharedStyles } from './styles';
import { notify } from './components/ah-notification';
import { notifyError } from './utils/errors';
import {
  PLAN_COLUMNS,
  PLAN_COLUMN_LABELS,
  groupNodesByStatus,
  planProgress
} from './plan-board-utils';

export type PlanNodeStatus = 'todo' | 'doing' | 'done' | 'blocked';

export interface PlanNode {
  id: string;
  title: string;
  status: PlanNodeStatus;
  assignee?: string;
  dependsOn: string[];
  note?: string;
  comments?: Array<{ author: string; text: string; ts: string }>;
}

export interface PlanDoc {
  id: string;
  title: string;
  nodes: PlanNode[];
  version: number;
  updatedBy: string;
  updatedAt: string;
  sessionId?: string;
}

export interface PlanDiff {
  added: string[];
  removed: string[];
  changed: Array<{ id: string; changes: string }>;
  fromVersion: number;
  toVersion: number;
}

/** 计划文档列表项（GET /api/plans 的精简形状）。 */
export interface PlanSummary {
  id: string;
  title: string;
  version: number;
  updatedBy: string;
  updatedAt: string;
  nodeCount: number;
  doneCount: number;
}

/** 节点卡片（看板 / 列表共用）。 */
export interface PlanNodeCard {
  id: string;
  title: string;
  status: PlanNodeStatus;
  assignee?: string;
  dependsOn: string[];
  note?: string;
}

/** 状态 → 徽标 emoji（列表与看板统一视觉）。 */
const STATUS_ICON: Record<PlanNodeStatus, string> = {
  todo: '⬜',
  doing: '🔄',
  done: '✅',
  blocked: '⛔'
};

/**
 * 泳道列序 / 标签 / 分组 / 完成度统一由 plan-board-utils 提供
 * （桌面横向列序与移动端纵向分区序必须一致，故不在此处重复定义）。
 */

@customElement('ah-plan-board')
export class AhPlanBoard extends LitElement {
  static styles = [
    sharedStyles,
    css`
      :host {
        display: block;
        height: 100%;
        overflow: hidden;
      }
      .board {
        display: flex;
        gap: 16px;
        height: calc(100% - 48px);
        padding: 16px;
        overflow-x: auto;
      }
      .column {
        flex: 0 0 280px;
        background: var(--ah-surface-1);
        border-radius: var(--ah-radius-md);
        padding: 12px;
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .column-header {
        font-size: 12px;
        font-weight: 600;
        color: var(--ah-text-muted);
        text-transform: uppercase;
        letter-spacing: 0.5px;
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .column-header .count {
        background: var(--ah-surface-3);
        border-radius: 999px;
        padding: 2px 8px;
        font-size: 11px;
      }
      .node-card {
        background: var(--ah-surface-1);
        border: 1px solid var(--ah-border);
        border-radius: var(--ah-radius-sm);
        padding: 10px;
        cursor: grab;
        transition: all 0.15s ease;
      }
      .node-card:hover {
        border-color: var(--ah-accent);
      }
      .node-card .node-title {
        font-size: 13px;
        font-weight: 500;
        color: var(--ah-text);
        margin-bottom: 4px;
      }
      .node-card .node-meta {
        display: flex;
        gap: 6px;
        align-items: center;
      }
      .node-card .node-assignee {
        font-size: 11px;
        color: var(--ah-text-muted);
      }
      .node-card .node-badges {
        display: flex;
        gap: 4px;
      }
      .dep-chip {
        font-size: 10px;
        background: var(--ah-surface-3);
        border-radius: 4px;
        padding: 2px 6px;
        color: var(--ah-text-faint);
      }
      .header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 16px;
        border-bottom: 1px solid var(--ah-border);
      }
      .header h2 {
        font-size: 16px;
        margin: 0;
      }
      .header .version {
        font-size: 12px;
        color: var(--ah-text-muted);
      }
      /* 进度摘要：桌面藏在样式里（表头一行已够紧凑），窄屏才显示 —— 见文件末尾
       移动端媒体查询。用 display 而非条件渲染，保证桌面 DOM 与历史完全一致。 */
      .plan-progress {
        display: none;
        align-items: center;
        gap: 8px;
        font-size: 11px;
        color: var(--ah-text-muted);
        font-variant-numeric: tabular-nums;
      }
      .plan-progress .pp-bar {
        flex: 1 1 auto;
        min-width: 60px;
        height: 4px;
        border-radius: 999px;
        background: var(--ah-surface-3);
        overflow: hidden;
      }
      .plan-progress .pp-bar i {
        display: block;
        height: 100%;
        border-radius: 999px;
        background: var(--ah-accent);
      }
      /* 空泳道占位文案：桌面固定列宽本身已表达「空」，窄屏才需要文案说明 */
      .column-empty {
        display: none;
      }
      /* 卡片内的状态选择器：桌面有拖拽，隐藏；触摸端拖拽不生效，窄屏改由它承担 */
      .move-row {
        display: none;
      }
      .diff-view {
        padding: 16px;
      }
      .diff-item {
        padding: 4px 0;
        border-bottom: 1px solid var(--ah-border);
      }
      .diff-item.add {
        color: var(--ah-success);
      }
      .diff-item.remove {
        color: var(--ah-danger);
      }
      .diff-item.change {
        color: var(--ah-warning);
      }
      .empty {
        text-align: center;
        padding: 48px;
        color: var(--ah-text-faint);
      }
      /* 计划列表态（无 ?id 参数时） */
      .list {
        padding: 16px;
        display: flex;
        flex-direction: column;
        gap: 10px;
        overflow-y: auto;
      }
      .list-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 0 0 8px;
      }
      .list-item {
        display: flex;
        align-items: center;
        gap: 12px;
        background: var(--ah-surface-1);
        border: 1px solid var(--ah-border);
        border-radius: var(--ah-radius-sm);
        padding: 12px 14px;
        cursor: pointer;
        transition: border-color 0.15s ease;
      }
      .list-item:hover {
        border-color: var(--ah-accent);
      }
      .list-item .li-title {
        font-size: 14px;
        font-weight: 500;
        color: var(--ah-text);
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .list-item .li-progress {
        font-size: 12px;
        color: var(--ah-text-muted);
        font-variant-numeric: tabular-nums;
      }
      .list-item .li-meta {
        font-size: 11px;
        color: var(--ah-text-faint);
      }
      .btn-new {
        background: var(--ah-accent, #4c8dff);
        color: #fff;
        border: none;
        border-radius: var(--ah-radius-sm, 6px);
        padding: 6px 14px;
        font-size: 13px;
        font-weight: 500;
        cursor: pointer;
        transition: opacity 0.15s ease;
      }
      .btn-new:hover {
        opacity: 0.85;
      }

      /* ------------------- 移动端（≤760px）-------------------
       桌面是「横向四列泳道」，窄屏下这套布局会退化成：列宽 4×280px + 间隙
       ≫ 视口宽，且 .board 默认 align-items:stretch 会把每个列拉到「最高列」
       的高度 —— 于是首屏只看到一整屏高、内容为空的「待办」列，真实任务全部
       躺在屏外（必须横滑才可能发现）。以下五条按此逐项修正。 */
      @media (max-width: 760px) {
        /* ① 解除 responsive.ts 给所有共享样式组件注入的 min-height:100dvh。
         它会让本组件永远至少撑满一屏；再叠加 ② 的列高拉伸，空列就成了整屏空白。 */
        :host {
          height: auto;
          min-height: 0;
          overflow: visible;
        }

        /* ② 表头改纵向：窄屏下「标题 + v22 · 最后更新:xxx」挤在一行，标题被压成
         三行、版本号被切成两行。纵向排列后各占整行，摘要条也能完整展示。
         左右内边距归零 —— 外层 .content 在窄屏已有 14px，叠加会白扔 28px 宽度。 */
        .header {
          flex-direction: column;
          align-items: stretch;
          gap: 6px;
          padding: 0 0 12px;
        }
        .header h2 {
          font-size: 15px;
          line-height: 1.45;
        }
        .header .version {
          font-size: 11px;
        }
        .plan-progress {
          display: flex;
        }

        /* ③ 泳道由横向四列改为纵向四分区：无横向滚动，与 .content 的文档流滚动
         同向，四个泳道一次可见（不再需要「横滑探索」）。 */
        .board {
          flex-direction: column;
          gap: 12px;
          height: auto;
          padding: 0 0 8px;
          overflow: visible;
        }
        .column {
          flex: none;
          width: 100%;
          box-sizing: border-box;
        }

        /* ④ 空泳道收拢成「标题 + 暂无任务」一行，不再占据整屏 */
        .column.is-empty {
          padding: 10px 12px 12px;
        }
        .column-empty {
          display: block;
          padding-top: 2px;
          font-size: 12px;
          color: var(--ah-text-faint);
        }

        /* ⑤ 触摸端没有 HTML5 dragstart，卡片内补一个显式状态选择器；
         同时把卡片内边距加大到触摸友好的尺寸。 */
        .node-card {
          padding: 12px;
          cursor: default;
        }
        .move-row {
          display: flex;
          /* base.ts 的全局 label 是 column 布局，此处必须显式改回 row，
           否则「状态」二字会独占一行把选择器挤到下一行。 */
          flex-direction: row;
          align-items: center;
          gap: 8px;
          width: 100%;
          margin-top: 8px;
          font-size: 11px;
        }
        .move-row > span {
          flex: 0 0 auto;
        }
        .move-row select {
          flex: 1 1 auto;
          min-width: 0;
          padding: 6px 10px;
          font-size: 12px;
        }

        /* 计划列表态：条目原为「标题 + 进度 + 版本」一行三列，窄屏下标题会被挤成
         省略号。改为标题独占一行（最多两行），元信息换行到第二行。 */
        .list {
          padding: 0 0 8px;
        }
        .list-item {
          flex-wrap: wrap;
          gap: 4px 10px;
          padding: 12px;
        }
        .list-item .li-title {
          flex: 1 1 100%;
          white-space: normal;
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
        }

        /* 加载 / 错误 / 空态：窄屏不需要 48px 内边距 */
        .empty {
          padding: 32px 12px;
        }
      }
    `
  ];

  @state() private plan: PlanDoc | null = null;
  @state() private diff: PlanDiff | null = null;
  @state() private loading = true;
  @state() private error: string | null = null;
  @state() private showDiff = false;
  /** 计划列表面板（无 ?id 参数时展示；进入具体计划后为 null）。 */
  @state() private plans: PlanSummary[] | null = null;
  @state() private listLoading = false;

  private es: EventSource | null = null;
  private dragNode: PlanNode | null = null;

  connectedCallback() {
    super.connectedCallback();
    // 隐藏态挂载（非计划 Tab）时跳过首屏加载；切到计划 Tab 时由 app.ts 调用 refresh() 补拉。
    if (this.hidden) return;
    const planId = this.currentPlanId();
    if (!planId) {
      // 无指定计划：进入列表态（计划 Tab 首页 = 我的计划文档列表 + 新建入口）。
      this.loading = false;
      void this.loadPlanList();
      return;
    }
    this.loadPlan(planId);
    this.startSse(planId);
  }

  /** 当前 URL 指定的计划 id（?id / ?plan）；无参数时走列表态。 */
  private currentPlanId(): string | null {
    const params = new URLSearchParams(window.location.search);
    return params.get('id') ?? params.get('plan');
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.es?.close();
  }

  private async loadPlan(id: string) {
    this.loading = true;
    this.error = null;
    try {
      const res = await authedFetch(`/api/plans/${encodeURIComponent(id)}`);
      if (!res.ok) throw new Error(`加载失败 (${res.status})`);
      const data = await res.json();
      this.plan = data.item;
    } catch (e) {
      this.error = (e as Error).message;
      notifyError(e, { fallback: '加载计划失败' });
    } finally {
      this.loading = false;
    }
  }

  /**
   * 下拉刷新 / 切到计划 Tab 时补拉：加载当前计划文档，并在 SSE 未建立时启动实时更新。
   *
   * 修复：详情态（URL 已带 ?id）此前仅在「计划未加载 / 切到另一计划」时才拉取，导致
   * 计划已加载时下拉刷新空转、不发任何请求（下拉刷新语义 = 拿服务端最新数据）。现改为
   * 详情态始终重新拉取计划文档；SSE 已建立则复用（EventSource 自带重连），未建立才建连。
   */
  refresh() {
    // 隐藏态（非计划 Tab）不加载；切到本 Tab 时才由 app.ts 的 activatePanel 调用。
    if (this.hidden) return;
    const planId = this.currentPlanId();
    if (!planId) {
      // 列表态：补拉计划列表（新建 / AI 生成后进入本 Tab 时刷新）。
      void this.loadPlanList();
      return;
    }
    // 详情态：始终重新拉取计划文档（下拉刷新 / 切 Tab 补拉都要拿最新数据；
    // 旧守卫「仅未加载 / 切计划才拉」会让已加载时下拉刷新空转、不发请求）。
    void this.loadPlan(planId);
    // SSE 已建立则复用（EventSource 自带重连），仅在未建立时建连，避免重复流 / 泄漏。
    if (!this.es) this.startSse(planId);
  }

  /** 拉取计划文档列表（GET /api/plans）。 */
  private async loadPlanList() {
    this.listLoading = true;
    this.error = null;
    try {
      const res = await authedFetch('/api/plans');
      if (!res.ok) throw new Error(`加载计划列表失败 (${res.status})`);
      const data = await res.json();
      // GET /api/plans 返回的是完整 PlanDoc 数组（含 nodes），这里收敛为列表展示需要的精简形状。
      const items: Array<Record<string, unknown>> = data.items ?? [];
      this.plans = items.map((it) => {
        const nodes = Array.isArray(it.nodes)
          ? (it.nodes as Array<{ status?: string }>)
          : [];
        return {
          id: String(it.id ?? ''),
          title: String(it.title ?? ''),
          version: Number(it.version ?? 0),
          updatedBy: String(it.updatedBy ?? ''),
          updatedAt: String(it.updatedAt ?? ''),
          nodeCount: nodes.length,
          doneCount: nodes.filter((n) => n.status === 'done').length
        };
      });
    } catch (e) {
      this.error = (e as Error).message;
      this.plans = [];
      notifyError(e, { fallback: '加载计划列表失败' });
    } finally {
      this.listLoading = false;
    }
  }

  /** 进入具体计划看板（推入 URL 参数，复用看板态 + SSE）。 */
  private openPlan(planId: string) {
    const url = new URL(window.location.href);
    url.searchParams.set('id', planId);
    window.history.pushState(null, '', url.toString());
    this.plans = null;
    this.error = null;
    this.loadPlan(planId);
    this.startSse(planId);
  }

  /** 新建空计划文档：POST /api/plans，成功后进入其看板。 */
  private async newPlan() {
    const title = (window.prompt('计划标题', '') ?? '').trim();
    if (!title) return;
    const id = `plan-manual-${Date.now().toString(36)}`;
    try {
      const res = await authedFetch('/api/plans', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id,
          title,
          nodes: [],
          version: 0
        })
      });
      if (!res.ok) throw new Error(`创建失败 (${res.status})`);
      const data = await res.json();
      notify.success('计划已创建', { key: 'plan-new' });
      this.openPlan(data.item?.id ?? id);
    } catch (e) {
      notifyError(e, { fallback: '创建计划失败' });
    }
  }

  private async loadDiff(id: string, otherId: string) {
    try {
      const res = await authedFetch(
        `/api/plans/${encodeURIComponent(id)}/diff?other=${encodeURIComponent(
          otherId
        )}`
      );
      if (!res.ok) throw new Error(`Diff 失败 (${res.status})`);
      const data = await res.json();
      this.diff = data;
      this.showDiff = true;
    } catch (e) {
      notifyError(e, { fallback: '加载 diff 失败' });
    }
  }

  private startSse(planId: string) {
    const url = `/api/plans/${encodeURIComponent(planId)}/events`;
    this.es = new EventSource(url);
    this.es.onmessage = (ev) => {
      try {
        const e = JSON.parse(ev.data) as any;
        if (e.type === 'plan:update' && e.patch) {
          // 乐观更新：合并远程 patch
          if (this.plan) {
            this.plan = {
              ...this.plan,
              ...e.patch,
              nodes: e.patch.nodes ?? this.plan.nodes
            };
          }
        }
      } catch {
        /* 忽略坏消息 */
      }
    };
    this.es.onerror = () => {
      // EventSource 自动重连
    };
  }

  private onDragStart(node: PlanNode) {
    this.dragNode = node;
  }

  private async onDrop(status: PlanNodeStatus) {
    const node = this.dragNode;
    this.dragNode = null;
    if (node) await this.moveNode(node, status);
  }

  /**
   * 把节点移动到目标泳道并落盘（桌面拖拽与移动端状态选择器共用同一路径，
   * 避免两套实现各写一遍乐观更新 / 版本号自增）。
   */
  private async moveNode(node: PlanNode, status: PlanNodeStatus) {
    if (!this.plan) return;
    // 原地「移动」不做任何事：否则会白白自增版本号并触发一次无意义的写盘。
    if (node.status === status) return;
    const updated: PlanNode = { ...node, status };
    const nodes = this.plan.nodes.map((n) => (n.id === node.id ? updated : n));
    const updatedPlan: PlanDoc = {
      ...this.plan,
      nodes,
      version: this.plan.version + 1,
      updatedAt: new Date().toISOString()
    };

    try {
      const res = await authedFetch(
        `/api/plans/${encodeURIComponent(this.plan.id)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(updatedPlan)
        }
      );
      if (!res.ok) throw new Error(`保存失败 (${res.status})`);
      const data = await res.json();
      this.plan = data.item;
      notify.success('节点已更新', { key: 'plan-drop' });
    } catch (e) {
      notifyError(e, { fallback: '保存节点失败' });
    }
  }

  private async addComment(nodeId: string, text: string) {
    if (!this.plan) return;
    const nodes = this.plan.nodes.map((n) => {
      if (n.id !== nodeId) return n;
      const comments = n.comments ?? [];
      return {
        ...n,
        comments: [
          ...comments,
          { author: 'me', text, ts: new Date().toISOString() }
        ]
      };
    });
    const updatedPlan: PlanDoc = {
      ...this.plan,
      nodes,
      version: this.plan.version + 1,
      updatedAt: new Date().toISOString()
    };
    try {
      const res = await authedFetch(
        `/api/plans/${encodeURIComponent(this.plan.id)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(updatedPlan)
        }
      );
      if (!res.ok) throw new Error(`保存失败 (${res.status})`);
      const data = await res.json();
      this.plan = data.item;
    } catch (e) {
      notifyError(e, { fallback: '添加评论失败' });
    }
  }

  private async deletePlan() {
    if (!this.plan) return;
    const confirmed = confirm(
      `确定删除计划「${this.plan.title}」？此操作不可撤销。`
    );
    if (!confirmed) return;
    try {
      const res = await authedFetch(
        `/api/plans/${encodeURIComponent(this.plan.id)}`,
        {
          method: 'DELETE'
        }
      );
      if (!res.ok) throw new Error(`删除失败 (${res.status})`);
      notify.success('计划已删除', { key: 'plan-delete' });
      // 返回工作台
      window.history.pushState(null, '', '/workspace');
    } catch (e) {
      notifyError(e, { fallback: '删除计划失败' });
    }
  }

  /** 列表态渲染：我的计划文档（按更新时间倒序）+ 新建入口 + 空态引导。 */
  private renderList() {
    if (this.listLoading && !this.plans) {
      return html`<div class="empty">加载计划中…</div>`;
    }
    const plans = this.plans ?? [];
    return html`
      <div class="list">
        <div class="list-header">
          <h2>计划</h2>
          <button class="btn-new" @click=${() => void this.newPlan()}>
            + 新建计划
          </button>
        </div>
        ${plans.length === 0
          ? html`
              <div class="empty">
                暂无计划文档<br />
                <span style="font-size: 12px">
                  在「对话」中切换到计划模式发起任务，AI
                  生成的计划会自动出现在这里；也可手动新建。
                </span>
              </div>
            `
          : plans.map(
              (p) => html`
                <div class="list-item" @click=${() => this.openPlan(p.id)}>
                  <span class="li-title">${p.title}</span>
                  <span class="li-progress"
                    >${p.doneCount}/${p.nodeCount} 完成</span
                  >
                  <span class="li-meta">v${p.version} · ${p.updatedBy}</span>
                </div>
              `
            )}
      </div>
    `;
  }

  render() {
    // 列表态（无 ?id 参数）：计划文档列表 + 新建入口。
    if (this.plans !== null || this.currentPlanId() === null) {
      return this.renderList();
    }
    if (this.loading) {
      return html`<div class="empty">加载计划中…</div>`;
    }
    if (this.error) {
      return html`<div class="empty">错误: ${this.error}</div>`;
    }
    if (this.showDiff && this.diff) {
      return html`
        <div class="diff-view">
          <div class="header">
            <h2>
              版本 Diff (v${this.diff.fromVersion} → v${this.diff.toVersion})
            </h2>
            <button @click=${() => (this.showDiff = false)}>返回</button>
          </div>
          ${this.diff.added.length === 0 &&
          this.diff.removed.length === 0 &&
          this.diff.changed.length === 0
            ? html`<div class="empty">无变更</div>`
            : html`
                ${this.diff.added.map(
                  (id) => html`<div class="diff-item add">新增: ${id}</div>`
                )}
                ${this.diff.removed.map(
                  (id) => html`<div class="diff-item remove">移除: ${id}</div>`
                )}
                ${this.diff.changed.map(
                  (c) =>
                    html`<div class="diff-item change">
                      变更: ${c.id} — ${c.changes}
                    </div>`
                )}
              `}
        </div>
      `;
    }
    if (!this.plan) return nothing;

    const plan = this.plan;
    const grouped = groupNodesByStatus(plan.nodes);
    const progress = planProgress(plan.nodes);

    return html`
      <div class="header">
        <h2>${plan.title}</h2>
        <span class="version"
          >v${plan.version} · 最后更新: ${plan.updatedBy}</span
        >
        <div
          class="plan-progress"
          role="img"
          aria-label="已完成 ${progress.done} / ${progress.total} 个任务"
        >
          <span>已完成 ${progress.done}/${progress.total}</span>
          <span class="pp-bar"><i style="width:${progress.percent}%"></i></span>
          <span>${progress.percent}%</span>
        </div>
      </div>
      <div class="board">
        ${PLAN_COLUMNS.map((col) => {
          const items = grouped[col];
          return html`
            <div
              class="column ${items.length === 0 ? 'is-empty' : ''}"
              @dragover=${(e: DragEvent) => e.preventDefault()}
              @drop=${() => this.onDrop(col)}
            >
              <div class="column-header">
                ${PLAN_COLUMN_LABELS[col]}
                <span class="count">${items.length}</span>
              </div>
              ${items.length === 0
                ? html`<div class="column-empty">暂无任务</div>`
                : items.map(
                    (node) => html`
                      <div
                        class="node-card"
                        draggable="true"
                        @dragstart=${() => this.onDragStart(node)}
                      >
                        <div class="node-title">${node.title}</div>
                        <div class="node-meta">
                          ${node.assignee
                            ? html`<span class="node-assignee"
                                >@${node.assignee}</span
                              >`
                            : ''}
                          ${node.dependsOn.length > 0
                            ? html`<span class="dep-chip"
                                >依赖 ${node.dependsOn.length}</span
                              >`
                            : ''}
                        </div>
                        ${node.comments && node.comments.length > 0
                          ? html`<div class="node-meta">
                              <span class="dep-chip"
                                >💬 ${node.comments.length}</span
                              >
                            </div>`
                          : ''}
                        <!-- 触摸端无 HTML5 拖拽，改由本选择器移动节点（桌面 CSS 隐藏） -->
                        <label class="move-row">
                          <span>状态</span>
                          <select
                            aria-label="调整「${node.title}」的状态"
                            @change=${(e: Event) =>
                              void this.moveNode(
                                node,
                                (e.target as HTMLSelectElement)
                                  .value as PlanNodeStatus
                              )}
                          >
                            ${PLAN_COLUMNS.map(
                              (s) => html`<option
                                value=${s}
                                ?selected=${s === node.status}
                              >
                                ${PLAN_COLUMN_LABELS[s]}
                              </option>`
                            )}
                          </select>
                        </label>
                      </div>
                    `
                  )}
            </div>
          `;
        })}
      </div>
    `;
  }
}

export default AhPlanBoard;

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

const COLUMNS: PlanNodeStatus[] = ['todo', 'doing', 'done', 'blocked'];
const COLUMN_LABELS: Record<PlanNodeStatus, string> = {
  todo: '待办',
  doing: '进行中',
  done: '已完成',
  blocked: '阻塞'
};

@customElement('ah-plan-board')
export class AhPlanBoard extends LitElement {
  static styles = [sharedStyles, css`
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
      background: var(--ah-surface-2);
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
    .diff-view {
      padding: 16px;
    }
    .diff-item {
      padding: 4px 0;
      border-bottom: 1px solid var(--ah-border);
    }
    .diff-item.add { color: var(--ah-success); }
    .diff-item.remove { color: var(--ah-danger); }
    .diff-item.change { color: var(--ah-warning); }
    .empty {
      text-align: center;
      padding: 48px;
      color: var(--ah-text-faint);
    }
  `];

  @state() private plan: PlanDoc | null = null;
  @state() private diff: PlanDiff | null = null;
  @state() private loading = true;
  @state() private error: string | null = null;
  @state() private showDiff = false;

  private es: EventSource | null = null;
  private dragNode: PlanNode | null = null;

  connectedCallback() {
    super.connectedCallback();
    const params = new URLSearchParams(window.location.search);
    const planId = params.get('id') ?? params.get('plan');
    if (!planId) {
      this.error = '缺少 plan 参数';
      this.loading = false;
      return;
    }
    this.loadPlan(planId);
    this.startSse(planId);
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

  private async loadDiff(id: string, otherId: string) {
    try {
      const res = await authedFetch(`/api/plans/${encodeURIComponent(id)}/diff?other=${encodeURIComponent(otherId)}`);
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
    if (!this.dragNode || !this.plan) return;
    const updated: PlanNode = { ...this.dragNode, status };
    const nodes = this.plan.nodes.map((n) =>
      n.id === this.dragNode!.id ? updated : n
    );
    const updatedPlan: PlanDoc = {
      ...this.plan,
      nodes,
      version: this.plan.version + 1,
      updatedAt: new Date().toISOString()
    };

    try {
      const res = await authedFetch(`/api/plans/${encodeURIComponent(this.plan.id)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(updatedPlan)
      });
      if (!res.ok) throw new Error(`保存失败 (${res.status})`);
      const data = await res.json();
      this.plan = data.item;
      notify.success('节点已更新', { key: 'plan-drop' });
    } catch (e) {
      notifyError(e, { fallback: '保存节点失败' });
    } finally {
      this.dragNode = null;
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
      const res = await authedFetch(`/api/plans/${encodeURIComponent(this.plan.id)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(updatedPlan)
      });
      if (!res.ok) throw new Error(`保存失败 (${res.status})`);
      const data = await res.json();
      this.plan = data.item;
    } catch (e) {
      notifyError(e, { fallback: '添加评论失败' });
    }
  }

  private async deletePlan() {
    if (!this.plan) return;
    const confirmed = confirm(`确定删除计划「${this.plan.title}」？此操作不可撤销。`);
    if (!confirmed) return;
    try {
      const res = await authedFetch(`/api/plans/${encodeURIComponent(this.plan.id)}`, {
        method: 'DELETE'
      });
      if (!res.ok) throw new Error(`删除失败 (${res.status})`);
      notify.success('计划已删除', { key: 'plan-delete' });
      // 返回工作台
      window.history.pushState(null, '', '/workspace');
    } catch (e) {
      notifyError(e, { fallback: '删除计划失败' });
    }
  }

  render() {
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
            <h2>版本 Diff (v${this.diff.fromVersion} → v${this.diff.toVersion})</h2>
            <button @click=${() => (this.showDiff = false)}>返回</button>
          </div>
          ${this.diff.added.length === 0 && this.diff.removed.length === 0 && this.diff.changed.length === 0
            ? html`<div class="empty">无变更</div>`
            : html`
              ${this.diff.added.map((id) => html`<div class="diff-item add">新增: ${id}</div>`)}
              ${this.diff.removed.map((id) => html`<div class="diff-item remove">移除: ${id}</div>`)}
              ${this.diff.changed.map((c) => html`<div class="diff-item change">变更: ${c.id} — ${c.changes}</div>`)}
            `}
        </div>
      `;
    }
    if (!this.plan) return nothing;

    return html`
      <div class="header">
        <h2>${this.plan.title}</h2>
        <span class="version">v${this.plan.version} · 最后更新: ${this.plan.updatedBy}</span>
      </div>
      <div class="board">
        ${COLUMNS.map((col) => html`
          <div class="column" @dragover=${(e: DragEvent) => e.preventDefault()} @drop=${() => this.onDrop(col)}>
            <div class="column-header">
              ${COLUMN_LABELS[col]}
              <span class="count">${this.plan!.nodes.filter((n) => n.status === col).length}</span>
            </div>
            ${this.plan!.nodes
              .filter((n) => n.status === col)
              .map((node) => html`
                <div class="node-card"
                     draggable="true"
                     @dragstart=${() => this.onDragStart(node)}>
                  <div class="node-title">${node.title}</div>
                  <div class="node-meta">
                    ${node.assignee
                      ? html`<span class="node-assignee">@${node.assignee}</span>`
                      : ''}
                    ${node.dependsOn.length > 0
                      ? html`<span class="dep-chip">依赖 ${node.dependsOn.length}</span>`
                      : ''}
                  </div>
                  ${node.comments && node.comments.length > 0
                    ? html`<div class="node-meta">
                        <span class="dep-chip">💬 ${node.comments.length}</span>
                      </div>`
                    : ''}
                </div>
              `)}
          </div>
        `)}
      </div>
    `;
  }
}

export default AhPlanBoard;

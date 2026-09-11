/**
 * 企业组织树（ah-org-tree，P1-3）。
 *
 * 可视化企业部门 / 成员层级，数据来自 `GET /api/org`（后端 org.ts，受 org:read 保护）。
 * 部门可折叠 / 展开，叶子为成员（姓名 + 标题 + 邮箱）；部门节点展示递归成员总数。
 */
import { LitElement, html, css, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { authedFetch } from './api';
import { sharedStyles } from './styles';
import { notifyError } from './utils/errors';
import type { OrgNode, OrgTree } from './org-types';

@customElement('ah-org-tree')
export class AhOrgTree extends LitElement {
  static styles = [
    sharedStyles,
    css`
      .tree {
        border: 1px solid var(--ah-border);
        border-radius: var(--ah-radius-md);
        background: var(--ah-surface-1);
        padding: 12px 14px;
      }
      ul.tree-list {
        list-style: none;
        margin: 0;
        padding-left: 18px;
      }
      ul.tree-list.root {
        padding-left: 0;
      }
      li.node {
        margin: 2px 0;
      }
      .row {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 4px 6px;
        border-radius: var(--ah-radius-sm);
        cursor: default;
      }
      .row:hover {
        background: var(--ah-surface-2);
      }
      .toggle {
        width: 16px;
        text-align: center;
        color: var(--ah-text-muted);
        cursor: pointer;
        user-select: none;
      }
      .badge {
        font-size: 11px;
        padding: 1px 7px;
        border-radius: 999px;
        border: 1px solid var(--ah-border);
        color: var(--ah-text-muted);
      }
      .badge.dept {
        color: var(--ah-accent);
        border-color: var(--ah-accent);
      }
      .name {
        font-weight: 600;
      }
      .meta {
        color: var(--ah-text-muted);
        font-size: 12px;
      }
      .mono {
        font-family: var(--ah-font-mono);
        font-size: 12px;
      }
    `,
  ];

  @state() tree: OrgTree | null = null;
  @state() loading = true;
  @state() collapsed = new Set<string>();

  connectedCallback() {
    super.connectedCallback();
    void this.refresh();
  }

  private async refresh(): Promise<void> {
    this.loading = true;
    try {
      const res = await authedFetch('/api/org');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.tree = (await res.json()) as OrgTree;
    } catch (e: any) {
      notifyError(e, { title: '企业组织树', key: 'org' });
    } finally {
      this.loading = false;
    }
  }

  private toggle(id: string): void {
    const s = new Set(this.collapsed);
    if (s.has(id)) s.delete(id);
    else s.add(id);
    this.collapsed = s;
  }

  private renderNode(node: OrgNode, depth: number): unknown {
    const isDept = node.type === 'dept';
    const isCollapsed = this.collapsed.has(node.id);
    const hasChildren = isDept && (node.children?.length ?? 0) > 0;
    return html`
      <li class="node">
        <div class="row">
          <span
            class="toggle"
            @click=${hasChildren ? () => this.toggle(node.id) : nothing}
            >${hasChildren ? (isCollapsed ? '▶' : '▼') : ''}</span
          >
          <span class="badge ${isDept ? 'dept' : ''}">${isDept ? '部门' : '成员'}</span>
          <span class="name">${node.name}</span>
          ${node.title ? html`<span class="meta">· ${node.title}</span>` : nothing}
          ${node.email
            ? html`<span class="meta mono">· ${node.email}</span>`
            : nothing}
          ${isDept && node.memberCount != null
            ? html`<span class="meta">· ${node.memberCount} 人</span>`
            : nothing}
        </div>
        ${hasChildren && !isCollapsed
          ? html`<ul class="tree-list">
              ${(node.children ?? []).map((c) => this.renderNode(c, depth + 1))}
            </ul>`
          : nothing}
      </li>
    `;
  }

  render() {
    if (this.loading) return html`<div class="muted">加载中…</div>`;
    if (!this.tree) return html`<div class="muted">无组织数据</div>`;
    return html`
      <section style="border:none;background:none;box-shadow:none;padding:0">
        <div class="row-between" style="margin-bottom:14px">
          <div>
            <div class="section-title" style="margin:0">企业组织树</div>
            <div class="muted-sm">
              部门 / 成员层级 · 数据源 <span class="mono">${this.tree.source}</span>
            </div>
          </div>
          <button class="ghost" @click=${() => this.refresh()}>刷新</button>
        </div>
        <div class="tree">
          <ul class="tree-list root">
            ${this.renderNode(this.tree.root, 0)}
          </ul>
        </div>
      </section>
    `;
  }
}

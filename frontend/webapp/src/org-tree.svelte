<script lang="ts">
  import { onMount } from 'svelte';
  import { authedFetch } from './api';
  import { notifyError } from './utils/errors';
  import type { OrgNode, OrgTree } from './org-types';

  let { visible = true }: { visible?: boolean } = $props();

  let tree: OrgTree | null = $state(null);
  let loading = $state(true);
  let collapsed = $state(new Set<string>());

  onMount(() => {
    void refresh();
  });

  export async function refresh(): Promise<void> {
    // 隐藏态挂载（非当前 Tab）时不发起首屏请求；切到本 Tab 时由 app 壳的 activatePanel 补拉。
    if (!visible) return;
    loading = true;
    try {
      const res = await authedFetch('/api/org');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      tree = (await res.json()) as OrgTree;
    } catch (e: any) {
      notifyError(e, { title: '企业组织树', key: 'org' });
    } finally {
      loading = false;
    }
  }

  function toggle(id: string): void {
    const s = new Set(collapsed);
    if (s.has(id)) s.delete(id);
    else s.add(id);
    collapsed = s;
  }
</script>

<div class="ah-c org-tree-root" hidden={!visible}>
  {#if loading}
    <div class="muted">加载中…</div>
  {:else if !tree}
    <div class="muted">无组织数据</div>
  {:else}
    <section style="border:none;background:none;box-shadow:none;padding:8px">
      <div class="row-between" style="margin-bottom:14px">
        <div>
          <div class="section-title" style="margin:0">企业组织树</div>
          <div class="muted-sm">
            部门 / 成员层级 · 数据源
            <span class="mono">{tree.source}</span>
          </div>
        </div>
        <button class="ghost refresh-btn" onclick={() => refresh()}>
          刷新
        </button>
      </div>
      <div class="tree">
        <ul class="tree-list root">
          {@render renderNode(tree.root, 0)}
        </ul>
      </div>
    </section>
  {/if}
</div>

{#snippet renderNode(node: OrgNode, depth: number)}
  {@const isDept = node.type === 'dept'}
  {@const isCollapsed = collapsed.has(node.id)}
  {@const hasChildren = isDept && (node.children?.length ?? 0) > 0}
  <li class="node">
    <div class="row">
      <span
        class="toggle"
        role="button"
        tabindex="0"
        aria-label={isCollapsed ? '展开' : '收起'}
        onclick={hasChildren ? () => toggle(node.id) : undefined}
        onkeydown={hasChildren
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                toggle(node.id);
              }
            }
          : undefined}
        >{hasChildren ? (isCollapsed ? '▶' : '▼') : ''}</span
      >
      <span class="badge {isDept ? 'dept' : ''}"
        >{isDept ? '部门' : '成员'}</span
      >
      <span class="name">{node.name}</span>
      {#if node.title}
        <span class="meta">· {node.title}</span>
      {/if}
      {#if node.email}
        <span class="meta mono">· {node.email}</span>
      {/if}
      {#if isDept && node.memberCount != null}
        <span class="meta">· {node.memberCount} 人</span>
      {/if}
    </div>
    {#if hasChildren && !isCollapsed}
      <ul class="tree-list">
        {#each node.children ?? [] as c (c.id)}
          {@render renderNode(c, depth + 1)}
        {/each}
      </ul>
    {/if}
  </li>
{/snippet}

<style>
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
</style>

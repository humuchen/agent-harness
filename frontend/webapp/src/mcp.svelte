<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { client } from './api';
  import type { McpServerMeta, McpPreset } from '@agent-harness/client';
  import { reportError } from './panels-utils';
  import { notify } from './components/ah-notification';
  import { APP_EVENTS } from './app-events';

  let { visible = true }: { visible?: boolean } = $props();

  let servers: McpServerMeta[] = $state([]);
  let presets: McpPreset[] = $state([]);

  /** 添加服务表单的状态 */
  let addForm = $state({
    name: '',
    type: 'http' as 'http' | 'stdio',
    url: '',
    command: '',
    params: '',
    envs: {} as Record<string, string>,
    /** HTTP/SSE 传输类型（auto 由服务端探测）。 */
    transportType: 'auto' as 'auto' | 'sse' | 'streamable-http',
    /** HTTP/SSE 自定义请求头（如鉴权 Bearer）。 */
    headers: {} as Record<string, string>
  });

  /** 添加/接入操作是否进行中（防重复点击） */
  let adding = $state(false);
  /** 已接入列表是否展开 */
  let serversExpanded = $state(true);
  /** 每个服务器的工具列表是否展开（key: server name） */
  let toolsExpanded: Record<string, boolean> = $state({});

  /** 预设市场按 id 暂存的 token（bearer 型预设接入时透传）。 */
  let tokens: Record<string, string> = $state({});

  /** 根元素引用：visibility 探测与 APP_EVENTS.refresh 事件派发。 */
  let rootEl: HTMLElement;

  /** 已接入列表自动刷新定时器（连接状态变化无需手动刷新）。 */
  let refreshTimer: number | null | undefined = null; // window.setInterval 句柄（DOM 类型）
  const REFRESH_INTERVAL_MS = 10000;

  onMount(() => {
    void refresh();
    startAutoRefresh();
    // 监听页面可见性变化：后台 / 最小化时暂停轮询，恢复时重连。
    document.addEventListener('visibilitychange', onVisibilityChange);
  });

  onDestroy(() => {
    stopAutoRefresh();
    document.removeEventListener('visibilitychange', onVisibilityChange);
  });

  /** 页面可见性变化处理：隐藏时停止轮询，显示时重启（若仍在 DOM 中）。 */
  const onVisibilityChange = () => {
    if (document.hidden) {
      stopAutoRefresh();
    } else {
      startAutoRefresh();
      void refresh(true);
    }
  };

  /** 只有面板可见（根元素隐藏时 offsetParent 为 null）时才启动轮询。 */
  function startAutoRefresh() {
    // 若面板被隐藏（display:none）则不轮询，避免浪费请求。
    if (!rootEl || rootEl.offsetParent === null) return;
    if (refreshTimer) return; // 防重复
    refreshTimer = window.setInterval(
      () => void refresh(true),
      REFRESH_INTERVAL_MS
    );
  }

  function stopAutoRefresh() {
    if (refreshTimer) {
      window.clearInterval(refreshTimer);
      refreshTimer = undefined;
    }
  }

  export async function refresh(silent = false): Promise<void> {
    // 隐藏态挂载（非当前 Tab）时不发起首屏请求；切到本 Tab 时由 app 壳的 activatePanel 补拉。
    if (!visible) return;
    try {
      const [s, p] = await Promise.all([
        client.getMcpServers(),
        client.getMcpPresets()
      ]);
      servers = s.servers;
      presets = p.presets;
    } catch (e) {
      // 静默刷新（自动轮询）不弹错误，避免刷屏；手动刷新仍报错。
      if (!silent) reportError('mcp', e);
    }
  }

  async function add() {
    if (adding) return;
    adding = true;
    // 先取名字（重置表单前），避免「未命名」误报。
    const addedName = addForm.name.trim() || '未命名';
    const envEntries = Object.entries(addForm.envs).filter(([k]) => k);
    const headerEntries = Object.entries(addForm.headers).filter(
      ([k]) => k
    );
    try {
      if (addForm.type === 'http') {
        await client.addMcpServer({
          name: addForm.name,
          url: addForm.url,
          transportType:
            addForm.transportType === 'auto'
              ? undefined
              : addForm.transportType,
          headers:
            headerEntries.length > 0
              ? (Object.fromEntries(headerEntries) as Record<string, string>)
              : undefined
        });
      } else {
        // stdio: Command + Params（空格分割）+ Envs
        const params = addForm.params.trim().split(/\s+/).filter(Boolean);
        await client.addMcpServer({
          name: addForm.name,
          command: addForm.command,
          args: params,
          env:
            envEntries.length > 0
              ? (Object.fromEntries(envEntries) as Record<string, string>)
              : undefined
        });
      }
      addForm = {
        name: '',
        type: 'http',
        url: '',
        command: '',
        params: '',
        envs: {},
        transportType: 'auto',
        headers: {}
      };
      await refresh();
      notify.success(`MCP 服务「${addedName}」已接入`);
      rootEl.dispatchEvent(
        new CustomEvent(APP_EVENTS.refresh, { bubbles: true, composed: true })
      );
    } catch (e) {
      reportError('mcp', e);
    } finally {
      adding = false;
    }
  }

  /**
   * 移除已接入的 MCP 服务。
   * （原方法名注释：不能叫 remove —— HTMLElement 自带 remove()，同名冲突。）
   */
  async function removeServer(name: string) {
    if (adding) return;
    adding = true;
    try {
      await client.removeMcp(name);
      await refresh();
      notify.success(`已移除 MCP 服务「${name}」`);
      rootEl.dispatchEvent(
        new CustomEvent(APP_EVENTS.refresh, { bubbles: true, composed: true })
      );
    } catch (e) {
      reportError('mcp', e);
    } finally {
      adding = false;
    }
  }

  async function preset(id: string, token?: string) {
    if (adding) return;
    adding = true;
    try {
      await client.connectMcpPreset(id, token);
      await refresh();
      notify.success('预设市场服务接入成功');
      rootEl.dispatchEvent(
        new CustomEvent(APP_EVENTS.refresh, { bubbles: true, composed: true })
      );
    } catch (e) {
      reportError('mcp', e);
    } finally {
      adding = false;
    }
  }
</script>

<div class="ah-c mcp-root" bind:this={rootEl} hidden={!visible}>
  <div class="mcp-layout">
    <h2>MCP 服务</h2>
    <div class="two">
      <!-- 左栏：添加表单卡片 + 已接入列表 -->
      <div class="stack">
        <div class="card">
          <div class="section-title">添加服务</div>
          <label
            >名称<input
              placeholder="输入名称"
              value={addForm.name}
              oninput={(e: Event) =>
                (addForm = {
                  ...addForm,
                  name: (e.target as HTMLInputElement).value
                })}
          /></label>
          <div class="row" style="margin-top:8px">
            <label class="radio"
              ><input
                type="radio"
                name="type"
                value="http"
                checked={addForm.type === 'http'}
                onchange={() => (addForm = { ...addForm, type: 'http' })}
              />
              SSE/HTTP</label
            >
            <label class="radio"
              ><input
                type="radio"
                name="type"
                value="stdio"
                checked={addForm.type === 'stdio'}
                onchange={() => (addForm = { ...addForm, type: 'stdio' })}
              />
              STDIO</label
            >
          </div>
          {#if addForm.type === 'http'}
            <label class="grow"
              >URL<input
                value={addForm.url}
                oninput={(e: Event) =>
                  (addForm = {
                    ...addForm,
                    url: (e.target as HTMLInputElement).value
                  })}
                placeholder="https://..."
            /></label>
            <label class="grow"
              >传输类型<select
                value={addForm.transportType}
                onchange={(e: Event) =>
                  (addForm = {
                    ...addForm,
                    transportType: (e.target as HTMLSelectElement)
                      .value as 'auto' | 'sse' | 'streamable-http'
                  })}
              >
                <option value="auto">自动探测</option>
                <option value="sse">SSE</option>
                <option value="streamable-http">Streamable HTTP</option>
              </select></label
            >
          {:else}
            <label class="grow"
              >Command<input
                value={addForm.command}
                oninput={(e: Event) =>
                  (addForm = {
                    ...addForm,
                    command: (e.target as HTMLInputElement).value
                  })}
                placeholder="npx"
            /></label>
          {/if}
          {#if addForm.type === 'stdio'}
            <label class="grow"
              >Params<input
                value={addForm.params}
                oninput={(e: Event) =>
                  (addForm = {
                    ...addForm,
                    params: (e.target as HTMLInputElement).value
                  })}
                placeholder="-y @tokenizin/mcp-npx-fetch"
            /></label>
          {/if}
          {#if Object.keys(addForm.envs).length > 0}
            <div class="env-list">
              {#each Object.entries(addForm.envs) as [k, v]}
                <div class="row">
                  <input
                    value={k}
                    oninput={(e: Event) => {
                      const nk = (e.target as HTMLInputElement).value;
                      const next = { ...addForm.envs };
                      delete next[k];
                      next[nk] = v;
                      addForm = { ...addForm, envs: next };
                    }}
                    placeholder="KEY"
                  />
                  <input
                    value={v}
                    oninput={(e: Event) =>
                      (addForm = {
                        ...addForm,
                        envs: {
                          ...addForm.envs,
                          [k]: (e.target as HTMLInputElement).value
                        }
                      })}
                    placeholder="VALUE"
                  />
                  <button
                    class="ghost"
                    onclick={() => {
                      const { [k]: _removed, ...rest } = addForm.envs;
                      addForm = { ...addForm, envs: rest };
                    }}
                  >
                    ✕
                  </button>
                </div>
              {/each}
            </div>
          {/if}
          {#if addForm.type === 'stdio'}
            <div class="row" style="margin-top:8px">
              <button
                class="ghost"
                onclick={() =>
                  (addForm = {
                    ...addForm,
                    envs: { ...addForm.envs, '': '' }
                  })}
              >
                + 添加环境变量
              </button>
            </div>
          {/if}
          {#if addForm.type === 'http'}
            <div class="section-sub">
              自定义请求头（如鉴权 Bearer）
            </div>
            {#if Object.keys(addForm.headers).length > 0}
              <div class="env-list">
                {#each Object.entries(addForm.headers) as [k, v]}
                  <div class="row">
                    <input
                      value={k}
                      oninput={(e: Event) => {
                        const nk = (e.target as HTMLInputElement)
                          .value;
                        const next = { ...addForm.headers };
                        delete next[k];
                        next[nk] = v;
                        addForm = {
                          ...addForm,
                          headers: next
                        };
                      }}
                      placeholder="Header"
                    />
                    <input
                      value={v}
                      oninput={(e: Event) =>
                        (addForm = {
                          ...addForm,
                          headers: {
                            ...addForm.headers,
                            [k]: (e.target as HTMLInputElement)
                              .value
                          }
                        })}
                      placeholder="Value"
                    />
                    <button
                      class="ghost"
                      onclick={() => {
                        const { [k]: _removed, ...rest } =
                          addForm.headers;
                        addForm = {
                          ...addForm,
                          headers: rest
                        };
                      }}
                    >
                      ✕
                    </button>
                  </div>
                {/each}
              </div>
            {/if}
            <div class="row" style="margin-top:8px">
              <button
                class="ghost"
                onclick={() =>
                  (addForm = {
                    ...addForm,
                    headers: { ...addForm.headers, '': '' }
                  })}
              >
                + 添加请求头
              </button>
            </div>
          {/if}
          <div class="row" style="margin-top:12px">
            <button onclick={() => add()} disabled={adding}>
              {adding ? '连接中...' : '添加'}
            </button>
            <button
              class="ghost refresh-btn"
              onclick={() => refresh()}
            >
              刷新
            </button>
          </div>
        </div>
        <div class="card mcp-server-list">
          <div
            class="section-title collapsible"
            onclick={() => (serversExpanded = !serversExpanded)}
          >
            <span>已接入</span>
            <span class="chevron">{serversExpanded ? '▼' : '▶'}</span>
          </div>
          {#if serversExpanded}
            <ul class="list">
              {#each servers as s (s.name)}
                <li class="mcp-server-item">
                  <div
                    class="mcp-server-header"
                    onclick={() =>
                      (toolsExpanded = {
                        ...toolsExpanded,
                        [s.name]: !toolsExpanded[s.name]
                      })}
                  >
                    <div>
                      <b>{s.name}</b> · {s.status} · {s.toolCount}
                      工具
                    </div>
                    {#if s.url}
                      <div
                        style="font-size:12px;color:var(--ah-text-dim,#8b93a7);word-break:break-all;margin-top:4px"
                        title={s.url ?? ''}
                      >
                        🔗 {s.url}
                      </div>
                    {/if}
                    {#if s.toolCount > 0}
                      <span class="chevron"
                        >{toolsExpanded[s.name]
                          ? '▼'
                          : '▶'}</span
                      >
                    {/if}
                  </div>
                  {#if s.status === 'error' && s.error}
                    <div class="mcp-err">⚠ {s.error}</div>
                  {/if}
                  {#if toolsExpanded[s.name] && s.tools.length > 0}
                    <ul class="mcp-tools">
                      {#each s.tools as t}
                        <li class="mcp-tool-item">
                          <div class="mcp-tool-name">
                            {t.originalName}
                          </div>
                          {#if t.description}
                            <div
                              class="mcp-tool-desc"
                              title={t.description}
                            >
                              {t.description.length > 80
                                ? t.description.slice(0, 80) + '...'
                                : t.description}
                            </div>
                          {/if}
                        </li>
                      {/each}
                    </ul>
                  {/if}
                  <div class="mcp-server-actions">
                    <button
                      class="ghost"
                      onclick={(e: Event) => {
                        e.stopPropagation();
                        void removeServer(s.name);
                      }}
                    >
                      移除
                    </button>
                  </div>
                </li>
              {/each}
            </ul>
            {#if servers.length === 0}
              <p class="muted">暂无已接入服务</p>
            {/if}
          {/if}
        </div>
      </div>

      <!-- 右栏：预设市场卡片 -->
      <div class="card">
        <div class="section-title">预设市场</div>
        <ul class="list">
          {#each presets as p (p.id)}
            <li class="preset">
              <div class="preset-head">
                <b>{p.name}</b>
                <span class="chip">{p.authType}</span>
                {#if p.recommended}
                  <span class="chip ok">推荐</span>
                {/if}
              </div>
              {#if p.note}
                <div class="muted preset-note">{p.note}</div>
              {/if}
              {#if p.oneClick === false}
                <div class="row" style="margin-top:8px">
                  <a
                    class="ghost-link"
                    href={(p.docUrl as string | undefined) ?? '#'}
                    target="_blank"
                    rel="noopener"
                    >查看接入说明 ›</a
                  >
                </div>
              {:else}
                <div class="row" style="margin-top:8px">
                  {#if p.authType === 'bearer'}
                    <label class="grow preset-token"
                      >{p.authLabel ?? 'Token'}<input
                        value={tokens[p.id] ?? ''}
                        oninput={(e: Event) =>
                          (tokens = {
                            ...tokens,
                            [p.id]: (e.target as HTMLInputElement).value
                          })}
                        placeholder={(p.authPlaceholder as string | undefined) ?? ''}
                    /></label>
                  {/if}
                  <button
                    onclick={() => void preset(p.id, tokens[p.id])}
                    disabled={adding}
                  >
                    {adding ? '连接中...' : '一键接入'}
                  </button>
                </div>
              {/if}
            </li>
          {/each}
        </ul>
        {#if presets.length === 0}
          <p class="muted">暂无预设</p>
        {/if}
      </div>
    </div>
  </div>
</div>

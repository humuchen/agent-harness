/**
 * provider-key-settings：用户自带 LLM 凭据（BYOK）设置面板 —— Svelte 迁移版。
 *
 * 对应需求：移除环境写死 Key 后，让每个登录用户自己到 OpenRouter 取 Key 并填入，
 * 按用户加密落库，运行期按用户注入。
 *
 * 安全约束（与后端一致）：
 *  - 明文 Key 仅经 HTTPS 传给服务端，由服务端 AES-GCM 加密落库（前端零密钥材料）。
 *  - GET 仅回掩码 key_hint + 状态，密文 / 明文永不出网。
 *  - 样式全部走 --ah-* 令牌；提示统一走 notify.* / notifyError，禁止内联红条。
 *
 * 该组件由 settings-center 的「模型与密钥」分组承载；model-picker 底部「配置 API Key」
 * 按钮经 ah-goto（detail 为 tab:'settings'、group:'keys'）直达该面板。
 */
<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { authedFetch } from '../api';
  import { notify } from './ah-notification';
  import { notifyError, errorMessage } from '../utils/errors';
  import { APP_EVENTS } from '../app-events';

  interface ProviderKeyPublic {
    provider: string;
    baseUrl?: string;
    keyHint: string;
    status: 'unverified' | 'valid' | 'invalid';
    lastVerifiedAt?: number;
    lastError?: string;
    /** P2.4 本 provider 的 Key 总数（主 Key + 附加 Key）。 */
    keyCount?: number;
    /** P2.3 是否已到轮换阈值，前端据此提示用户轮换。 */
    needsRotation?: boolean;
  }

  interface UsageSnapshot {
    concurrency: number;
    tokensUsed: number;
    costUsed: number;
    windowStart: number;
  }

  const PROVIDERS: Array<{ id: string; label: string; docUrl: string }> = [
    {
      id: 'openrouter',
      label: 'OpenRouter',
      docUrl: 'https://openrouter.ai/keys'
    },
    {
      id: 'openai',
      label: 'OpenAI',
      docUrl: 'https://platform.openai.com/api-keys'
    },
    {
      id: 'custom',
      label: '自定义兼容端点',
      docUrl: 'https://openrouter.ai/keys'
    },
    {
      id: 'typesafe',
      label: 'TypeSafe AI (Jev)',
      docUrl: 'https://typesafe.ai'
    }
  ];

  /** 当前登录用户名（可选，仅用于展示「这是谁的 Key」）。 */
  let { username = '' }: { username?: string } = $props();

  let provider = $state('openrouter');
  let keys: ProviderKeyPublic[] = $state([]);
  let loading = $state(false);
  let editing = $state(false);
  let draftApiKey = $state('');
  let draftBaseUrl = $state('');
  /** P2.4 附加 Key（多 Key 一行一个或逗号分隔），与草稿主 Key 一起保存。 */
  let draftExtraKeys = $state('');
  let saving = $state(false);
  let verifying = $state(false);
  /** P2.2 per-owner 用量快照。 */
  let usage: UsageSnapshot | null = $state(null);
  /** P2.1 OpenRouter OAuth 是否可用（取决于后端是否配置了 client id）。 */
  let oauthEnabled = $state(false);
  let oauthing = $state(false);

  /** 当前选中 provider 的已保存条目（若有）。 */
  let current = $derived(keys.find((k) => k.provider === provider));

  let docUrl = $derived(
    PROVIDERS.find((p) => p.id === provider)?.docUrl ??
      'https://openrouter.ai/keys'
  );

  /** P2.1 拉取 OpenRouter OAuth 是否可用。 */
  async function loadOAuthConfig() {
    try {
      const res = await authedFetch(
        '/api/account/oauth/config?provider=openrouter'
      );
      if (!res.ok) return;
      const data = (await res.json()) as { enabled?: boolean };
      oauthEnabled = !!data.enabled;
    } catch {
      /* 忽略：未配置则入口不显示 */
    }
  }

  /** P2.1/P1-1 发起 OpenRouter OAuth（PKCE）授权流程。
   * P1-1 起授权 URL 由服务端 /oauth/start 签发（服务端生成 verifier + 签名 state）：
   * verifier 不再经前端流转，state 无法伪造（login-CSRF / 账号固定防护）。 */
  async function startOAuth() {
    if (oauthing) return;
    oauthing = true;
    try {
      const res = await authedFetch(
        '/api/account/oauth/start?provider=openrouter'
      );
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data?.error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as { authorizeUrl?: string };
      if (!data.authorizeUrl) throw new Error('OpenRouter OAuth 未配置');
      window.open(data.authorizeUrl, 'oauth', 'width=640,height=720');
      notify.info('已在弹窗中打开 OpenRouter 授权页，请完成授权', {
        title: 'API Key'
      });
    } catch (e) {
      oauthing = false;
      notifyError(e, {
        title: 'API Key',
        fallback: '发起 OpenRouter 授权失败',
        key: 'oauth-start'
      });
    }
  }

  /** 从后端拉取本账号全部 provider Key（脱敏）。 */
  async function load() {
    loading = true;
    try {
      const res = await authedFetch('/api/account/provider-keys');
      if (!res.ok) {
        if (res.status === 401) return;
        throw new Error(`HTTP ${res.status}`);
      }
      const data = (await res.json()) as { keys?: ProviderKeyPublic[] };
      keys = data.keys ?? [];
    } catch (e) {
      notifyError(e, {
        title: 'API Key',
        fallback: '加载已保存的 API Key 失败',
        key: 'provider-keys-load'
      });
    } finally {
      loading = false;
    }
  }

  /** P2.2 拉取本账号 per-owner 用量快照（代币 / 成本 / 并发 / 轮换提示）。 */
  async function loadUsage() {
    try {
      const res = await authedFetch('/api/account/usage');
      if (!res.ok) return;
      const data = (await res.json()) as {
        usage?: UsageSnapshot;
      };
      usage = data.usage ?? null;
    } catch {
      /* 用量看板为辅助信息，失败不影响主流程 */
    }
  }

  function selectProvider(id: string) {
    provider = id;
    editing = false;
    draftApiKey = '';
    draftExtraKeys = '';
    draftBaseUrl = current?.baseUrl ?? '';
  }

  /** 保存（PUT）：明文 Key 经 HTTPS 传给服务端加密落库。
   *  编辑既有 Key 时留空 = 保留已保存的 Key（明文永不出网，无法回显）；
   *  此时可仅更新接口地址。粘贴新值则全量替换（含附加 Key）。 */
  async function save() {
    const rawApiKey = draftApiKey.trim();
    // P2.4 多 Key：把主 Key + 附加 Key 归一为 keys 数组（逗号 / 换行分隔，去空白去空）。
    const extras = draftExtraKeys
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean);
    const baseUrl = draftBaseUrl.trim();
    const existing =
      !!current?.keyCount && (current?.keyCount ?? 0) > 0;

    // 归一最终提交的 keys：
    //  - 主 Key 非空 → [主 Key, ...附加 Key]（全量替换）；
    //  - 主 Key 空但填了附加 Key → 以第一个附加 Key 升为主 Key（全量替换）；
    //  - 全空且有既有 Key → 保留模式（不传 keys，仅按需更新 baseUrl）。
    const allKeys = rawApiKey
      ? [rawApiKey, ...extras]
      : extras.length
        ? extras
        : [];
    const preserved = allKeys.length === 0;
    if (preserved && !existing) {
      notify.warning('请先粘贴你的 API Key', {
        title: 'API Key',
        key: 'pk-empty'
      });
      return;
    }
    // 非 openrouter provider 的接口地址必填：
    //  - 首次配置（无既有 Key）必须填写；
    //  - 保留模式（全空）若清掉已保存地址会令该 provider 失去端点，同样须填写。
    if (
      !baseUrl &&
      provider !== 'openrouter' &&
      (!existing || preserved)
    ) {
      notify.warning('请填写接口地址', {
        title: 'API URL',
        key: 'pk-baseurl-empty'
      });
      return;
    }

    saving = true;
    try {
      const body: Record<string, unknown> = preserved
        ? { ...(baseUrl ? { baseUrl } : {}) }
        : preserved === false && allKeys.length > 1
          ? { keys: allKeys, ...(baseUrl ? { baseUrl } : {}) }
          : { apiKey: allKeys[0] ?? '', ...(baseUrl ? { baseUrl } : {}) };
      // 保留模式下 baseUrl 为空且 provider 非 openrouter：服务端只更新已保存行
      //（base_url 传 undefined 时后端不动该行），无需带 baseUrl。
      const res = await authedFetch(
        `/api/account/provider-keys/${provider}`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body)
        }
      );
      if (!res.ok) {
        const err = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(err?.error || `HTTP ${res.status}`);
      }
      if (preserved) {
        notify.success(
          `「${providerLabel(provider)}」API Key 已保留`
        );
      } else {
        notify.success(
          allKeys.length > 1
            ? `「${providerLabel(provider)}」已保存 ${allKeys.length} 把 Key`
            : `「${providerLabel(provider)}」API Key 已保存`
        );
      }
      editing = false;
      draftApiKey = '';
      draftExtraKeys = '';
      await load();
      await loadUsage();
      // 保存成功后通知顶层刷新服务端状态：顶栏「LLM live / mock」指示
      // 由 /api/v1/state 的 openrouter 字段驱动，不刷新则必须手动 reload 页面
      // 才能从 mock 切到 live（见 App 壳的 ah-refresh 监听）。
      // Svelte 版无 shadow DOM / 宿主元素，改派 window 级事件（APP_EVENTS 契约不变）。
      window.dispatchEvent(new CustomEvent(APP_EVENTS.refresh));
      // 保存后自动测试连通性，即时反馈状态（保留模式同样重验，baseUrl 变更会重置状态）。
      void verify();
    } catch (e) {
      notifyError(e, {
        title: 'API Key',
        fallback: '保存失败，请重试',
        key: 'provider-keys-save'
      });
    } finally {
      saving = false;
    }
  }

  /** 测试连通（POST verify）：调用 OpenRouter /key 校验。 */
  async function verify() {
    verifying = true;
    try {
      const res = await authedFetch(
        `/api/account/provider-keys/${provider}/verify`,
        { method: 'POST' }
      );
      if (!res.ok) {
        const err = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(err?.error || `HTTP ${res.status}`);
      }
      const data = (await res.json()) as {
        status: 'valid' | 'invalid';
        error?: string;
        limit?: number;
        usage?: number;
      };
      if (data.status === 'valid') {
        const quota =
          typeof data.limit === 'number'
            ? `（额度 $${data.limit}${
                typeof data.usage === 'number' ? `，已用 $${data.usage}` : ''
              }）`
            : '';
        notify.success(`Key 有效${quota}`);
      } else {
        notify.error('Key 无效：' + (data.error || '请检查后重试'), {
          title: 'API Key',
          key: 'pk-verify'
        });
      }
      await load();
    } catch (e) {
      notifyError(e, {
        title: 'API Key',
        fallback: '连通性测试失败',
        key: 'provider-keys-verify'
      });
    } finally {
      verifying = false;
    }
  }

  /** 删除（DELETE）。 */
  async function removeKey() {
    const label = providerLabel(provider);
    if (!confirm(`确定要删除「${label}」的 API Key 吗？此操作不可撤销。`)) {
      return;
    }
    try {
      const res = await authedFetch(
        `/api/account/provider-keys/${provider}`,
        { method: 'DELETE' }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      notify.success(`已删除「${label}」API Key`);
      editing = false;
      draftApiKey = '';
      await load();
      // 删除后同样通知顶层刷新，使「LLM live」回落为「mock」。
      window.dispatchEvent(new CustomEvent(APP_EVENTS.refresh));
    } catch (e) {
      notifyError(e, {
        title: 'API Key',
        fallback: '删除失败',
        key: 'provider-keys-del'
      });
    }
  }

  function providerLabel(id: string): string {
    return PROVIDERS.find((p) => p.id === id)?.label ?? id;
  }

  function badgeText(s: ProviderKeyPublic['status']): string {
    return s === 'valid' ? '有效' : s === 'invalid' ? '无效' : '待验证';
  }

  function startEdit() {
    editing = true;
    draftApiKey = '';
    draftExtraKeys = '';
    draftBaseUrl = current?.baseUrl ?? '';
  }

  onMount(() => {
    void load();
    void loadUsage();
    void loadOAuthConfig();
    window.addEventListener('message', onOAuthMessage);
  });

  onDestroy(() => {
    window.removeEventListener('message', onOAuthMessage);
  });

  /** OpenRouter OAuth 弹窗完成后的 postMessage 回调（provider-key-settings 发起）。 */
  const onOAuthMessage = (e: MessageEvent) => {
    const d = e.data as { type?: string; provider?: string; ok?: boolean };
    if (d?.type === 'oauth:done' && d.provider === 'openrouter' && d.ok) {
      oauthing = false;
      notify.success('OpenRouter 授权成功，已保存为 API Key');
      void load();
      void loadUsage();
      // 授权成功后通知顶层刷新，使「LLM live」即时出现。
      window.dispatchEvent(new CustomEvent(APP_EVENTS.refresh));
    }
  };
</script>

<div class="pks-root">
  <p class="intro">
    配置你自己的大模型 API Key
    后，对话将使用<strong>真实模型</strong>（按你的账号计费）。 Key
    按账号加密保存、跨设备可用，平台不托管、看不到明文。 未配置时使用离线
    Mock 模型，可正常体验流程但不消耗真实额度。
  </p>
  <div class="prov-tabs">
    {#each PROVIDERS as p (p.id)}
      <button
        class="prov-tab"
        class:active={provider === p.id}
        onclick={() => selectProvider(p.id)}
      >
        {p.label}
      </button>
    {/each}
  </div>
  <div class="card">
    {#if loading}
      <p class="hint">加载中…</p>
    {:else if editing}
      {#snippet renderForm()}
        {@const existing = !!current?.keyCount && (current?.keyCount ?? 0) > 0}
        <div class="field">
          <label
            >API Key（明文仅经 HTTPS 提交，服务端加密落库{#if existing}；留空保留已保存
              Key{/if}）</label
          >
          <input
            class="key-input"
            type="password"
            placeholder={existing
              ? '留空保留已保存 Key，或粘贴新 Key 全量替换'
              : 'sk-or-...'}
            value={draftApiKey}
            oninput={(e) => (draftApiKey = e.currentTarget.value)}
          />
          {#if existing}
            <span class="hint">
              已保存：{current?.keyHint}。出于安全，明文 Key
              不回显；如需更换请粘贴新 Key（会全量替换该服务商的全部
              Key，含附加 Key）。
            </span>
          {/if}
        </div>
        <div class="field">
          <label
            >{provider === 'openrouter'
              ? '接口地址（可选；留空用服务商默认端点）'
              : '接口地址（必填）'}</label
          >
          <input
            placeholder={provider === 'openrouter'
              ? 'https://openrouter.ai/api/v1'
              : provider === 'typesafe'
                ? 'https://api.typesafe.ai/v1'
                : `https://${provider}.com/v1`}
            value={draftBaseUrl}
            oninput={(e) => (draftBaseUrl = e.currentTarget.value)}
          />
        </div>
        <div class="field">
          <label
            >附加 Key（可选，P2.4 多 Key
            负载/故障转移：一行一个或逗号分隔）</label
          >
          <textarea
            class="extra-keys"
            rows="3"
            placeholder={'sk-or-... 第二把 Key\nsk-or-... 第三把 Key'}
            value={draftExtraKeys}
            oninput={(e) => (draftExtraKeys = e.currentTarget.value)}
          ></textarea>
          <span class="hint"
            >多 Key 时请求会在各 Key 间轮询并自动熔断失效 Key（如
            429/401），提升稳定性。</span
          >
        </div>
        <div class="actions">
          <button
            class="btn primary"
            disabled={saving}
            onclick={() => save()}
          >
            {saving ? '保存中…' : '保存'}
          </button>
          <button
            class="btn ghost"
            disabled={saving}
            onclick={() => {
              editing = false;
              draftApiKey = '';
            }}
          >
            取消
          </button>
        </div>
      {/snippet}
      {@render renderForm()}
    {:else}
      {#snippet renderCurrent()}
        {#if current}
          <div class="status-row">
            <span class="badge {current.status}">{badgeText(current.status)}</span>
            <span class="hint">{current.keyHint}</span>
            {#if typeof current.keyCount === 'number' && current.keyCount > 1}
              <span class="badge multi">{current.keyCount} 把 Key</span>
            {/if}
            {#if current.baseUrl}<span class="hint">· {current.baseUrl}</span>{/if}
          </div>
          {#if current.status === 'invalid' && current.lastError}
            <p class="err">{current.lastError}</p>
          {/if}
          {#if current.needsRotation}
            <p class="warn">
              ⚠ 该 Key
              已较长时间未轮换，建议重新保存以刷新（密钥泄露风险更低）。
            </p>
          {/if}
          <div class="actions">
            <button
              class="btn ghost"
              disabled={verifying}
              onclick={() => verify()}
            >
              {verifying ? '测试中…' : '测试连通'}
            </button>
            <button class="btn ghost" onclick={() => startEdit()}>
              编辑
            </button>
            <button class="btn danger" onclick={() => removeKey()}>
              删除
            </button>
          </div>
          {#if provider === 'openrouter' && oauthEnabled}
            <div class="actions" style="margin-top:10px">
              <button
                class="btn primary"
                disabled={oauthing}
                onclick={() => startOAuth()}
              >
                {oauthing
                  ? '授权中…'
                  : '使用 OpenRouter 授权（免粘贴）'}
              </button>
            </div>
          {/if}
        {:else}
          <p class="hint">尚未配置该服务商的 Key，点击下方按钮添加。</p>
          <div class="actions">
            <button class="btn primary" onclick={() => startEdit()}>
              添加 API Key
            </button>
          </div>
        {/if}
      {/snippet}
      {@render renderCurrent()}
    {/if}
    {#if !editing}
      <div class="actions" style="margin-top:14px">
        <a
          class="help-link"
          href={docUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          前往 {providerLabel(provider)} 获取 Key ↗
        </a>
      </div>
    {/if}
  </div>
  {#if usage}
    {@const u = usage}
    {@const cost =
      typeof u.costUsed === 'number' ? `$${u.costUsed.toFixed(4)}` : '—'}
    <div class="usage-card">
      <div class="usage-title">本账号用量（滚动窗口）</div>
      <div class="usage-grid">
        <div class="usage-item">
          <div class="usage-val">{u.tokensUsed ?? 0}</div>
          <div class="usage-label">Token 用量</div>
        </div>
        <div class="usage-item">
          <div class="usage-val">{cost}</div>
          <div class="usage-label">成本（估算）</div>
        </div>
        <div class="usage-item">
          <div class="usage-val">{u.concurrency ?? 0}</div>
          <div class="usage-label">当前并发</div>
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .pks-root {
    display: block;
    font-family: var(--ah-font-sans);
    color: var(--ah-text);
    max-width: 760px;
  }
  .intro {
    font-size: 13px;
    line-height: 1.6;
    color: var(--ah-text-muted);
    margin: 0 0 16px;
  }
  .intro a {
    color: var(--ah-accent);
    text-decoration: none;
  }
  .intro a:hover {
    text-decoration: underline;
  }
  .prov-tabs {
    display: flex;
    gap: 8px;
    margin-bottom: 14px;
    flex-wrap: wrap;
  }
  .prov-tab {
    appearance: none;
    border: 1px solid var(--ah-border);
    background: var(--ah-surface-1);
    color: var(--ah-text-muted);
    font: inherit;
    font-size: 13px;
    padding: 7px 14px;
    border-radius: 999px;
    cursor: pointer;
  }
  .prov-tab.active {
    color: #fff;
    background: var(--ah-accent);
    border-color: var(--ah-accent);
  }
  .card {
    border: 1px solid var(--ah-border);
    background: var(--ah-surface-1);
    border-radius: var(--ah-radius-md, 12px);
    padding: 16px;
  }
  .status-row {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    margin-bottom: 12px;
  }
  .badge {
    font-size: 12px;
    font-weight: 600;
    padding: 3px 10px;
    border-radius: 999px;
  }
  .badge.valid {
    color: var(--ah-success);
    background: var(--ah-success-soft);
  }
  .badge.invalid {
    color: var(--ah-danger);
    background: var(--ah-danger-soft);
  }
  .badge.unverified {
    color: var(--ah-warning);
    background: var(--ah-warning-soft);
  }
  .badge.multi {
    color: var(--ah-accent);
    background: var(--ah-accent-soft, rgba(41, 151, 255, 0.15));
  }
  .warn {
    font-size: 12px;
    color: var(--ah-warning);
    background: var(--ah-warning-soft);
    border-radius: 8px;
    padding: 7px 10px;
    margin: 6px 0 0;
    line-height: 1.5;
  }
  .extra-keys {
    background: var(--ah-surface-2, #1c1c1c);
    color: var(--ah-text);
    border: 1px solid var(--ah-border);
    border-radius: 10px;
    padding: 9px 11px;
    outline: none;
    font: inherit;
    font-size: 13px;
    resize: vertical;
    width: 100%;
    box-sizing: border-box;
  }
  .extra-keys:focus {
    border-color: var(--ah-accent);
  }
  .usage-card {
    margin-top: 18px;
    border: 1px solid var(--ah-border);
    background: var(--ah-surface-1);
    border-radius: var(--ah-radius-md, 12px);
    padding: 16px;
  }
  .usage-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--ah-text);
    margin-bottom: 12px;
  }
  .usage-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 12px;
  }
  .usage-item {
    background: var(--ah-surface-2, #1c1c1c);
    border-radius: 10px;
    padding: 12px;
    text-align: center;
  }
  .usage-val {
    font-size: 20px;
    font-weight: 700;
    color: var(--ah-accent);
    font-variant-numeric: tabular-nums;
  }
  .usage-label {
    font-size: 12px;
    color: var(--ah-text-muted);
    margin-top: 4px;
  }
  .hint {
    font-size: 12px;
    color: var(--ah-text-muted);
    font-variant-numeric: tabular-nums;
  }
  .err {
    font-size: 12px;
    color: var(--ah-danger);
    margin: 4px 0 0;
  }
  .actions {
    display: flex;
    gap: 10px;
    margin-top: 8px;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-bottom: 12px;
  }
  .field label {
    font-size: 12px;
    color: var(--ah-text-muted);
  }
  .field input {
    background: var(--ah-surface-2, #1c1c1c);
    color: var(--ah-text);
    border: 1px solid var(--ah-border);
    border-radius: 10px;
    padding: 9px 11px;
    outline: none;
    font: inherit;
    font-size: 13px;
  }
  .field input:focus {
    border-color: var(--ah-accent);
  }
  /* API Key 输入框：纯密码框（明文永不出网、不可回显，故无小眼睛切换）。 */
  .field .key-input {
    background: var(--ah-surface-2, #1c1c1c);
    color: var(--ah-text);
    border: 1px solid var(--ah-border);
    border-radius: 10px;
    padding: 9px 11px;
    outline: none;
    font: inherit;
    font-size: 13px;
    width: 100%;
    box-sizing: border-box;
  }
  .field .key-input:focus {
    border-color: var(--ah-accent);
  }
  .btn {
    min-width: 84px;
    padding: 8px 16px;
    font-size: 13px;
    font-family: var(--ah-font-sans);
    cursor: pointer;
    border-radius: var(--ah-radius-md, 10px);
    border: 1px solid var(--ah-border);
    transition: background 120ms ease, border-color 120ms ease,
      color 120ms ease;
  }
  .btn.ghost {
    background: transparent;
    color: var(--ah-text-muted);
  }
  .btn.ghost:hover {
    color: var(--ah-text);
    border-color: var(--ah-text-faint);
  }
  .btn.primary {
    background: var(--ah-accent);
    border-color: var(--ah-accent);
    color: #fff;
    font-weight: 600;
  }
  .btn.primary:hover {
    background: var(--ah-accent-strong);
    border-color: var(--ah-accent-strong);
  }
  .btn.danger {
    background: transparent;
    color: var(--ah-danger);
    border-color: var(--ah-danger);
  }
  .btn.danger:hover {
    background: var(--ah-danger-soft);
  }
  .btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
  .help-link {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    color: var(--ah-accent);
    text-decoration: none;
  }
  .help-link:hover {
    text-decoration: underline;
  }

  /* ── 移动端（≤760px，与 app / 设置中心同断点）──
     本面板嵌在设置中心的「模型与密钥」分区，此前无任何媒体查询：
     1) 三宫格用量卡在 320px 屏每格仅 ≈88px，「$0.0000」/ 7 位 token 数会溢出格子；
     2) 操作区三个按钮各 min-width 84px + gap 20px = 272px，超出卡片内宽（≈268px）横向溢出；
     3) 卡片 16px 内边距在窄屏吃掉可用宽度。 */
  @media (max-width: 760px) {
    .intro {
      margin-bottom: 14px;
    }
    .card,
    .usage-card {
      padding: 12px;
    }
    .prov-tab {
      padding: 7px 12px;
    }
    /* 三宫格保持一行：用 minmax(0,…) 允许列收缩，长数字换行而非撑破格子 */
    .usage-grid {
      gap: 8px;
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }
    .usage-item {
      padding: 10px 6px;
    }
    .usage-val {
      font-size: 17px;
      overflow-wrap: anywhere;
    }
    .usage-label {
      font-size: 11px;
    }
    /* 按钮：去掉 84px 最小宽（窄屏放不下三个），允许换行兜底 */
    .btn {
      min-width: 0;
      flex: 1 1 auto;
      padding: 9px 12px;
    }
    .actions {
      flex-wrap: wrap;
      gap: 8px;
    }
    /* 「使用 OpenRouter 授权」等独占按钮回到整行，避免被 flex 拉伸成两列 */
    .actions .btn.primary:only-child {
      flex: 1 1 100%;
    }
  }
</style>

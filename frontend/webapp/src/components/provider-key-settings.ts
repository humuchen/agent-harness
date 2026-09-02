/**
 * provider-key-settings：用户自带 LLM 凭据（BYOK）设置面板。
 *
 * 对应需求：移除环境写死 Key 后，让每个登录用户自己到 OpenRouter 取 Key 并填入，
 * 按用户加密落库，运行期按用户注入。
 *
 * 安全约束（与后端一致）：
 *  - 明文 Key 仅经 HTTPS 传给服务端，由服务端 AES-GCM 加密落库（前端零密钥材料）。
 *  - GET 仅回掩码 key_hint + 状态，密文 / 明文永不出网。
 *  - 样式全部走 --ah-* 令牌；提示统一走 notify.* / notifyError，禁止内联红条。
 *
 * 该组件被「设置」Tab 承载；model-picker 底部「配置 API Key」按钮经 ah-goto 事件切到该 Tab。
 */
import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { authedFetch } from '../api';
import { notify } from './ah-notification';
import { notifyError, errorMessage } from '../utils/errors';

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
  }
];

@customElement('ah-provider-key-settings')
export class AhProviderKeySettings extends LitElement {
  static styles = css`
    :host {
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
  `;

  /** 当前登录用户名（可选，仅用于展示「这是谁的 Key」）。 */
  @property({ attribute: false }) username = '';

  @state() private provider = 'openrouter';
  @state() private keys: ProviderKeyPublic[] = [];
  @state() private loading = false;
  @state() private editing = false;
  @state() private draftApiKey = '';
  @state() private draftBaseUrl = '';
  /** P2.4 附加 Key（多 Key 一行一个或逗号分隔），与草稿主 Key 一起保存。 */
  @state() private draftExtraKeys = '';
  @state() private saving = false;
  @state() private verifying = false;
  /** P2.2 per-owner 用量快照。 */
  @state() private usage: UsageSnapshot | null = null;
  /** P2.1 OpenRouter OAuth 是否可用（取决于后端是否配置了 client id）。 */
  @state() private oauthEnabled = false;
  @state() private oauthing = false;

  /** 当前选中 provider 的已保存条目（若有）。 */
  private get current(): ProviderKeyPublic | undefined {
    return this.keys.find((k) => k.provider === this.provider);
  }

  private get docUrl(): string {
    return (
      PROVIDERS.find((p) => p.id === this.provider)?.docUrl ??
      'https://openrouter.ai/keys'
    );
  }

  connectedCallback() {
    super.connectedCallback();
    void this.load();
    void this.loadUsage();
    void this.loadOAuthConfig();
    window.addEventListener('message', this.onOAuthMessage);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener('message', this.onOAuthMessage);
  }

  private onOAuthMessage = (e: MessageEvent) => {
    const d = e.data as { type?: string; provider?: string; ok?: boolean };
    if (d?.type === 'oauth:done' && d.provider === 'openrouter' && d.ok) {
      this.oauthing = false;
      notify.success('OpenRouter 授权成功，已保存为 API Key');
      void this.load();
      void this.loadUsage();
      // 授权成功后通知顶层刷新，使「LLM live」即时出现。
      this.dispatchEvent(
        new CustomEvent('ah-refresh', { bubbles: true, composed: true })
      );
    }
  };

  /** P2.1 拉取 OpenRouter OAuth 是否可用。 */
  private async loadOAuthConfig() {
    try {
      const res = await authedFetch(
        '/api/account/oauth/config?provider=openrouter'
      );
      if (!res.ok) return;
      const data = (await res.json()) as { enabled?: boolean };
      this.oauthEnabled = !!data.enabled;
    } catch {
      /* 忽略：未配置则入口不显示 */
    }
  }

  /** P2.1 发起 OpenRouter OAuth（PKCE）授权流程。 */
  private async startOAuth() {
    if (this.oauthing) return;
    this.oauthing = true;
    try {
      const cfgRes = await authedFetch(
        '/api/account/oauth/config?provider=openrouter'
      );
      if (!cfgRes.ok) throw new Error(`HTTP ${cfgRes.status}`);
      const cfg = (await cfgRes.json()) as {
        enabled?: boolean;
        clientId?: string;
        authorizeUrl?: string;
        redirectUri?: string;
        scopes?: string;
      };
      if (!cfg.enabled || !cfg.clientId || !cfg.authorizeUrl) {
        throw new Error('OpenRouter OAuth 未配置');
      }
      // 生成 PKCE verifier/challenge；state 复用 verifier（高熵随机，作 CSRF 防护足够）。
      const { verifier, challenge } = await this.pkce();
      const params = new URLSearchParams({
        client_id: cfg.clientId,
        redirect_uri: cfg.redirectUri ?? '',
        response_type: 'code',
        scope: cfg.scopes ?? 'openid profile',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state: verifier
      });
      const url = `${cfg.authorizeUrl}?${params.toString()}`;
      window.open(url, 'oauth', 'width=640,height=720');
      notify.info('已在弹窗中打开 OpenRouter 授权页，请完成授权', {
        title: 'API Key'
      });
    } catch (e) {
      this.oauthing = false;
      notifyError(e, {
        title: 'API Key',
        fallback: '发起 OpenRouter 授权失败',
        key: 'oauth-start'
      });
    }
  }

  /** 生成 PKCE code_verifier / code_challenge（S256）。 */
  private async pkce(): Promise<{ verifier: string; challenge: string }> {
    const buf = crypto.getRandomValues(new Uint8Array(32));
    const verifier = this.b64url(buf);
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(verifier)
    );
    const challenge = this.b64url(new Uint8Array(digest));
    return { verifier, challenge };
  }

  private b64url(buf: Uint8Array): string {
    let s = '';
    for (const b of buf) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  /** 从后端拉取本账号全部 provider Key（脱敏）。 */
  private async load() {
    this.loading = true;
    try {
      const res = await authedFetch('/api/account/provider-keys');
      if (!res.ok) {
        if (res.status === 401) return;
        throw new Error(`HTTP ${res.status}`);
      }
      const data = (await res.json()) as { keys?: ProviderKeyPublic[] };
      this.keys = data.keys ?? [];
    } catch (e) {
      notifyError(e, {
        title: 'API Key',
        fallback: '加载已保存的 API Key 失败',
        key: 'provider-keys-load'
      });
    } finally {
      this.loading = false;
    }
  }

  /** P2.2 拉取本账号 per-owner 用量快照（代币 / 成本 / 并发 / 轮换提示）。 */
  private async loadUsage() {
    try {
      const res = await authedFetch('/api/account/usage');
      if (!res.ok) return;
      const data = (await res.json()) as {
        usage?: UsageSnapshot;
      };
      this.usage = data.usage ?? null;
    } catch {
      /* 用量看板为辅助信息，失败不影响主流程 */
    }
  }

  private selectProvider(id: string) {
    this.provider = id;
    this.editing = false;
    this.draftApiKey = '';
    this.draftExtraKeys = '';
    this.draftBaseUrl = this.current?.baseUrl ?? '';
  }

  /** 保存（PUT）：明文 Key 经 HTTPS 传给服务端加密落库。 */
  private async save() {
    const apiKey = this.draftApiKey.trim();
    if (!apiKey) {
      notify.warning('请先粘贴你的 API Key', {
        title: 'API Key',
        key: 'pk-empty'
      });
      return;
    }
    const baseUrl = this.draftBaseUrl.trim();
    if (!baseUrl) {
      notify.warning('请填写接口地址', {
        title: 'API Key',
        key: 'pk-baseurl-empty'
      });
      return;
    }
    // P2.4 多 Key：把主 Key + 附加 Key 归一为 keys 数组（逗号 / 换行分隔，去空白去空）。
    const extras = this.draftExtraKeys
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean);
    const keys = [apiKey, ...extras];
    this.saving = true;
    try {
      const res = await authedFetch(
        `/api/account/provider-keys/${this.provider}`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          // 多 Key 时传 keys 数组；单 Key 时仍走旧 apiKey 字段（向后兼容）。
          body: JSON.stringify(
            extras.length
              ? { keys, ...(baseUrl ? { baseUrl } : {}) }
              : { apiKey, ...(baseUrl ? { baseUrl } : {}) }
          )
        }
      );
      if (!res.ok) {
        const err = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(err?.error || `HTTP ${res.status}`);
      }
      notify.success(
        extras.length
          ? `「${this.providerLabel(this.provider)}」已保存 ${
              keys.length
            } 把 Key`
          : `「${this.providerLabel(this.provider)}」API Key 已保存`
      );
      this.editing = false;
      this.draftApiKey = '';
      this.draftExtraKeys = '';
      await this.load();
      await this.loadUsage();
      // 保存成功后通知顶层刷新服务端状态：顶栏「LLM live / mock」指示
      // 由 /api/v1/state 的 openrouter 字段驱动，不刷新则必须手动 reload 页面
      // 才能从 mock 切到 live（见 app.ts 的 ah-refresh 监听）。
      this.dispatchEvent(
        new CustomEvent('ah-refresh', { bubbles: true, composed: true })
      );
      // 保存后自动测试连通性，即时反馈状态。
      void this.verify();
    } catch (e) {
      notifyError(e, {
        title: 'API Key',
        fallback: '保存失败，请重试',
        key: 'provider-keys-save'
      });
    } finally {
      this.saving = false;
    }
  }

  /** 测试连通（POST verify）：调用 OpenRouter /key 校验。 */
  private async verify() {
    this.verifying = true;
    try {
      const res = await authedFetch(
        `/api/account/provider-keys/${this.provider}/verify`,
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
      await this.load();
    } catch (e) {
      notifyError(e, {
        title: 'API Key',
        fallback: '连通性测试失败',
        key: 'provider-keys-verify'
      });
    } finally {
      this.verifying = false;
    }
  }

  /** 删除（DELETE）。 */
  private async removeKey() {
    const label = this.providerLabel(this.provider);
    if (!confirm(`确定要删除「${label}」的 API Key 吗？此操作不可撤销。`)) {
      return;
    }
    try {
      const res = await authedFetch(
        `/api/account/provider-keys/${this.provider}`,
        { method: 'DELETE' }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      notify.success(`已删除「${label}」API Key`);
      this.editing = false;
      this.draftApiKey = '';
      await this.load();
      // 删除后同样通知顶层刷新，使「LLM live」回落为「mock」。
      this.dispatchEvent(
        new CustomEvent('ah-refresh', { bubbles: true, composed: true })
      );
    } catch (e) {
      notifyError(e, {
        title: 'API Key',
        fallback: '删除失败',
        key: 'provider-keys-del'
      });
    }
  }

  private providerLabel(id: string): string {
    return PROVIDERS.find((p) => p.id === id)?.label ?? id;
  }

  private badgeText(s: ProviderKeyPublic['status']): string {
    return s === 'valid' ? '有效' : s === 'invalid' ? '无效' : '待验证';
  }

  private renderCurrent(): TemplateResult {
    const cur = this.current;
    if (cur) {
      return html`
        <div class="status-row">
          <span class="badge ${cur.status}">${this.badgeText(cur.status)}</span>
          <span class="hint">${cur.keyHint}</span>
          ${typeof cur.keyCount === 'number' && cur.keyCount > 1
            ? html`<span class="badge multi">${cur.keyCount} 把 Key</span>`
            : ''}
          ${cur.baseUrl ? html`<span class="hint">· ${cur.baseUrl}</span>` : ''}
        </div>
        ${cur.status === 'invalid' && cur.lastError
          ? html`<p class="err">${cur.lastError}</p>`
          : ''}
        ${cur.needsRotation
          ? html`<p class="warn">
              ⚠ 该 Key
              已较长时间未轮换，建议重新保存以刷新（密钥泄露风险更低）。
            </p>`
          : ''}
        <div class="actions">
          <button
            class="btn ghost"
            ?disabled=${this.verifying}
            @click=${() => this.verify()}
          >
            ${this.verifying ? '测试中…' : '测试连通'}
          </button>
          <button class="btn ghost" @click=${() => this.startEdit()}>
            编辑
          </button>
          <button class="btn danger" @click=${() => this.removeKey()}>
            删除
          </button>
        </div>
        ${this.provider === 'openrouter' && this.oauthEnabled
          ? html`
              <div class="actions" style="margin-top:10px">
                <button
                  class="btn primary"
                  ?disabled=${this.oauthing}
                  @click=${() => this.startOAuth()}
                >
                  ${this.oauthing
                    ? '授权中…'
                    : '使用 OpenRouter 授权（免粘贴）'}
                </button>
              </div>
            `
          : ''}
      `;
    }
    return html`
      <p class="hint">尚未配置该服务商的 Key，点击下方按钮添加。</p>
      <div class="actions">
        <button class="btn primary" @click=${() => this.startEdit()}>
          添加 API Key
        </button>
      </div>
    `;
  }

  private startEdit() {
    this.editing = true;
    this.draftApiKey = '';
    this.draftExtraKeys = '';
    this.draftBaseUrl = this.current?.baseUrl ?? '';
  }

  private renderForm(): TemplateResult {
    return html`
      <div class="field">
        <label>API Key（明文仅经 HTTPS 提交，服务端加密落库）</label>
        <input
          type="password"
          placeholder="sk-or-..."
          .value=${this.draftApiKey}
          @input=${(e: Event) =>
            (this.draftApiKey = (e.target as HTMLInputElement).value)}
        />
      </div>
      <div class="field">
        <label
          >${this.provider === 'openrouter'
            ? '接口地址（可选；留空用服务商默认端点）'
            : '接口地址（必填）'}</label
        >
        <input
          placeholder="${this.provider === 'openrouter'
            ? 'https://openrouter.ai/api/v1'
            : `https://${this.provider}.com/v1`}"
          .value=${this.draftBaseUrl}
          @input=${(e: Event) =>
            (this.draftBaseUrl = (e.target as HTMLInputElement).value)}
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
          placeholder="sk-or-... 第二把 Key&#10;sk-or-... 第三把 Key"
          .value=${this.draftExtraKeys}
          @input=${(e: Event) =>
            (this.draftExtraKeys = (e.target as HTMLTextAreaElement).value)}
        ></textarea>
        <span class="hint"
          >多 Key 时请求会在各 Key 间轮询并自动熔断失效 Key（如
          429/401），提升稳定性。</span
        >
      </div>
      <div class="actions">
        <button
          class="btn primary"
          ?disabled=${this.saving}
          @click=${() => this.save()}
        >
          ${this.saving ? '保存中…' : '保存'}
        </button>
        <button
          class="btn ghost"
          ?disabled=${this.saving}
          @click=${() => {
            this.editing = false;
            this.draftApiKey = '';
          }}
        >
          取消
        </button>
      </div>
    `;
  }

  render() {
    const cur = this.current;
    return html`
      <p class="intro">
        配置你自己的大模型 API Key
        后，对话将使用<strong>真实模型</strong>（按你的账号计费）。 Key
        按账号加密保存、跨设备可用，平台不托管、看不到明文。 未配置时使用离线
        Mock 模型，可正常体验流程但不消耗真实额度。
      </p>
      <div class="prov-tabs">
        ${PROVIDERS.map(
          (p) => html`
            <button
              class="prov-tab ${this.provider === p.id ? 'active' : ''}"
              @click=${() => this.selectProvider(p.id)}
            >
              ${p.label}
            </button>
          `
        )}
      </div>
      <div class="card">
        ${this.loading
          ? html`<p class="hint">加载中…</p>`
          : this.editing
          ? this.renderForm()
          : this.renderCurrent()}
        ${this.editing
          ? nothing
          : html`
              <div class="actions" style="margin-top:14px">
                <a
                  class="help-link"
                  href=${this.docUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  前往 ${this.providerLabel(this.provider)} 获取 Key ↗
                </a>
              </div>
            `}
      </div>
      ${this.renderUsage()}
    `;
  }

  /** P2.2 用量看板：本账号滚动窗口内的 token / 成本 / 并发快照。 */
  private renderUsage(): TemplateResult {
    if (!this.usage) return html``;
    const u = this.usage;
    const cost =
      typeof u.costUsed === 'number' ? `$${u.costUsed.toFixed(4)}` : '—';
    return html`
      <div class="usage-card">
        <div class="usage-title">本账号用量（滚动窗口）</div>
        <div class="usage-grid">
          <div class="usage-item">
            <div class="usage-val">${u.tokensUsed ?? 0}</div>
            <div class="usage-label">Token 用量</div>
          </div>
          <div class="usage-item">
            <div class="usage-val">${cost}</div>
            <div class="usage-label">成本（估算）</div>
          </div>
          <div class="usage-item">
            <div class="usage-val">${u.concurrency ?? 0}</div>
            <div class="usage-label">当前并发</div>
          </div>
        </div>
      </div>
    `;
  }
}

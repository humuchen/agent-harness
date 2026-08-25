/**
 * model-picker：模型选择器（输入框底部工具栏）。
 *
 * 参照主流客户端交互：按钮显示当前模型名，点击向上弹出面板——
 * 顶部为「思考」开关（深度思考，状态由宿主持有），
 * 中部为可搜索的模型列表（当前选中项打勾），
 * 底部提供「刷新模型」与「添加自定义模型」。
 *
 * 数据来源：内置常用模型预设 + 用户自定义模型（localStorage `ah_custom_models`）；
 * 「刷新」尝试拉取 OpenRouter 公共模型列表（无需密钥），失败时静默回退本地清单。
 * 选择结果经 `model-change` 事件抛给宿主（detail.model 为空串表示恢复服务端默认）；
 * 思考开关经 `think-change` 事件抛出（detail.value）。
 */
import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

/** 内置常用模型预设：覆盖主流厂商的代表性型号（ID 与 OpenRouter 清单核对过），用户可再自行补充。 */
const PRESET_MODELS: string[] = [
  'anthropic/claude-sonnet-4.5',
  'openai/gpt-5.2',
  'qwen/qwen3.8-max',
  'moonshotai/kimi-k3',
  'deepseek/deepseek-v4-flash',
  'minimax/minimax-m3',
  'z-ai/glm-5.3',
  'stepfun/step-3.7-flash',
  'nvidia/nemotron-3-super-120b-a12b'
];

/** 远程模型条目：id + 官方上下文窗口（token），供宿主更新「上下文用量」分母。 */
interface RemoteModel {
  id: string;
  ctx: number;
}

/** 自定义模型条目：模型名 + 可选的自定义接口地址与 API Key（直连任意 OpenAI 兼容端点）。 */
interface CustomModel {
  id: string;
  baseUrl?: string;
  apiKey?: string;
}

const CUSTOM_KEY = 'ah_custom_models';

/** 自定义模型的持久化形态兼容旧版（旧版存 string[]，读取时自动升级为对象）。 */
function normalizeCustom(raw: unknown): CustomModel[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((it): CustomModel => {
      if (typeof it === 'string') return { id: it };
      const o = it as Partial<CustomModel>;
      return {
        id: String(o?.id ?? '').trim(),
        ...(o?.baseUrl ? { baseUrl: String(o.baseUrl).trim() } : {}),
        ...(o?.apiKey ? { apiKey: String(o.apiKey).trim() } : {})
      };
    })
    .filter((m) => m.id);
}

@customElement('ah-model-picker')
export class AhModelPicker extends LitElement {
  static styles = css`
    :host {
      display: inline-block;
      position: relative;
    }
    /* 触发按钮：与 mode-select 一致的轻量文字风格 */
    .trigger {
      appearance: none;
      border: none;
      background: transparent;
      color: var(--ah-text-muted);
      font-size: 13px;
      height: 36px;
      line-height: 36px;
      padding: 0 4px;
      margin: 0;
      cursor: pointer;
      outline: none;
      display: flex;
      align-items: center;
      gap: 4px;
      max-width: 160px;
      transition: color 0.15s;
    }
    .trigger:hover {
      color: var(--ah-accent);
    }
    .trigger .name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .trigger svg {
      flex-shrink: 0;
      width: 10px;
      height: 6px;
    }

    /* 弹层面板：锚定按钮、向上展开（工具栏位于页面底部） */
    .panel {
      position: absolute;
      right: 0;
      bottom: calc(100% + 10px);
      z-index: 60;
      width: 264px;
      max-width: calc(100vw - 24px);
      max-height: min(420px, 70vh);
      display: flex;
      flex-direction: column;
      background: var(--ah-surface-1);
      border: 1px solid var(--ah-border);
      border-radius: var(--ah-radius-lg, 12px);
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.25);
      overflow: hidden;
    }

    /* 顶部：选项区（思考开关），与列表用分隔线隔开 */
    .options {
      padding: 10px 14px;
      border-bottom: 1px solid var(--ah-border);
      flex-shrink: 0;
    }
    .opt-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
    }
    .opt-label {
      font-size: 13px;
      font-weight: 600;
      color: var(--ah-text);
    }
    /* 开关：纯 CSS toggle */
    .switch {
      appearance: none;
      width: 34px;
      height: 20px;
      border-radius: 999px;
      background: var(--ah-surface-3, var(--ah-surface-2));
      border: 1px solid var(--ah-border);
      position: relative;
      cursor: pointer;
      outline: none;
      transition: background 0.15s, border-color 0.15s;
      flex-shrink: 0;
      margin: 0;
    }
    .switch::after {
      content: '';
      position: absolute;
      top: 2px;
      left: 2px;
      width: 14px;
      height: 14px;
      border-radius: 50%;
      background: var(--ah-text-muted);
      transition: transform 0.15s, background 0.15s;
    }
    .switch:checked {
      background: color-mix(
        in srgb,
        var(--ah-accent, #2997ff) 30%,
        transparent
      );
      border-color: var(--ah-accent, #2997ff);
    }
    .switch:checked::after {
      transform: translateX(14px);
      background: var(--ah-accent, #2997ff);
    }

    /* 搜索框 */
    .search-wrap {
      padding: 8px 14px;
      border-bottom: 1px solid var(--ah-border);
      flex-shrink: 0;
    }
    .search {
      width: 100%;
      box-sizing: border-box;
      background: var(--ah-surface-2);
      border: 1px solid var(--ah-border);
      border-radius: 8px;
      color: var(--ah-text);
      padding: 6px 9px;
      font-size: 12px;
      outline: none;
    }
    .search:focus {
      border-color: var(--ah-accent, #2997ff);
    }

    /* 模型列表 */
    .list {
      flex: 1 1 auto;
      overflow-y: auto;
      min-height: 60px;
      padding: 4px 0;
    }
    .item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      width: 100%;
      box-sizing: border-box;
      padding: 8px 14px;
      border: none;
      background: transparent;
      color: var(--ah-text);
      font-size: 13px;
      text-align: left;
      cursor: pointer;
      word-break: break-all;
    }
    .item:hover {
      background: var(--ah-surface-2);
    }
    .item .check {
      flex-shrink: 0;
      color: var(--ah-accent, #2997ff);
      font-weight: 700;
    }

    /* ---- 按供应商折叠的分组 ---- */
    .group + .group {
      border-top: 1px solid var(--ah-border);
    }
    .group-head {
      display: flex;
      align-items: center;
      gap: 6px;
      width: 100%;
      box-sizing: border-box;
      padding: 7px 14px;
      border: none;
      background: var(--ah-surface-2, transparent);
      color: var(--ah-text-muted);
      font-size: 11px;
      font-weight: 600;
      text-align: left;
      letter-spacing: 0.04em;
      cursor: pointer;
      transition: color 0.15s, background 0.15s;
    }
    .group-head:hover {
      color: var(--ah-text);
      background: var(--ah-surface-3, var(--ah-surface-2));
    }
    .group-head .vendor {
      flex: 1 1 auto;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      text-transform: capitalize;
    }
    .group-head .count {
      flex-shrink: 0;
      font-size: 10px;
      font-weight: 500;
      background: var(--ah-surface-3, rgba(128, 128, 128, 0.15));
      border-radius: 999px;
      padding: 0 7px;
      line-height: 16px;
    }
    .group-head .chev {
      flex-shrink: 0;
      width: 8px;
      height: 5px;
      transition: transform 0.15s;
    }
    .group-head.collapsed .chev {
      transform: rotate(-90deg);
    }
    .empty {
      padding: 16px 14px;
      color: var(--ah-text-muted);
      font-size: 12px;
      text-align: center;
    }

    /* 底部操作条 */
    .footer {
      display: flex;
      align-items: stretch;
      border-top: 1px solid var(--ah-border);
      flex-shrink: 0;
    }
    .footer button {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 5px;
      border: none;
      background: transparent;
      color: var(--ah-text-muted);
      font-size: 12px;
      padding: 10px 6px;
      cursor: pointer;
      transition: color 0.15s, background 0.15s;
    }
    .footer button:hover {
      color: var(--ah-text);
      background: var(--ah-surface-2);
    }
    .footer button + button {
      border-left: 1px solid var(--ah-border);
    }

    /* 自定义添加行：点「添加自定义模型」后展开（接口地址 / API Key / 模型名称 三项纵向堆叠） */
    .add-row {
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 8px 14px;
      border-bottom: 1px solid var(--ah-border);
      flex-shrink: 0;
    }
    .add-input {
      flex: 1;
      min-width: 0;
      box-sizing: border-box;
      background: var(--ah-surface-2);
      border: 1px solid var(--ah-border);
      border-radius: 8px;
      color: var(--ah-text);
      padding: 6px 9px;
      font-size: 12px;
      outline: none;
    }
    .add-input:focus {
      border-color: var(--ah-accent, #2997ff);
    }
    .add-ok {
      border: none;
      background: var(--ah-accent, #2997ff);
      color: #fff;
      border-radius: 8px;
      font-size: 12px;
      padding: 6px 12px;
      cursor: pointer;
    }

    /* 遮罩：点击空白处关闭（移动端友好） */
    .scrim {
      position: fixed;
      inset: 0;
      z-index: 50;
      background: transparent;
      border: none;
      padding: 0;
      cursor: default;
    }
  `;

  /** 当前模型（空串 = 服务端默认）。由宿主双向同步。 */
  @property({ type: String }) model = '';
  /** 深度思考开关（状态由宿主持有并透传）。 */
  @property({ type: Boolean }) deepThink = true;
  /** 联网搜索开关（状态由宿主持有并透传）。 */
  @property({ type: Boolean }) web = false;

  @state() private open = false;
  @state() private query = '';
  @state() private adding = false;
  /** 按供应商折叠的分组展开态（key = 供应商名；缺省全部展开）。 */
  @state() private collapsed: Record<string, boolean> = {};
  /** 自定义模型表单三项：接口地址 / API Key / 模型名称。 */
  @state() private draftBaseUrl = '';
  @state() private draftApiKey = '';
  @state() private draftId = '';
  /** 自定义模型清单（localStorage 持久化，含 baseUrl/apiKey）。 */
  @state() private customs: CustomModel[] = [];
  /** 「刷新」拉取到的在线模型清单（含官方上下文窗口；失败为空）。 */
  @state() private remote: RemoteModel[] = [];

  private loadCustoms(): CustomModel[] {
    try {
      const raw = localStorage.getItem(CUSTOM_KEY);
      const arr = raw ? (JSON.parse(raw) as unknown) : [];
      return normalizeCustom(arr);
    } catch {
      return [];
    }
  }

  private saveCustoms(list: CustomModel[]) {
    try {
      localStorage.setItem(CUSTOM_KEY, JSON.stringify(list));
    } catch {
      /* 隐私模式忽略 */
    }
  }

  connectedCallback() {
    super.connectedCallback();
    this.customs = this.loadCustoms();
  }

  /** 合并去重后的完整模型清单：远程 > 自定义 > 内置预设（各自保序）。 */
  private get allModels(): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const m of [
      ...this.remote.map((r) => r.id),
      ...this.customs.map((c) => c.id),
      ...PRESET_MODELS
    ]) {
      const k = m.trim();
      if (k && !seen.has(k)) {
        seen.add(k);
        out.push(k);
      }
    }
    return out;
  }

  /** 查询某模型的官方上下文窗口；未知返回 0（宿主据此隐藏用量展示）。 */
  private ctxFor(id: string): number {
    return this.remote.find((r) => r.id === id)?.ctx ?? 0;
  }

  private toggle(open: boolean) {
    this.open = open;
    if (!open) {
      // 关闭时重置瞬态状态，下次打开回到干净视图。
      this.query = '';
      this.adding = false;
      this.draftId = '';
      this.draftBaseUrl = '';
      this.draftApiKey = '';
    }
  }

  /** 尝试拉取 OpenRouter 公共模型列表（无需密钥）；失败静默保留本地清单。 */
  private async refreshModels() {
    try {
      const res = await fetch('https://openrouter.ai/api/v1/models');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as {
        data?: {
          id?: string;
          context_length?: number;
          pricing?: { prompt?: string; completion?: string };
        }[];
      };
      // 过滤不可用模型（选了就 429 的两类）：
      // 1) `:free` 后缀变体 —— 上游激进限速，无余额 key 调用即 429；
      // 2) 实际价格为 0 的模型（如 openrouter/free 免费池、0 价预览模型）——
      //    与 :free 同样被限速，仅靠后缀判断拦不住。
      const isFree = (
        id: string,
        pricing?: { prompt?: string; completion?: string }
      ): boolean => {
        if (id.endsWith(':free')) return true;
        try {
          return (
            (Number(pricing?.prompt) || 0) === 0 &&
            (Number(pricing?.completion) || 0) === 0
          );
        } catch {
          return false;
        }
      };
      const list: RemoteModel[] = (data.data ?? [])
        .map((m) => ({
          raw: m,
          id: String(m?.id ?? '').trim(),
          ctx: Number(m?.context_length) || 0
        }))
        .filter((m) => m.id && isFree(m.id, m.raw?.pricing))
        .map(({ id, ctx }) => ({ id, ctx }));
      if (list.length) this.remote = list;
      // 刷新后当前选中模型可能首次拿到官方窗口数据，通知宿主更新分母。
      if (this.model) this.emitCtx(this.ctxFor(this.model));
    } catch {
      /* 离线 / 被拦截：保留本地清单即可，不打扰用户 */
    }
  }

  /** 把模型上下文窗口抛给宿主（0 = 无数据，宿主应隐藏用量展示）。 */
  private emitCtx(ctx: number) {
    this.dispatchEvent(
      new CustomEvent('ctx-change', {
        detail: { ctx },
        bubbles: true,
        composed: true
      })
    );
  }

  private pick(id: string) {
    this.toggle(false);
    /**
     * 选择模型。detail.model 为空串表示清除选择（恢复服务端默认）。
     * 同时携带该模型已知的上下文窗口（0 = 无数据），宿主据此更新/隐藏用量展示。
     */
    this.dispatchEvent(
      new CustomEvent('model-change', {
        detail: { model: id, ctx: id ? this.ctxFor(id) : 0 },
        bubbles: true,
        composed: true
      })
    );
  }

  private toggleThink(e: Event) {
    const v = (e.target as HTMLInputElement).checked;
    this.dispatchEvent(
      new CustomEvent('think-change', {
        detail: { value: v },
        bubbles: true,
        composed: true
      })
    );
  }

  private toggleWeb(e: Event) {
    const v = (e.target as HTMLInputElement).checked;
    this.dispatchEvent(
      new CustomEvent('web-change', {
        detail: { value: v },
        bubbles: true,
        composed: true
      })
    );
  }

  private submitDraft() {
    const id = this.draftId.trim();
    if (!id) return;
    const baseUrl = this.draftBaseUrl.trim();
    const apiKey = this.draftApiKey.trim();
    // 同名已存在时更新其端点配置，否则插入到最前。
    const rest = this.customs.filter((c) => c.id !== id);
    this.customs = [
      {
        id,
        ...(baseUrl ? { baseUrl } : {}),
        ...(apiKey ? { apiKey } : {})
      },
      ...rest
    ];
    this.saveCustoms(this.customs);
    this.draftId = '';
    this.draftBaseUrl = '';
    this.draftApiKey = '';
    this.adding = false;
    this.pick(id);
  }

  /** 模型展示名：去掉厂商前缀（如 `openai/gpt-5.2` → `gpt-5.2`）。 */
  private displayName(id: string): string {
    const i = id.indexOf('/');
    return i >= 0 ? id.slice(i + 1) : id;
  }

  /** 模型供应商名：取 `/` 前缀；无前缀归入「其他」。 */
  private vendorOf(id: string): string {
    const i = id.indexOf('/');
    return i > 0 ? id.slice(0, i) : '其他';
  }

  /**
   * 把模型清单按供应商分组（保持清单原有顺序，供应商按首次出现排序）。
   * 搜索过滤后调用，保证折叠计数与当前可见条目一致。
   */
  private groupByVendor(
    models: string[]
  ): { vendor: string; items: string[] }[] {
    const order: string[] = [];
    const map = new Map<string, string[]>();
    for (const m of models) {
      const v = this.vendorOf(m);
      if (!map.has(v)) {
        map.set(v, []);
        order.push(v);
      }
      map.get(v)!.push(m);
    }
    return order.map((vendor) => ({ vendor, items: map.get(vendor)! }));
  }

  private toggleGroup(vendor: string) {
    this.collapsed = { ...this.collapsed, [vendor]: !this.collapsed[vendor] };
  }

  private renderPanel() {
    const q = this.query.trim().toLowerCase();
    const models = this.allModels.filter(
      (m) => !q || m.toLowerCase().includes(q)
    );
    return html`
      <button
        class="scrim"
        aria-label="关闭模型选择"
        @click=${() => this.toggle(false)}
      ></button>
      <div class="panel" role="dialog" aria-label="模型选择">
        <div class="options">
          <div class="opt-row">
            <span class="opt-label">思考</span>
            <input
              class="switch"
              type="checkbox"
              role="switch"
              aria-label="深度思考"
              .checked=${this.deepThink}
              @change=${this.toggleThink}
            />
          </div>
          <div class="opt-row" style="margin-top:8px">
            <span class="opt-label">联网搜索</span>
            <input
              class="switch"
              type="checkbox"
              role="switch"
              aria-label="联网搜索"
              .checked=${this.web}
              @change=${this.toggleWeb}
            />
          </div>
        </div>
        <div class="search-wrap">
          <input
            class="search"
            type="text"
            placeholder="搜索模型…"
            .value=${this.query}
            @input=${(e: Event) =>
              (this.query = (e.target as HTMLInputElement).value)}
          />
        </div>
        ${this.adding
          ? html`<div class="add-row">
              <input
                class="add-input"
                type="text"
                placeholder="接口地址（可选，如 https://api.example.com/v1）"
                .value=${this.draftBaseUrl}
                @input=${(e: Event) =>
                  (this.draftBaseUrl = (e.target as HTMLInputElement).value)}
              />
              <input
                class="add-input"
                type="password"
                placeholder="API Key（可选，留空用服务端默认）"
                autocomplete="off"
                .value=${this.draftApiKey}
                @input=${(e: Event) =>
                  (this.draftApiKey = (e.target as HTMLInputElement).value)}
              />
              <input
                class="add-input"
                type="text"
                placeholder="模型名称（必填，如 vendor/model-name）"
                .value=${this.draftId}
                @keydown=${(e: KeyboardEvent) => {
                  if (e.key === 'Enter') this.submitDraft();
                  if (e.key === 'Escape') this.adding = false;
                }}
                @input=${(e: Event) =>
                  (this.draftId = (e.target as HTMLInputElement).value)}
              />
              <button class="add-ok" @click=${() => this.submitDraft()}>
                添加
              </button>
            </div>`
          : nothing}
        <div class="list">
          ${models.length === 0
            ? html`<div class="empty">没有匹配的模型</div>`
            : html`
                <button
                  class="item"
                  title="使用服务端默认模型"
                  @click=${() => this.pick('')}
                >
                  <span>默认模型</span>
                  ${this.model === ''
                    ? html`<span class="check">✓</span>`
                    : nothing}
                </button>
                ${this.groupByVendor(models).map(
                  ({ vendor, items }) => html`
                    <div class="group">
                      <button
                        class="group-head ${this.collapsed[vendor]
                          ? 'collapsed'
                          : ''}"
                        title=${this.collapsed[vendor]
                          ? `展开 ${vendor}（${items.length}）`
                          : `折叠 ${vendor}`}
                        aria-expanded=${this.collapsed[vendor]
                          ? 'false'
                          : 'true'}
                        @click=${() => this.toggleGroup(vendor)}
                      >
                        <svg
                          class="chev"
                          viewBox="0 0 10 6"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="1.5"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                        >
                          <path d="M1 1l4 4 4-4" />
                        </svg>
                        <span class="vendor">${vendor}</span>
                        <span class="count">${items.length}</span>
                      </button>
                      ${this.collapsed[vendor]
                        ? nothing
                        : html`
                            <div class="group-items">
                              ${items.map(
                                (m) => html`
                                  <button
                                    class="item"
                                    title=${m}
                                    @click=${() => this.pick(m)}
                                  >
                                    <span>${this.displayName(m)}</span>
                                    ${this.model === m
                                      ? html`<span class="check">✓</span>`
                                      : nothing}
                                  </button>
                                `
                              )}
                            </div>
                          `}
                    </div>
                  `
                )}
              `}
        </div>
        <div class="footer">
          <button
            title="从 OpenRouter 拉取最新模型清单"
            @click=${() => void this.refreshModels()}
          >
            ⟳ 刷新模型
          </button>
          <button
            title="手动添加自定义模型 ID"
            @click=${() => (this.adding = true)}
          >
            ＋ 添加自定义模型
          </button>
        </div>
      </div>
    `;
  }

  render() {
    return html`
      <button
        class="trigger"
        title="选择模型"
        aria-haspopup="dialog"
        aria-expanded=${this.open ? 'true' : 'false'}
        @click=${() => this.toggle(!this.open)}
      >
        <span class="name"
          >${this.model ? this.displayName(this.model) : '默认模型'}</span
        >
        <svg
          viewBox="0 0 10 6"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M1 1l4 4 4-4" />
        </svg>
      </button>
      ${this.open ? this.renderPanel() : nothing}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'ah-model-picker': AhModelPicker;
  }
}

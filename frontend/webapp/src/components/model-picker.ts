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
import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

/** 远程模型条目：id + 官方上下文窗口（token）+ 是否免费变体，供分组与用量分母使用。 */
interface RemoteModel {
  id: string;
  ctx: number;
  /** 免费模型（`:free` 变体 / 实际 0 价格）：单独分组展示，默认折叠。 */
  free?: boolean;
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
      font-size: 12px;
      height: 28px;
      line-height: 26px;
      padding: 0 10px;
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
      /* 胶囊背景：悬停在选中模型上时的视觉反馈 */
      background: var(--ah-surface-3, var(--ah-surface-2));
      border-radius: 999px;
    }
    /* 选中模型厂商徽标：品牌色圆底首字母 / 系统默认芯片图标（自定义与默认模型） */
    .trigger .vlogo {
      flex-shrink: 0;
      width: 16px;
      height: 16px;
      border-radius: 50%;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 9px;
      font-weight: 700;
      color: #fff;
      user-select: none;
    }
    .trigger .vlogo-sys {
      border-radius: 0;
      color: var(--ah-text-muted);
    }
    .trigger .name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    /* 移动端（≤600px，宿主媒体查询配合）：隐藏文字与箭头，仅展示厂商 logo */
    @media (max-width: 600px) {
      .trigger {
        max-width: 40px;
        padding: 0;
        justify-content: center;
        overflow: hidden;
      }
      .trigger:hover {
        padding: 0; /* 触屏无 hover 语义，避免胶囊挤压 logo */
      }
      .trigger .name,
      .trigger > svg:not(.vlogo) {
        display: none;
      }
      .trigger .vlogo {
        width: 26px;
        height: 26px;
        font-size: 12px;
      }
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
    /* Free 分组：弱化配色 + 警示色调，提示限速风险；置于清单最末、默认折叠。 */
    .group-free .group-head {
      color: color-mix(
        in srgb,
        var(--ah-warn, #e6a23c) 75%,
        var(--ah-text-muted)
      );
    }
    .group-free .group-head:hover {
      color: var(--ah-warn, #e6a23c);
    }
    /* 自定义模型分组：置于清单最末，标题不可折叠（数量少、常驻可见）。 */
    .group-custom .group-head.static {
      cursor: default;
    }
    .group-custom .group-head.static:hover {
      color: var(--ah-text-muted);
      background: var(--ah-surface-2, transparent);
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
    this.refreshModels();
    // 面板外点关闭兜底（document 级捕获 pointerdown）：
    // 不依赖 fixed 遮罩的 CSS 几何 —— 祖先的 transform/filter 会劫持 fixed
    // 元素的包含块、让全视口遮罩缩水失效；此监听保证点空白必定可关。
    // 必须用 composedPath() 判断命中：面板在本组件 shadow root 内，
    // document 监听拿到的 e.target 已被重定向到宿主元素，closest 会失配。
    // 命中面板或触发按钮则忽略（触发按钮由自身 click 切换）。
    this.onDocPointerDown = (e: PointerEvent) => {
      if (!this.open) return;
      const path = e.composedPath();
      const inside = path.some(
        (n) =>
          n instanceof Element &&
          (n.classList.contains('panel') || n.classList.contains('trigger'))
      );
      if (!inside) this.toggle(false);
    };
    document.addEventListener('pointerdown', this.onDocPointerDown, true);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this.onDocPointerDown)
      document.removeEventListener('pointerdown', this.onDocPointerDown, true);
  }

  /** 外点监听句柄（connectedCallback 装载，disconnectedCallback 卸载）。 */
  private onDocPointerDown: ((e: PointerEvent) => void) | null = null;

  /** 合并去重后的完整模型清单：远程 > 自定义 > 内置预设（各自保序）。 */
  private get allModels(): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const m of [
      ...this.remote.map((r) => r.id),
      ...this.customs.map((c) => c.id)
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
      // 全量拉取（output_modalities=text 只排除非文本输出模型，如图像/音频生成）。
      // 那只会返回免费变体，官方付费模型的 context_length 全部拿不到。
      const res = await fetch(
        'https://openrouter.ai/api/v1/models?output_modalities=text'
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as {
        data?: {
          id?: string;
          context_length?: number;
          pricing?: { prompt?: string; completion?: string };
        }[];
      };
      // 分组标记：free=true 的进「Free」面板；0 价格的非 free 伪池（openrouter/free、
      // stealth/ox-alpha、lyria 预览等）无独立模型身份，剔除。
      const isZeroPrice = (pricing?: {
        prompt?: string;
        completion?: string;
      }): boolean => {
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
        .filter(
          (m) =>
            m.id &&
            !(!m.id.endsWith(':free') && isZeroPrice(m.raw?.pricing)) &&
            m.id !== 'openrouter/free'
        )
        .map(({ id, ctx }) => ({
          id,
          ctx,
          free: id.endsWith(':free')
        }));
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

  /** 模型供应商名：取 `/` 前缀并剥掉 `~` 别名前缀（`~z-ai` → `z-ai`，合并到现有厂商）；
   *  无 `/` 前缀归入「其他」。 */
  private vendorOf(id: string): string {
    const i = id.indexOf('/');
    if (i <= 0) return '其他';
    let v = id.slice(0, i);
    // OpenRouter 用 `~vendor` 标记「latest 别名路由」，与正式 vendor 同源，合并分组。
    while (v.startsWith('~')) v = v.slice(1);
    return v || '其他';
  }

  /** 已知厂商品牌色（用于选中模型的圆形首字母徽标）；未收录回退中性灰。 */
  private static readonly VENDOR_BRANDS: Record<string, string> = {
    openai: '#10a37f',
    anthropic: '#d97757',
    google: '#4285f4',
    'google-vertex': '#4285f4',
    meta: '#0668e1',
    mistralai: '#fa520f',
    deepseek: '#4d6bfe',
    'x-ai': '#1a1a1a',
    qwen: '#615ced',
    'z-ai': '#3b82f6',
    nvidia: '#76b900',
    microsoft: '#0078d4',
    azure: '#0078d4',
    'amazon-bedrock': '#ff9900',
    cohere: '#39594d',
    perplexity: '#20808d',
    moonshotai: '#1c1c1c',
    baidu: '#2932e1',
    minimax: '#ef4444',
    ai21: '#e03430'
  };

  private vendorColor(vendor: string): string {
    return AhModelPicker.VENDOR_BRANDS[vendor.toLowerCase()] ?? '';
  }

  /** 该模型是否用户自定义（自定义与默认模型一律使用系统默认 logo）。 */
  private isCustom(id: string): boolean {
    return this.customs.some((c) => c.id === id);
  }

  /**
   * 选中模型的厂商徽标：
   * - 已知厂商 → 品牌色圆底 + 厂商首字母；
   * - 自定义 / 默认模型 / 未收录厂商 → 默认火花图标（未收录厂商无品牌底色，
   *   用中性灰描边图标，避免臆造配色）。
   */
  private renderVendorLogo(id: string): TemplateResult {
    if (!id || this.isCustom(id)) {
      // 四角火花（sparkles）：寓意「默认/智能推荐」，替代旧芯片图形。
      return html`<svg
        class="vlogo vlogo-sys"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path
          d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z"
        />
        <path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15z" />
      </svg>`;
    }
    const v = this.vendorOf(id);
    const color = this.vendorColor(v);
    if (!color) {
      // 未收录厂商：同样走系统默认图标，保持视觉一致。
      return this.renderVendorLogo('');
    }
    return html`<span
      class="vlogo"
      style=${`background:${color}`}
      aria-hidden="true"
      >${v.charAt(0).toUpperCase()}</span
    >`;
  }

  /**
   * 把非 Free 模型按供应商分组，供应商按首字母 A-Z 排序（同组内模型保持原序）。
   * 无 `/` 前缀的归入「其他」，排最末。
   */
  private groupByVendor(
    models: string[]
  ): { vendor: string; items: string[] }[] {
    const map = new Map<string, string[]>();
    for (const m of models) {
      const v = this.vendorOf(m);
      if (!map.has(v)) map.set(v, []);
      map.get(v)!.push(m);
    }
    // localeCompare 保证稳定字母序；「其他」（无厂商前缀）固定排最后。
    return [...map.entries()]
      .sort(([a], [b]) =>
        a === '其他' ? 1 : b === '其他' ? -1 : a.localeCompare(b)
      )
      .map(([vendor, items]) => ({ vendor, items }));
  }

  /** 模型是否为免费变体（`:free` 后缀）：归入「Free」面板。 */
  private isFreeId(id: string): boolean {
    return id.endsWith(':free');
  }

  /**
   * 渲染一个可折叠面板（标题行 + 展开后的模型列表）。
   * @param name 面板标题
   * @param items 模型清单（已按搜索过滤）
   * @param free 是否为 Free 面板（警示色调）
   * @param expanded 初始展开态（Free/其他默认折叠，自定义默认展开）
   */
  private renderGroup(
    name: string,
    items: string[],
    free: boolean,
    expanded: boolean
  ): TemplateResult {
    const collapsed = !expanded;
    // 组内模型按展示名 A-Z 排序（Free 面板里混着多厂商变体，排序后更易查找）。
    const sorted = [...items].sort((a, b) =>
      this.displayName(a).localeCompare(this.displayName(b))
    );
    return html`
      <div class="group ${free ? 'group-free' : ''}">
        <button
          class="group-head ${collapsed ? 'collapsed' : ''}"
          title=${collapsed
            ? `展开 ${name}（${items.length}）`
            : `折叠 ${name}`}
          aria-expanded=${collapsed ? 'false' : 'true'}
          @click=${() => this.toggleGroup(name, expanded)}
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
          <span class="vendor">${name}</span>
          <span class="count">${items.length}</span>
        </button>
        ${collapsed
          ? nothing
          : html`
              <div class="group-items">
                ${sorted.map(
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
    `;
  }

  /**
   * 切换分组展开/折叠。必须基于渲染时传入的当前视觉状态（expanded）翻转：
   * 折叠态用「键缺失 = undefined」表示默认折叠，直接对 undefined 取反会写出
   * true（仍视为折叠）——这正是首次点击需要点两次才展开的根因。
   */
  private toggleGroup(vendor: string, currentlyExpanded: boolean) {
    this.collapsed = { ...this.collapsed, [vendor]: currentlyExpanded };
  }

  private renderPanel() {
    const q = this.query.trim().toLowerCase();
    const match = (m: string) => !q || m.toLowerCase().includes(q);
    // 展示顺序：默认模型 → Free（默认折叠）→ 其他模型/非 Free（默认折叠）→ 自定义模型（默认展开）。
    const customIds = this.customs.map((c) => c.id);
    const customs = customIds.filter(match);
    const remoteIds = this.allModels.filter((m) => !customIds.includes(m));
    // Free 面板：:free 变体；「其他」面板：全部非 Free（远程付费 + 内置预设）。
    // 自定义模型不混入其他面板，独立成组置底。
    const freeModels = remoteIds.filter((m) => this.isFreeId(m) && match(m));
    const otherModels = remoteIds.filter((m) => !this.isFreeId(m) && match(m));
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
          ${freeModels.length === 0 &&
          otherModels.length === 0 &&
          customs.length === 0
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
                <!-- 面板一：Free（:free 变体，默认折叠，警示色调；可折叠/展开） -->
                ${freeModels.length
                  ? this.renderGroup(
                      'Free',
                      freeModels,
                      true,
                      this.collapsed['Free'] === false
                    )
                  : nothing}
                <!-- 面板二起：按供应商 A-Z 分组（同厂商模型合并，每组默认折叠） -->
                ${this.groupByVendor(otherModels).map(({ vendor, items }) =>
                  this.renderGroup(
                    vendor,
                    items,
                    false,
                    this.collapsed[vendor] === false
                  )
                )}
                <!-- 自定义模型：用户手动添加，默认展开 -->
                ${customs.length
                  ? this.renderGroup(
                      '自定义模型',
                      customs,
                      false,
                      !this.collapsed['自定义模型']
                    )
                  : nothing}
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
        part="trigger"
        title="选择模型"
        aria-haspopup="dialog"
        aria-expanded=${this.open ? 'true' : 'false'}
        @click=${() => this.toggle(!this.open)}
      >
        <!-- 始终渲染徽标：移动端文字与箭头被隐藏后，logo 是唯一可见元素；
             未选模型 / 自定义模型走系统芯片图标兜底（renderVendorLogo 内部处理）。 -->
        ${this.renderVendorLogo(this.model)}
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

/**
 * model-picker：模型选择器（输入框底部工具栏）。
 *
 * 参照主流客户端交互：按钮显示当前模型名，点击向上弹出面板——
 * 顶部为「思考」开关（深度思考，状态由宿主持有），
 * 中部为可搜索的模型列表（当前选中项打勾），
 * 底部提供「刷新模型」与「添加自定义模型」。
 *
 * 数据来源：内置常用模型预设 + 用户自定义模型（经后端 SQLite 持久化，通过
 * `/api/custom-models` CRUD；前端本地不再以明文存 apiKey）。
 * 「刷新」尝试拉取 OpenRouter 公共模型列表（无需密钥），失败时静默回退本地清单。
 * 选择结果经 `model-change` 事件抛给宿主（detail.model 为空串表示恢复服务端默认）；
 * 思考开关经 `think-change` 事件抛出（detail.value）。
 */
import { LitElement, html, css, nothing, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { encryptApiKey } from '../utils/crypto';
import { authedFetch } from '../api';
import { notify } from './ah-notification';
import { notifyError, errorMessage } from '../utils/errors';

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
  try {
    const arr = Array.isArray(raw) ? raw : [];
    return arr
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
  } catch {
    return [];
  }
}

@customElement('ah-model-picker')
export class AhModelPicker extends LitElement {
  static styles = css`
    :host {
      display: inline-block;
      font-family: inherit;
      color: var(--ah-text);
    }
    /* 面板锚定基准：absolute 弹层必须相对本组件定位 */
    .wrap {
      position: relative;
      display: inline-block;
    }
    /* 触发按钮：胶囊形（图标+文字+chevron） */
    .trigger {
      appearance: none;
      border: none;
      background: transparent;
      color: inherit;
      font: inherit;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 10px;
      border-radius: 999px;
      transition: background 0.15s ease;
      max-width: 46vw;
    }
    .trigger:hover {
      background: rgba(125, 125, 125, 0.18);
    }
    .trigger:active {
      background: rgba(125, 125, 125, 0.28);
    }
    .trigger .name {
      font-size: 13px;
      line-height: 20px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .trigger > svg:not(.vlogo) {
      width: 16px;
      height: 16px;
      opacity: 0.85;
      flex: 0 0 auto;
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
        padding: 0;
      }
      .trigger .name,
      .trigger > svg:not(.vlogo) {
        display: none;
      }
    }
    /* 厂商徽标 */
    .vlogo {
      width: 20px;
      height: 20px;
      border-radius: 50%;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 11px;
      font-weight: 700;
      color: #fff;
      flex: 0 0 auto;
      line-height: 1;
    }
    .vlogo-sys {
      background: transparent;
      color: var(--ah-text-muted, #9e9e9e);
    }
    /* 面板容器 */
    .panel {
      position: absolute;
      bottom: calc(100% + 8px);
      right: 0;
      width: min(92vw, 300px);
      max-height: min(70vh, 460px);
      background: var(--ah-surface-2, #1c1c1c);
      border: 1px solid var(--ah-border, #2a2a2a);
      border-radius: 14px;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      z-index: 30;
    }
    .panel-head {
      padding: 10px 12px;
      border-bottom: 1px solid var(--ah-border, #2a2a2a);
    }
    .panel-head input {
      width: 100%;
      box-sizing: border-box;
      background: transparent;
      color: var(--ah-text);
      border: none;
      outline: none;
      font: inherit;
      font-size: 14px;
    }
    .panel-body {
      overflow-y: auto;
      padding: 6px 0;
    }
    /* 分组标题 */
    .group-title {
      font-size: 11px;
      color: var(--ah-text-muted, #9e9e9e);
      padding: 8px 14px 4px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      cursor: pointer;
      user-select: none;
    }
    /* 模型条目 */
    .item {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 7px 12px;
      cursor: pointer;
      user-select: none;
    }
    .item:hover {
      background: rgba(125, 125, 125, 0.12);
    }
    .item .name {
      flex: 1 1 auto;
      min-width: 0;
      font-size: 13px;
      line-height: 18px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .item .check {
      width: 18px;
      height: 18px;
      color: var(--ah-accent, #2997ff);
      flex: 0 0 auto;
    }
    /* 底部操作行 */
    .footer {
      display: flex;
      border-top: 1px solid var(--ah-border, #2a2a2a);
    }
    .footer button {
      appearance: none;
      border: none;
      background: transparent;
      color: var(--ah-text-muted, #9e9e9e);
      font: inherit;
      font-size: 12px;
      cursor: pointer;
      padding: 10px 0;
      flex: 1 1 auto;
    }
    .footer button:hover {
      color: var(--ah-text);
      background: rgba(125, 125, 125, 0.1);
    }
    .footer button + button {
      border-left: 1px solid var(--ah-border, #2a2a2a);
    }
    /* 自定义添加行：点「添加自定义模型」后展开（接口地址 / API Key / 模型名称 三项纵向堆叠） */
    .add-row {
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 8px 14px;
      border-bottom: 1px solid var(--ah-border, #2a2a2a);
    }
    .add-row input {
      background: transparent;
      color: var(--ah-text);
      border: 1px solid var(--ah-border, #2a2a2a);
      border-radius: 10px;
      padding: 8px 10px;
      outline: none;
      font: inherit;
      font-size: 13px;
    }
    .add-row input:focus {
      border-color: var(--ah-accent, #2997ff);
    }
    .add-actions {
      display: flex;
      gap: 8px;
      justify-content: flex-end;
    }
    }
    .add-actions button {
      appearance: none;
      border: none;
      border-radius: 10px;
      padding: 7px 12px;
      font: inherit;
      font-size: 12px;
      cursor: pointer;
    }
    .btn-primary {
      background: var(--ah-accent, #2997ff);
      color: #fff;
    }
    .btn-ghost {
      background: transparent;
      color: var(--ah-text-muted, #9e9e9e);
    }
    /* 自定义模型条目：主体（选择）+ 右侧「编辑」按钮 */
    .item.custom-item {
      padding: 0;
    }
    .custom-main {
      flex: 1 1 auto;
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 7px 12px;
      text-align: left;
      cursor: pointer;
      word-break: break-all;
    }
    .custom-edit {
      appearance: none;
      border: none;
      background: transparent;
      color: var(--ah-text-muted, #9e9e9e);
      cursor: pointer;
      padding: 7px 10px;
      font: inherit;
      font-size: 12px;
    }
    .custom-edit:hover {
      color: var(--ah-text);
    }
  `;

  @property({ attribute: false }) model = '';
  @property({ attribute: false }) deepThink = false;
  @property({ attribute: false }) web = false;

  @state() private open = false;
  @state() private query = '';
  @state() private adding = false;
  @state() private editingId = '';
  @state() private collapsed: Record<string, boolean> = {};
  @state() private remote: RemoteModel[] = [];
  @state() private customs: CustomModel[] = [];

  /** 自定义模型表单三项：接口地址 / API Key / 模型名称。 */
  @state() private draftBaseUrl = '';
  @state() private draftApiKey = '';
  @state() private draftId = '';

  /** 是否正在保存到后端（按钮 loading 态）。 */
  @state() private saving = false;

  /**
   * 「刷新」拉取在线模型清单（含官方上下文窗口；失败为空、回退本地清单）。
   * @param opts.silent 后台自动刷新传 true —— 失败静默；用户手动点「刷新模型」
   *   走默认 false，失败会弹提示（否则点了没反应）。
   */
  async refreshModels(opts: { silent?: boolean } = {}) {
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
    } catch (e) {
      // 后台自动刷新（首帧 / 选中模型补分母）失败不打扰：本地清单本就可用。
      // 用户主动点「刷新模型」时才提示，否则点了没反应会让人以为没生效。
      if (!opts.silent) {
        notify.warning(
          errorMessage(e, '在线模型清单拉取失败，当前使用本地预设清单'),
          { title: '刷新模型清单', key: 'model-refresh' }
        );
      }
    }
  }

  /** 从后端 SQLite 加载已保存的自定义模型列表。 */
  private async loadCustoms() {
    try {
      const res = await authedFetch('/api/custom-models');
      if (!res.ok) return;
      const rows = (await res.json()) as CustomModel[];
      this.customs = normalizeCustom(rows);
    } catch (e) {
      // 加载失败 → 自定义模型会从列表里「凭空消失」，必须告知，否则用户会
      // 以为是自己没保存过。本地清单仍可用，故用 error 提示但只弹一条。
      notifyError(e, {
        title: '自定义模型',
        fallback: '自定义模型列表加载失败，暂只展示内置模型',
        key: 'custom-model-list'
      });
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

  /** 查询某模型的官方上下文窗口；未知返回 0（宿主据此隐藏用量展示）。 */
  private ctxFor(id: string): number {
    return this.remote.find((r) => r.id === id)?.ctx ?? 0;
  }

  /**
   * 宿主（chat.ts）在切换会话 / 恢复模型后调用：回抛当前（或指定）模型的官方
   * 上下文窗口。若无缓存（首次拉取未归位），触发一次静默刷新，归位后由
   * refreshModels 的 emitCtx 再次回抛。这样「进入会话」时用量圆环能即时显示，
   * 不必等用户手动重选模型。
   */
  requestCtx(model?: string) {
    const m = model ?? this.model;
    const ctx = m ? this.ctxFor(m) : 0;
    this.emitCtx(ctx);
    if (m && ctx === 0 && !this.remote.length) {
      void this.refreshModels({ silent: true });
    }
  }

  /** 模型属性变化时回抛官方上下文窗口：修复「首屏/切会话后用量圆环不显示，
   *  需手动重选模型才出现」——首帧渲染绑定 .model 后才拿到值，此前 refreshModels
   *  的 emitCtx 用的是空 model，故此处补一次回抛，宿主据此显示用量圆环。 */
  protected updated(changed: Map<string, unknown>) {
    if (changed.has('model')) {
      const ctx = this.model ? this.ctxFor(this.model) : 0;
      this.emitCtx(ctx);
      if (this.model && ctx === 0 && !this.remote.length) {
        void this.refreshModels({ silent: true });
      }
    }
  }

  private toggle(open: boolean) {
    this.open = open;
    if (!open) {
      // 关闭时重置瞬态状态，下次打开回到干净视图。
      this.query = '';
      this.adding = false;
      this.editingId = '';
      this.draftId = '';
      this.draftBaseUrl = '';
      this.draftApiKey = '';
    }
  }

  /** 打开编辑框：预填该自定义模型的现有配置（仅 API Key 可改）。 */
  private startEdit(id: string) {
    const c = this.customs.find((x) => x.id === id);
    if (!c) return;
    this.editingId = id;
    this.adding = true;
    this.draftId = c.id;
    this.draftBaseUrl = c.baseUrl ?? '';
    this.draftApiKey = c.apiKey ?? '';
  }

  /** 提交自定义模型（新增/编辑）：加密 apiKey 后保存到后端 SQLite。 */
  private async submitDraft() {
    const id = this.draftId.trim();
    if (!id) return;
    const baseUrl = this.draftBaseUrl.trim();
    const apiKey = this.draftApiKey.trim();
    const editing = this.editingId === id && this.isCustom(id);
    // 加密 apiKey（前端 build-time key，后端同源可解密）。
    // 失败（如 AH_CRYPTO_KEY 未配置/非法）不再裸抛：给出明确提示并中止保存，
    // 避免把明文 key 或空值静默落库。
    let encryptedApiKey: string | undefined;
    if (apiKey) {
      try {
        encryptedApiKey = await encryptApiKey(apiKey);
      } catch (e) {
        // 加密失败 → 明确提示并中止保存，避免把明文 key 或空值静默落库。
        notify.error(
          'API Key 加密失败：' +
            (e instanceof Error ? e.message : String(e)) +
            '。请在服务端 .env 配置 AH_CRYPTO_KEY（64 位 hex）后重新构建前端。',
          { title: '自定义模型', key: 'custom-model' }
        );
        return;
      }
    }
    // 同步到后端 SQLite。
    this.saving = true;
    try {
      const body: Record<string, unknown> = {
        id,
        ...(baseUrl ? { baseUrl } : {})
      };
      if (encryptedApiKey) body.apiKey = encryptedApiKey;
      const res = await authedFetch('/api/custom-models', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      // 写库失败必须让用户知道：此前静默忽略会让人误以为已保存，
      // 结果刷新后自定义模型消失。
      notifyError(e, {
        title: '自定义模型',
        fallback: '保存失败，自定义模型可能未持久化',
        key: 'custom-model'
      });
    } finally {
      this.saving = false;
    }
    // 本地状态同步。
    const rest = this.customs.filter((c) => c.id !== id);
    const prev = editing ? this.customs.find((c) => c.id === id) : undefined;
    this.customs = [
      {
        id,
        // 编辑态：接口地址与模型名称锁定不可改，保留原值；仅 API Key 可更新。
        ...(editing
          ? prev?.baseUrl
            ? { baseUrl: prev.baseUrl }
            : {}
          : baseUrl
          ? { baseUrl }
          : {}),
        ...(encryptedApiKey ? { apiKey: encryptedApiKey } : {})
      },
      ...rest
    ];
    this.draftId = '';
    this.draftBaseUrl = '';
    this.draftApiKey = '';
    this.adding = false;
    this.editingId = '';
    if (editing) {
      // 编辑保存：不切换选中模型（可能只是换 Key），仅刷新视图。
      notify.success(`自定义模型「${id}」已更新`);
      return;
    }
    notify.success(`自定义模型「${id}」已保存`);
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
        <path
          d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15z"
        />
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

  /**
   * 自定义模型的服务商分组名：取 baseUrl 的主机名并大写展示
   * （如 https://apihub.agnes-ai.com/v1 → APIHUB.AGNES-AI.COM）。
   * 未配置 baseUrl 的归入「自定义」。
   */
  private customProviderName(c: CustomModel): string {
    if (!c.baseUrl) return '自定义';
    try {
      const host = new URL(c.baseUrl).hostname;
      if (host) return host.toUpperCase();
    } catch {
      /* 非法 URL：回退到原始串的大写 */
      const t = c.baseUrl.trim();
      if (t) return t.toUpperCase();
    }
    return '自定义';
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
   */
  private renderGroup(
    name: string,
    items: string[],
    free = false
  ): TemplateResult {
    const collapsed = this.collapsed[name] ?? true;
    return html`
      <div class="group">
        <div
          class="group-title"
          @click=${() => {
            this.collapsed = { ...this.collapsed, [name]: !collapsed };
          }}
        >
          ${name}
          <svg
            class="chev"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            style="width:14px;height:14px;vertical-align:middle;transition:transform .15s ease;transform:${collapsed
              ? 'rotate(0deg)'
              : 'rotate(180deg)'}"
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
        </div>
        ${collapsed
          ? nothing
          : html`<div class="panel-body">
              ${items.map((id) => {
                const active = this.model === id;
                return html`
                  <div
                    class="item ${this.isCustom(id) ? 'custom-item' : ''}"
                    @click=${() => this.pick(id)}
                  >
                    ${this.isCustom(id)
                      ? html` <button
                          class="custom-edit"
                          title="编辑自定义模型"
                          @click=${(e: Event) => {
                            e.stopPropagation();
                            this.startEdit(id);
                          }}
                        >
                          编辑
                        </button>`
                      : nothing}
                    <span class="name">${this.displayName(id)}</span>
                    ${active
                      ? html`<svg
                          class="check"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="2.5"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                        >
                          <path d="M20 6L9 17l-5-5" />
                        </svg>`
                      : nothing}
                  </div>
                `;
              })}
            </div>`}
      </div>
    `;
  }

  render() {
    const q = this.query.trim().toLowerCase();
    // 过滤：远程列表 + 自定义列表。
    const filteredRemote = q
      ? this.remote.filter((m) => m.id.toLowerCase().includes(q))
      : this.remote;
    const filteredCustom = q
      ? this.customs.filter((c) => c.id.toLowerCase().includes(q))
      : this.customs;

    // 组内模型按展示名（去厂商前缀）A-Z 排序；OpenRouter 原始返回为热度序，非字母序。
    const byDisplayName = (a: string, b: string) =>
      this.displayName(a).localeCompare(this.displayName(b));
    const free = filteredRemote
      .filter((m) => this.isFreeId(m.id))
      .map((m) => m.id)
      .sort(byDisplayName);
    const nonFree = filteredRemote
      .filter((m) => !this.isFreeId(m.id))
      .map((m) => m.id)
      .sort(byDisplayName);

    // 服务商分类（用户指定）：OpenRouter 全量模型只归两块面板 ——
    // OPENROUTER FREE（:free 变体，置顶）与 OPENROUTER（付费）；
    // 自定义模型按 baseUrl 主机名分组（如 APIHUB.AGNES-AI.COM），无 baseUrl 归「自定义」。
    // 组名 A-Z 排序；组内模型按展示名 A-Z 排序。
    const customGroupsMap = new Map<string, CustomModel[]>();
    for (const c of filteredCustom) {
      const p = this.customProviderName(c);
      if (!customGroupsMap.has(p)) customGroupsMap.set(p, []);
      customGroupsMap.get(p)!.push(c);
    }
    const customGroups = [...customGroupsMap.entries()]
      .sort(([a], [b]) =>
        a === '自定义' ? 1 : b === '自定义' ? -1 : a.localeCompare(b)
      )
      .map(([provider, list]) => ({
        provider,
        items: list
          .map((c) => c.id)
          .sort((a, b) =>
            this.displayName(a).localeCompare(this.displayName(b))
          )
      }));

    // 显示规则：OpenRouter 两面板始终显示（哪怕空）；自定义服务商组无结果时隐藏。
    const showFree = true;
    const showOpenRouter = true;

    return html`
      <div class="wrap">
        <button
          class="trigger"
          title="选择模型"
          aria-haspopup="listbox"
          aria-expanded="${this.open}"
          @click=${() => this.toggle(!this.open)}
        >
          ${this.renderVendorLogo(this.model)}
          <span class="name"
            >${this.model ? this.displayName(this.model) : '默认模型'}</span
          >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>

        ${this.open
          ? html`<div class="panel" role="listbox">
              <div class="panel-head">
                <input
                  placeholder="搜索模型…"
                  .value=${this.query}
                  @input=${(e: Event) =>
                    (this.query = (e.target as HTMLInputElement).value)}
                />
              </div>
              <div class="panel-body">
                ${showFree
                  ? this.renderGroup('OPENROUTER FREE', free, true)
                  : nothing}
                ${showOpenRouter
                  ? this.renderGroup('OPENROUTER', nonFree)
                  : nothing}
                ${customGroups.map(({ provider, items }) =>
                  this.renderGroup(provider, items)
                )}
              </div>
              <div class="footer">
                <button @click=${() => this.refreshModels()}>刷新模型</button>
                <button
                  @click=${() => {
                    this.adding = !this.adding;
                    this.editingId = '';
                    this.draftId = '';
                    this.draftBaseUrl = '';
                    this.draftApiKey = '';
                  }}
                >
                  ${this.adding ? '取消添加' : '添加自定义模型'}
                </button>
              </div>
              ${this.adding
                ? html`<div class="add-row">
                    <input
                      placeholder="模型名称（如 my-model）"
                      .value=${this.draftId}
                      @input=${(e: Event) =>
                        (this.draftId = (e.target as HTMLInputElement).value)}
                    />
                    <input
                      placeholder="接口地址（可选，OpenAI 兼容端点）"
                      .value=${this.draftBaseUrl}
                      @input=${(e: Event) =>
                        (this.draftBaseUrl = (
                          e.target as HTMLInputElement
                        ).value)}
                    />
                    <input
                      placeholder="API Key（可选，将加密保存）"
                      .value=${this.draftApiKey}
                      type="password"
                      @input=${(e: Event) =>
                        (this.draftApiKey = (
                          e.target as HTMLInputElement
                        ).value)}
                    />
                    <div class="add-actions">
                      <button
                        class="btn-ghost"
                        @click=${() => {
                          this.adding = false;
                          this.draftId = '';
                          this.draftBaseUrl = '';
                          this.draftApiKey = '';
                        }}
                      >
                        取消
                      </button>
                      <button
                        class="btn-primary"
                        ?disabled=${this.saving}
                        @click=${() => this.submitDraft()}
                      >
                        ${this.saving ? '保存中…' : '保存'}
                      </button>
                    </div>
                  </div>`
                : nothing}
            </div>`
          : nothing}
      </div>
    `;
  }

  // 外点监听句柄（connectedCallback 装载，disconnectedCallback 卸载）。
  private onDocPointerDown: ((e: PointerEvent) => void) | null = null;

  connectedCallback() {
    super.connectedCallback();
    this.refreshModels({ silent: true });
    this.loadCustoms();
    // 面板外点关闭兜底（document 级捕获 pointerdown）：
    // 不依赖 fixed 遮罩的 CSS 几何 —— 祖先的 transform/filter 会劫持 fixed
    // 元素的包含块、让全视口遮罩缩水失效；此监听保证点空白必定可关。
    // 必须用 composedPath() 判断命中：面板在本组件 shadow root 内，
    // document 监听拿到的 e.target 已被重定向到宿主元素，closest 会失配。
    // 命中面板或触发按钮则忽略（触发按钮由自身 click 切换）。
    this.onDocPointerDown = (e: PointerEvent) => {
      if (!this.open) return;
      const path = e.composedPath();
      // 面板内部任何元素（分组标题 / 模型条目 / 添加表单…）都不算外点：
      // 只判断「点击是否落在本组件 shadow 内」，否则 group-title 等内部
      // 元素会被误判为外部，面板刚展开就被关掉（表现为点击无法展开）。
      const inside = path.some(
        (n) => n instanceof AhModelPicker || (n as any) === this.renderRoot
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
}

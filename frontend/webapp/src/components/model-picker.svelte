/**
 * model-picker：模型选择器（输入框底部工具栏）—— Svelte 迁移版
 *
 * 行为对齐 Lit 原版（components/model-picker.ts）：按钮显示当前模型名，
 * 点击向上弹出面板（思考开关已不在模板中，保留事件契约），中部为可搜索的
 * 模型列表（当前选中项打勾），底部提供「刷新模型」「添加自定义模型」
 * 「配置 API Key」（整屏抽屉，内嵌 settings-center group=keys）。
 *
 * 数据来源与事件契约与原版完全一致：
 *  - `model-change`：detail { model, ctx, baseUrl }（model 为空串表示恢复服务端默认）
 *  - `think-change` / `web-change`：detail { value }
 *  - `ctx-change`：detail { ctx }（0 = 无数据，宿主隐藏用量展示）
 *  - 公开方法 refreshModels(opts) / requestCtx(model?)（父组件 bind:this 调用）
 *
 * 样式说明：:host 规则已按迁移规范改写为根类 .model-picker-root（宿主
 * responsive.ts 的移动端规则同样以该类为目标）；媒体查询里的 `*` /
 * `::-webkit-scrollbar` 通写改用 :global(.model-picker-root …) 保住
 * 「整个子树隐藏滚动条」的原语义。
 */
<script lang="ts">
  import { onMount, onDestroy, untrack } from 'svelte';
  import { authedFetch } from '../api';
  import { notify } from './ah-notification';
  import { notifyError, errorMessage } from '../utils/errors';
  // 「配置 API Key」整屏抽屉（复用通用 ah-drawer）与综合设置中心（ah-settings-center）。
  import AhDrawer from './ah-drawer.svelte';
  import AhSwipeItem from './ah-swipe-item.svelte';
  import SettingsCenter from './settings-center.svelte';
  import { APP_EVENTS } from '../app-events';

  /** 远程模型条目：id + baseUrl（固化，供 run 时直连）+ 官方上下文窗口（token）+ 是否免费变体。 */
  interface RemoteModel {
    id: string;
    baseUrl: string;
    ctx: number;
    /** 免费模型（`:free` 变体 / 实际 0 价格）：单独分组展示，默认折叠。 */
    free?: boolean;
  }

  /** 自定义模型条目：模型名 + 可选的自定义接口地址与 API Key（直连任意 OpenAI 兼容端点）。 */
  interface CustomModel {
    id: string;
    baseUrl?: string;
    /** 脱敏掩码（首尾若干字符），由服务端回传；明文/密文永不出网。 */
    keyHint?: string;
  }

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
            ...(o?.keyHint ? { keyHint: String(o.keyHint).trim() } : {})
          };
        })
        .filter((m) => m.id);
    } catch {
      return [];
    }
  }

  let {
    model = '',
    deepThink = false,
    web = false
  }: { model?: string; deepThink?: boolean; web?: boolean } = $props();

  let open = $state(false);
  let query = $state('');
  let adding = $state(false);
  let editingId = $state('');
  let deletingId = $state('');
  let collapsed: Record<string, boolean> = $state({});
  let remote: RemoteModel[] = $state([]);
  let customs: CustomModel[] = $state([]);

  /** 自定义模型表单三项：接口地址 / API Key / 模型名称。 */
  let draftBaseUrl = $state('');
  let draftApiKey = $state('');
  let draftId = $state('');

  /** 是否正在保存到后端（按钮 loading 态）。 */
  let saving = $state(false);

  /** 「配置 API Key」整屏抽屉开关（替代原 ah-goto 切 Tab 行为，直达「模型与密钥」分组）。 */
  let keyDrawerOpen = $state(false);

  /** 根元素引用：外点关闭判定（原 Lit 用 composedPath 判断是否落在 shadow 内）。 */
  let rootEl: HTMLElement | undefined = $state();

  /**
   * 删除「当前选中模型」后的本地显示覆盖（原 Lit 直接写 this.model = ''）。
   * Svelte 下 prop 由父组件只读持有，用本地覆盖复现「即时回退默认模型显示」；
   * 父组件后续更新 model prop 时自动让位（与原 Lit「下次父级渲染即被绑定值
   * 覆盖」同效）。
   */
  let modelOverride = $state<string | null>(null);
  /** 实际展示用的 model：覆盖优先，否则跟随父组件 prop。 */
  let shownModel = $derived(modelOverride ?? model);

  // 父组件更新 model 时清掉本地覆盖（依赖 shownModel 之外的 model 本身）。
  $effect(() => {
    model;
    modelOverride = null;
  });

  /**
   * 「刷新」拉取在线模型清单（含官方上下文窗口；失败为空、回退本地清单）。
   * @param opts.silent 后台自动刷新传 true —— 失败静默；用户手动点「刷新模型」
   *   走默认 false，失败会弹提示（否则点了没反应）。
   */
  export async function refreshModels(opts: { silent?: boolean } = {}) {
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
          baseUrl: 'https://openrouter.ai/api/v1',
          ctx: Number(m?.context_length) || 0
        }))
        .filter(
          (m) =>
            m.id &&
            !(!m.id.endsWith(':free') && isZeroPrice(m.raw?.pricing)) &&
            m.id !== 'openrouter/free'
        )
        .map(({ id, baseUrl, ctx }) => ({
          id,
          baseUrl,
          ctx,
          free: id.endsWith(':free')
        }));
      if (list.length) remote = list;
      // 刷新后当前选中模型可能首次拿到官方窗口数据，通知宿主更新分母。
      if (shownModel) emitCtx(ctxFor(shownModel));
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
  async function loadCustoms() {
    try {
      const res = await authedFetch('/api/custom-models');
      if (!res.ok) return;
      const rows = (await res.json()) as CustomModel[];
      customs = normalizeCustom(rows);
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
  function emitCtx(ctx: number) {
    rootEl?.dispatchEvent(
      new CustomEvent('ctx-change', {
        detail: { ctx },
        bubbles: true,
        composed: true
      })
    );
  }

  function pick(id: string) {
    toggle(false);
    /**
     * 选择模型。detail.model 为空串表示清除选择（恢复服务端默认）。
     * detail.baseUrl 携带本次选中的模型专属 baseUrl（OpenRouter 模型固化为 openrouter.ai，
     * 自定义模型取用户填写的接口地址）；宿主据此覆盖 run 请求里的 modelBaseUrl。
     * 同时携带该模型已知的上下文窗口（0 = 无数据），宿主据此更新/隐藏用量展示。
     */
    rootEl?.dispatchEvent(
      new CustomEvent('model-change', {
        detail: {
          model: id,
          ctx: id ? ctxFor(id) : 0,
          baseUrl: id ? baseUrlFor(id) : ''
        },
        bubbles: true,
        composed: true
      })
    );
  }

  /** 查询某模型的 baseUrl；未命中返回空串（宿主据此使用服务端默认配置）。 */
  function baseUrlFor(id: string): string {
    const r = remote.find((m) => m.id === id);
    if (r) return r.baseUrl ?? '';
    const c = customs.find((m) => m.id === id);
    return c?.baseUrl ?? '';
  }

  /** 查询某模型的官方上下文窗口；未知返回 0（宿主据此隐藏用量展示）。 */
  function ctxFor(id: string): number {
    return remote.find((r) => r.id === id)?.ctx ?? 0;
  }

  /**
   * 宿主（chat.svelte）在切换会话 / 恢复模型后调用：回抛当前（或指定）模型的官方
   * 上下文窗口。若无缓存（首次拉取未归位），触发一次静默刷新，归位后由
   * refreshModels 的 emitCtx 再次回抛。这样「进入会话」时用量圆环能即时显示，
   * 不必等用户手动重选模型。
   */
  export function requestCtx(model?: string) {
    const m = model ?? shownModel;
    const ctx = m ? ctxFor(m) : 0;
    emitCtx(ctx);
    if (m && ctx === 0 && !remote.length) {
      void refreshModels({ silent: true });
    }
  }

  /** 读取当前展示 model（requestCtx 内避免与形参同名遮蔽）。 */
  function model0(): string {
    return shownModel;
  }

  /**
   * model 属性变化时回抛官方上下文窗口：修复「首屏/切会话后用量圆环不显示，
   * 需手动重选模型才出现」——首帧渲染绑定 model 后才拿到值，此前 refreshModels
   * 的 emitCtx 用的是空 model，故此处补一次回抛，宿主据此显示用量圆环。
   * （原 Lit updated(changed) 仅响应 model 变化；untrack 保证 remote 刷新时
   * 不重复触发，保持同一语义。）
   */
  $effect(() => {
    const m = shownModel;
    untrack(() => {
      const ctx = m ? ctxFor(m) : 0;
      emitCtx(ctx);
      if (m && ctx === 0 && !remote.length) {
        void refreshModels({ silent: true });
      }
    });
  });

  function toggle(openNext: boolean) {
    open = openNext;
    if (!openNext) {
      // 关闭时重置瞬态状态，下次打开回到干净视图。
      query = '';
      adding = false;
      editingId = '';
      deletingId = '';
      draftId = '';
      draftBaseUrl = '';
      draftApiKey = '';
    }
  }

  /** 打开编辑框：预填该自定义模型的现有配置（仅 API Key 可改）。
   *  明文 Key 永不出网、不能回显：已保存 Key 以掩码提示，留空即保留原 Key，
   *  粘贴新值则全量替换。 */
  function startEdit(id: string) {
    const c = customs.find((x) => x.id === id);
    if (!c) return;
    editingId = id;
    adding = true;
    draftId = c.id;
    draftBaseUrl = c.baseUrl ?? '';
    draftApiKey = '';
  }

  /** 提交自定义模型（新增/编辑）：明文 Key 直提交，由服务端加密落库。 */
  async function submitDraft() {
    const id = draftId.trim();
    if (!id) return;
    const baseUrl = draftBaseUrl.trim();
    const apiKey = draftApiKey.trim();
    const editing = editingId === id && isCustom(id);
    // 明文 Key 直接提交，由服务端 AES-GCM 加密落库（前端不再持有任何密钥材料）。
    // 同步到后端 SQLite。
    saving = true;
    let ok = false;
    try {
      const body: Record<string, unknown> = {
        id,
        ...(baseUrl ? { baseUrl } : {})
      };
      if (apiKey) body.apiKey = apiKey;
      const res = await authedFetch('/api/custom-models', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      ok = true;
    } catch (e) {
      // 写库失败必须让用户知道：此前静默忽略会让人误以为已保存，
      // 结果刷新后自定义模型消失。
      notifyError(e, {
        title: '自定义模型',
        fallback: '保存失败，自定义模型可能未持久化',
        key: 'custom-model'
      });
    } finally {
      saving = false;
    }
    // 保存成功后重新从后端拉取最新自定义模型列表，确保本地状态与服务端一致。
    // 此前仅做乐观更新，可能因并发 / 缓存而与服务端不一致（如 keyHint 掩码未同步）。
    if (ok) {
      await loadCustoms();
    }
    draftId = '';
    draftBaseUrl = '';
    draftApiKey = '';
    adding = false;
    editingId = '';
    if (editing) {
      // 编辑保存：不切换选中模型（可能只是换 Key），仅刷新视图。
      notify.success(`自定义模型「${id}」已更新`);
      return;
    }
    notify.success(`自定义模型「${id}」已保存`);
    pick(id);
  }

  /** 删除自定义模型（弹出确认）。 */
  async function deleteCustom(id: string) {
    if (!confirm(`确定要删除自定义模型「${id}」吗？此操作不可撤销。`)) {
      return;
    }
    deletingId = id;
    try {
      const res = await authedFetch(`/api/custom-models/${id}`, {
        method: 'DELETE'
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      customs = customs.filter((c) => c.id !== id);
      notify.success(`已删除自定义模型「${id}」`);
      // 如果当前选中的是被删模型，清除选择（原 Lit 写 this.model = ''；
      // Svelte prop 只读，改写本地显示覆盖，父组件更新 model 时自动让位）
      if (shownModel === id) {
        modelOverride = '';
        emitCtx(0);
      }
    } catch (e) {
      notifyError(e, {
        title: '自定义模型',
        fallback: '删除失败',
        key: 'custom-model-delete'
      });
    } finally {
      deletingId = '';
    }
  }

  function displayName(id: string): string {
    const i = id.indexOf('/');
    return i >= 0 ? id.slice(i + 1) : id;
  }

  /** 模型供应商名：取 `/` 前缀并剥掉 `~` 别名前缀（`~z-ai` → `z-ai`，合并到现有厂商）；
   *  无 `/` 前缀归入「其他」。 */
  function vendorOf(id: string): string {
    const i = id.indexOf('/');
    if (i <= 0) return '其他';
    let v = id.slice(0, i);
    // OpenRouter 用 `~vendor` 标记「latest 别名路由」，与正式 vendor 同源，合并分组。
    while (v.startsWith('~')) v = v.slice(1);
    return v || '其他';
  }

  /** 已知厂商品牌色（用于选中模型的圆形首字母徽标）；未收录回退中性灰。 */
  const VENDOR_BRANDS: Record<string, string> = {
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

  function vendorColor(vendor: string): string {
    return VENDOR_BRANDS[vendor.toLowerCase()] ?? '';
  }

  /** 该模型是否用户自定义（自定义与默认模型一律使用系统默认 logo）。 */
  function isCustom(id: string): boolean {
    return customs.some((c) => c.id === id);
  }

  /**
   * 选中模型的厂商徽标（派生）：
   * - 已知厂商 → 品牌色圆底 + 厂商首字母；
   * - 自定义 / 默认模型 / 未收录厂商 → 默认火花图标（未收录厂商无品牌底色，
   *   用中性灰描边图标，避免臆造配色）。
   */
  let vendorLogo = $derived.by(() => {
    const id = shownModel;
    if (!id || isCustom(id)) return { sys: true as const };
    const v = vendorOf(id);
    const color = vendorColor(v);
    if (!color) return { sys: true as const };
    return { sys: false as const, color, letter: v.charAt(0).toUpperCase() };
  });

  /**
   * 把非 Free 模型按供应商分组，供应商按首字母 A-Z 排序（同组内模型保持原序）。
   * 无 `/` 前缀的归入「其他」，排最末。
   */
  function groupByVendor(
    models: string[]
  ): { vendor: string; items: string[] }[] {
    const map = new Map<string, string[]>();
    for (const m of models) {
      const v = vendorOf(m);
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
  function customProviderName(c: CustomModel): string {
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
  function isFreeId(id: string): boolean {
    return id.endsWith(':free');
  }

  // 过滤：远程列表 + 自定义列表。
  let filteredRemote = $derived(
    query.trim()
      ? remote.filter((m) => m.id.toLowerCase().includes(query.trim().toLowerCase()))
      : remote
  );
  let filteredCustom = $derived(
    query.trim()
      ? customs.filter((c) => c.id.toLowerCase().includes(query.trim().toLowerCase()))
      : customs
  );

  // 组内模型按展示名（去厂商前缀）A-Z 排序；OpenRouter 原始返回为热度序，非字母序。
  const byDisplayName = (a: string, b: string) =>
    displayName(a).localeCompare(displayName(b));
  let free = $derived(
    filteredRemote
      .filter((m) => isFreeId(m.id))
      .map((m) => m.id)
      .sort(byDisplayName)
  );
  let nonFree = $derived(
    filteredRemote
      .filter((m) => !isFreeId(m.id))
      .map((m) => m.id)
      .sort(byDisplayName)
  );

  // 服务商分类（用户指定）：OpenRouter 全量模型只归两块面板 ——
  // OPENROUTER FREE（:free 变体，置顶）与 OPENROUTER（付费）；
  // 自定义模型按 baseUrl 主机名分组（如 APIHUB.AGNES-AI.COM），无 baseUrl 归「自定义」。
  // 组名 A-Z 排序；组内模型按展示名 A-Z 排序。
  let customGroups = $derived.by(() => {
    const customGroupsMap = new Map<string, CustomModel[]>();
    for (const c of filteredCustom) {
      const p = customProviderName(c);
      if (!customGroupsMap.has(p)) customGroupsMap.set(p, []);
      customGroupsMap.get(p)!.push(c);
    }
    return [...customGroupsMap.entries()]
      .sort(([a], [b]) =>
        a === '自定义' ? 1 : b === '自定义' ? -1 : a.localeCompare(b)
      )
      .map(([provider, list]) => ({
        provider,
        items: list
          .map((c) => c.id)
          .sort((a, b) =>
            displayName(a).localeCompare(displayName(b))
          )
      }));
  });

  // 显示规则：OpenRouter 两面板始终显示（哪怕空）；自定义服务商组无结果时隐藏。
  const showFree = true;
  const showOpenRouter = true;

  // 外点监听句柄（onMount 装载，onDestroy 卸载）。
  let onDocPointerDown: ((e: PointerEvent) => void) | null = null;

  onMount(() => {
    void refreshModels({ silent: true });
    void loadCustoms();
    // 面板外点关闭兜底（document 级捕获 pointerdown）：
    // 不依赖 fixed 遮罩的 CSS 几何 —— 祖先的 transform/filter 会劫持 fixed
    // 元素的包含块、让全视口遮罩缩水失效；此监听保证点空白必定可关。
    // Svelte 无 shadow 边界，直接以根元素 contains 判定（与原版
    // composedPath 命中 shadow root 等价）：命中组件内任何元素
    // （触发按钮 / 面板 / 配置抽屉）都不算外点。
    onDocPointerDown = (e: PointerEvent) => {
      if (!open) return;
      const inside =
        e.target instanceof Node && !!rootEl && rootEl.contains(e.target);
      if (!inside) toggle(false);
    };
    document.addEventListener('pointerdown', onDocPointerDown, true);
    window.addEventListener(APP_EVENTS.closeOverlays, onCloseOverlays);
  });

  onDestroy(() => {
    if (onDocPointerDown)
      document.removeEventListener('pointerdown', onDocPointerDown, true);
    window.removeEventListener(APP_EVENTS.closeOverlays, onCloseOverlays);
  });

  /**
   * 路由变化（Tab 切换 / 浏览器后退前进）时收起浮层。
   * 本组件常驻在对话页、切 Tab 只是被父级 hidden 而非销毁，若不主动收起，
   * 侧滑返回后再次进入对话页会看到上次遗留的展开下拉（统一约定见 ah-app.closeAllOverlays）。
   */
  function onCloseOverlays() {
    if (open) toggle(false);
  }
</script>

<div class="model-picker-root" bind:this={rootEl}>
  <div class="wrap">
    <button
      class="trigger"
      title="选择模型"
      aria-haspopup="listbox"
      aria-expanded={open ? 'true' : 'false'}
      onclick={() => toggle(!open)}
    >
      {#if vendorLogo.sys}
        <!-- 四角火花（sparkles）：寓意「默认/智能推荐」，替代旧芯片图形。 -->
        <svg
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
        </svg>
      {:else}
        <span
          class="vlogo"
          style:background={vendorLogo.color}
          aria-hidden="true"
          >{vendorLogo.letter}</span
        >
      {/if}
      <span class="name"
        >{shownModel ? displayName(shownModel) : '默认模型'}</span
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

    {#if open}
      <div class="panel" role="listbox">
        <div class="panel-head">
          <div class="search">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.3-4.3" />
            </svg>
            <input
              placeholder="搜索模型…"
              value={query}
              oninput={(e) => (query = e.currentTarget.value)}
            />
          </div>
        </div>
        <div class="panel-body">
          {#snippet group(name, items)}
            {@const groupCollapsed = collapsed[name] ?? true}
            <div class="group">
              <div
                class="group-title"
                onclick={() => {
                  collapsed = { ...collapsed, [name]: !groupCollapsed };
                }}
              >
                {name}
                <svg
                  class="chev"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  style="width:14px;height:14px;vertical-align:middle;transition:transform .15s ease;transform:{groupCollapsed
                    ? 'rotate(0deg)'
                    : 'rotate(180deg)'}"
                >
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </div>
              {#if !groupCollapsed}
                <div class="panel-body">
                  {#each items as id (id)}
                    {@const active = shownModel === id}
                    {@const custom = isCustom(id)}
                    {#if custom}
                      <!-- 通用滑动项（ah-swipe-item）：触屏左滑自定义模型行 → 右侧露出
                           「编辑/删除」操作区；桌面 hover 设备组件自动隐藏操作区，
                           沿用原 .custom-actions hover 浮现入口（见样式节注释）。 -->
                      <AhSwipeItem {id} group="model-customs">
                        <div
                          class="item custom-item"
                          class:active
                          onclick={() => pick(id)}
                        >
                          <span class="custom-actions">
                            <button
                              class="custom-icon-btn"
                              title="编辑自定义模型"
                              onclick={(e) => {
                                e.stopPropagation();
                                startEdit(id);
                              }}
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
                                <path
                                  d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"
                                />
                                <path
                                  d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"
                                />
                              </svg>
                            </button>
                            <button
                              class="custom-icon-btn delete"
                              title="删除自定义模型"
                              disabled={deletingId === id}
                              onclick={(e) => {
                                e.stopPropagation();
                                void deleteCustom(id);
                              }}
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
                                <polyline points="3 6 5 6 21 6" />
                                <path
                                  d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"
                                />
                                <path d="M10 11v6" />
                                <path d="M14 11v6" />
                                <path d="M9 6V4h6v2" />
                              </svg>
                            </button>
                          </span>
                          <span class="name">{displayName(id)}</span>
                        </div>
                        {#snippet actions()}
                        <div>
                          <button
                            class="swipe-act"
                            title="编辑自定义模型"
                            aria-label="编辑自定义模型"
                            onclick={() => startEdit(id)}
                          >
                            编辑
                          </button>
                          <button
                            class="swipe-act danger"
                            title="删除自定义模型"
                            aria-label="删除自定义模型"
                            disabled={deletingId === id}
                            onclick={() => void deleteCustom(id)}
                          >
                            删除
                          </button>
                        </div>
                        {/snippet}
                      </AhSwipeItem>
                    {:else}
                      <div class="item" class:active onclick={() => pick(id)}>
                        <span class="name">{displayName(id)}</span>
                      </div>
                    {/if}
                  {/each}
                </div>
              {/if}
            </div>
          {/snippet}
          {#if showFree}{@render group('OPENROUTER FREE', free)}{/if}
          {#if showOpenRouter}{@render group('OPENROUTER', nonFree)}{/if}
          {#each customGroups as g (g.provider)}
            {@render group(g.provider, g.items)}
          {/each}
        </div>
        <div class="footer">
          <button onclick={() => void refreshModels()}>刷新模型</button>
          <button
            onclick={() => {
              adding = !adding;
              editingId = '';
              deletingId = '';
              draftId = '';
              draftBaseUrl = '';
              draftApiKey = '';
            }}
          >
            {adding ? '取消添加' : '添加自定义模型'}
          </button>
          <button onclick={() => (keyDrawerOpen = true)}>
            配置 API Key
          </button>
        </div>
        {#if adding}
          <div class="add-row">
            <input
              placeholder="模型名称（如 my-model）"
              value={draftId}
              oninput={(e) => (draftId = e.currentTarget.value)}
            />
            <input
              placeholder="接口地址（可选，OpenAI 兼容端点）"
              value={draftBaseUrl}
              oninput={(e) => (draftBaseUrl = e.currentTarget.value)}
            />
            <input
              type="password"
              placeholder={editingId
                ? 'API Key（可选；留空保留已保存 Key）'
                : 'API Key（可选，将加密保存）'}
              value={draftApiKey}
              oninput={(e) => (draftApiKey = e.currentTarget.value)}
            />
            {#if editingId}
              <span class="hint">
                已保存 Key 不回显；留空即保留原
                Key，粘贴新值则全量替换。
              </span>
            {/if}
            <div class="add-actions">
              <button
                type="button"
                class="btn ghost"
                onclick={() => {
                  adding = false;
                  draftId = '';
                  draftBaseUrl = '';
                  draftApiKey = '';
                }}
              >
                取消
              </button>
              <button
                type="button"
                class="btn primary"
                disabled={saving}
                onclick={() => void submitDraft()}
              >
                {saving ? '保存中…' : '保存'}
              </button>
            </div>
          </div>
        {/if}
      </div>
    {/if}
  </div>
  {#if keyDrawerOpen}
    <AhDrawer
      open={keyDrawerOpen}
      placement="right"
      title="设置"
      size="100vw"
      mask
      escClosable
      showClose
      fullscreen
      onclose={() => (keyDrawerOpen = false)}
    >
      <SettingsCenter group="keys" groupSeq={1} />
    </AhDrawer>
  {/if}
</div>

<style>
  /* 原 :host 规则 → 根类（宿主 responsive.ts 的移动端规则同以 .model-picker-root 为目标） */
  .model-picker-root {
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
    /* 移动端隐藏滚动条（Firefox scrollbar-width + WebKit 伪元素），保留可滚动。
       原 shadow 内 `*` 通写 → :global(.model-picker-root …)（子树语义不变）。 */
    :global(.model-picker-root *) {
      scrollbar-width: none;
      -ms-overflow-style: none;
    }
    :global(.model-picker-root ::-webkit-scrollbar) {
      display: none;
      width: 0;
      height: 0;
    }
  }
  /* 断点扩展到 760px（与 app 壳移动断点一致）：上方 600px 块之外，
     601–760px（Android 大机型）的弹层滚动容器仍会显示滚动条，此处补齐。 */
  @media (max-width: 760px), (pointer: coarse) {
    :global(.model-picker-root *) {
      scrollbar-width: none;
      -ms-overflow-style: none;
    }
    :global(.model-picker-root ::-webkit-scrollbar) {
      display: none;
      width: 0;
      height: 0;
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
  /* 搜索框：独立圆角容器 + 前缀图标，从面板中清晰独立出来（原先几乎与背景融为一体）。 */
  .panel-head .search {
    display: flex;
    align-items: center;
    gap: 8px;
    background: var(--ah-surface-3, rgba(125, 125, 125, 0.1));
    border: 1px solid var(--ah-border, #2a2a2a);
    border-radius: 10px;
    padding: 7px 10px;
    transition: border-color 0.15s ease;
  }
  .panel-head .search:focus-within {
    border-color: var(--ah-accent, #2997ff);
  }
  .panel-head .search > svg {
    width: 15px;
    height: 15px;
    color: var(--ah-text-muted, #9e9e9e);
    flex: 0 0 auto;
  }
  .panel-head input {
    flex: 1 1 auto;
    width: 100%;
    min-width: 0;
    box-sizing: border-box;
    background: transparent;
    color: var(--ah-text);
    border: none;
    outline: none;
    font: inherit;
    font-size: 13px;
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
    padding: 0 12px;
    cursor: pointer;
    user-select: none;
  }
  .item:hover {
    background: rgba(125, 125, 125, 0.12);
  }
  /* 选中态：低饱和强调色背景 + 左侧 3px 强调线（inset，不挤压布局），
    避免原先「红色描边」易被误读为错误提示的观感；明暗主题自适应。 */
  .item.active {
    background: var(--ah-accent-soft, rgba(41, 151, 255, 0.14));
    box-shadow: inset 3px 0 0 0 var(--ah-accent, #2997ff);
  }
  .item.active:hover {
    background: color-mix(in srgb, var(--ah-accent) 20%, transparent);
  }
  .item.active .name {
    font-weight: 500;
  }
  .item .name {
    flex: 1 1 auto;
    min-width: 0;
    font-size: 13px;
    line-height: 38px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    padding: 0 15px;
  }

  /* 自定义选中项：右侧编辑/删除按钮为绝对定位，若与选中对勾同屏需预留空间，
    否则二者在触屏端（常显）会重叠。 */
  .item.custom-item.active {
    padding-right: 68px;
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
    line-height: 16px;
    cursor: pointer;
    padding: 11px 4px;
    flex: 1 1 auto;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
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
  /* 编辑态下「已保存 Key 不回显，留空即保留」的辅助提示。 */
  .add-row .hint {
    font-size: 12px;
    color: var(--ah-text-muted, #9e9e9e);
    line-height: 1.5;
  }
  .add-actions {
    display: flex;
    gap: 10px;
    justify-content: flex-end;
  }
  /* 复用全应用统一 .btn 体系（与 ah-modal / ah-drawer 一致），保证视觉统一。 */
  .add-actions .btn {
    min-width: 76px;
    padding: 8px 16px;
    font-size: 13px;
    font-family: var(--ah-font-sans);
    cursor: pointer;
    border-radius: var(--ah-radius-md);
    border: 1px solid var(--ah-border);
    transition: background 120ms ease, border-color 120ms ease,
      color 120ms ease;
  }
  .add-actions .btn.ghost {
    background: transparent;
    color: var(--ah-text-muted);
  }
  .add-actions .btn.ghost:hover {
    color: var(--ah-text);
    border-color: var(--ah-text-faint);
  }
  .add-actions .btn.primary {
    background: var(--ah-accent);
    border-color: var(--ah-accent);
    color: #fff;
    font-weight: 600;
  }
  .add-actions .btn.primary:hover {
    background: var(--ah-accent-strong);
    border-color: var(--ah-accent-strong);
  }
  .add-actions .btn:focus-visible {
    outline: 2px solid var(--ah-accent);
    outline-offset: 2px;
  }
  .add-actions .btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
  /* 自定义模型条目 */
  .item.custom-item {
    padding: 0;
    position: relative; /* 作为 .custom-actions 的绝对定位参照，避免脱到父面板 */
    /* 不透明底色：ah-swipe-item 左滑时行内容随内容层位移，
       底色盖住底下的操作区，收起/展开状态视觉才正确。 */
    background: var(--ah-surface-2, #1c1c1c);
  }
  /* 选中态覆盖：保留强调感但保持不透明（半透明 accent-soft 会在
     展开态透出操作按钮）。 */
  .item.custom-item.active {
    background: color-mix(
      in srgb,
      var(--ah-accent, #2997ff) 16%,
      var(--ah-surface-2, #1c1c1c)
    );
  }
  .item.custom-item.active:hover {
    background: color-mix(
      in srgb,
      var(--ah-accent, #2997ff) 24%,
      var(--ah-surface-2, #1c1c1c)
    );
  }
  /* 非选中悬停：不透明微亮化（与 .item:hover 的半透明灰同观感，
     但保持不透明以防展开态透出操作按钮；(0,3,0) 特异性压过基础底色规则）。 */
  .item.custom-item:hover {
    background: color-mix(
      in srgb,
      var(--ah-text, #fff) 7%,
      var(--ah-surface-2, #1c1c1c)
    );
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
  .custom-actions {
    display: none;
    position: absolute;
    right: 4px;
    flex: 0 0 auto;
    z-index: 1;
  }
  /* 鼠标悬停显示编辑/删除按钮：仅真实 hover 设备浮现。
    使用 absolute 定位铺在右侧，避免在 hover 出现时挤压 .name 文本。
    纯触屏设备（hover:none）不再常显 —— 改由通用滑动项 ah-swipe-item 的
    左滑操作区承接（组件内 (hover:hover)+(pointer:fine) 时自动隐藏 .bg，
    本组件 hover 浮现入口随之恢复，双端各取所需、不重叠）。 */
  @media (hover: hover) {
    .item.custom-item:hover .custom-actions {
      display: flex;
    }
  }
  .custom-icon-btn {
    appearance: none;
    border: none;
    background: transparent;
    color: var(--ah-text-muted, #9e9e9e);
    cursor: pointer;
    padding: 6px;
    border-radius: 6px;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: color 100ms ease, background 100ms ease;
  }
  .custom-icon-btn:hover {
    color: var(--ah-text);
    background: rgba(125, 125, 125, 0.15);
  }
  .custom-icon-btn.delete:hover {
    color: var(--ah-danger);
    background: var(--ah-danger-soft);
  }
  .custom-icon-btn svg {
    width: 16px;
    height: 16px;
    display: block;
  }

  /* 「编辑/删除」滑动操作按钮行高 30px：必须置于 swipeActStyles 之后 ——
     共享基类的 .swipe-act { font: inherit } 简写会隐式重置 line-height，
     同特异性（0,1,0）后声明者胜出。swipeActStyles 已随 chat-styles 全局注入，
     本 scoped 规则（特异度 0,2,0）稳定胜出，语义与原版一致。 */
  .swipe-act {
    line-height: 30px;
  }
</style>

<script lang="ts">
  /**
   * 「设置」Tab 的综合设置中心（Svelte 5 迁移版，原 ah-settings-center）。
   *
   * 由来：「我的 → 设置」原本直接承载 provider-key-settings（仅 BYOK 密钥面板）。
   * 现升级为综合设置中心，分四组：模型与密钥 / 系统与网络 / 外观 / 关于，
   * 密钥面板作为「模型与密钥」分区完整保留（直接复用 provider-key-settings）。
   *
   * 版式：
   *  - 分组导航不使用侧栏 / 横滑胶囊，而是窗口顶部「一行等分平铺 Tab」，内容区整宽。
   *  - 桌面：flex 等分（图标在左、全名在右）；移动（≤760px）：grid 等分（图标在上、短名在下），
   *    列数由分组数推导（--set-groups，见根元素内联样式），保证分组一屏可见、无横滑、无溢出菜单。
   *  - 选中态用 accent-soft 底 + accent 字（非实心强调色），全屏唯一强调点仍是密钥面板的「保存」。
   *  - 移动端（≤760px）刻意**不用底色块与边框**表达选中：改为一条 18px 的滑动指示条
   *    （.tab-ink，宽度 = 一列，靠 translateX(下标 × 100%) 平移）+ 图标弹入 + 内容淡入上移。
   *    因此移动端 .tabs 必须 gap:0，等分列无缝，位移距离才与列宽对齐。
   *    全部动效在 `prefers-reduced-motion: reduce` 下关闭。
   *  - 窗口宽度与内嵌密钥面板自身的 760px 约束对齐并水平居中：否则宽屏下密钥分区的卡片会比
   *    其它分组窄一截（内层面板自带 max-width），同一窗口出现两种卡片宽度。
   *
   * 分组定位：父级（App.svelte）经 ah-goto 的 `{ tab:'settings', group }` 传 `group` + `groupSeq`
   * （自增序号，保证同一分组被重复请求时也能重新定位）。未知 / 已下线分组一律忽略并保持当前分组，
   * 避免切到不存在的分组后内容区空白。
   *
   * 内容真实性约定：仅保留「点了确实会发生什么」的行；不做无后端的装饰性开关。
   *  - 系统与网络：服务状态（真实拉取 /api/v1/state）+ 接口地址 + 重新检测 + 清空通知未读
   *    + 存储空间。存储按 **总计 / 应用 / 数据 / 缓存** 四项展示，口径与环境相关（原生壳走
   *    Capacitor Filesystem 量私有目录与缓存目录，与系统「应用信息」同源；纯 Web 走本地存储
   *    与 CacheStorage；「应用」为应用自身网页资源体积，见 utils/storage-usage.ts）。
   *    两个动作：「清除缓存」只清缓存、无需确认；**「清除数据」会抹掉登录状态与全部偏好，
   *    必须先经 AhModal 二次确认**，完成后广播 `ah-session-cleared` 由入口层切回登录页。
   *  - 外观：主题（深色 / 浅色 / 跟随系统，真实写入 ah-theme）+ 侧边栏默认收起（父级持有偏好）。
   *  - 关于：版本号 + 界面语言（只读）。品牌信息不出现在本页——品牌统一收敛到「我的」页，
   *    故此处不渲染品牌卡与版权脚（桌面侧栏品牌块亦已隐藏，见 styles/base.ts）。
   *
   * 视觉：仅引用 --ah-* 语义令牌，深色 / 浅色主题自适应；图标统一 Lucide 线型隐喻（stroke 1.7–1.8）。
   */
  import { onMount, untrack } from 'svelte';
  import {
    getTheme,
    setTheme,
    syncNativeStatusBar,
    THEME_STORAGE_KEY,
    withThemeAnimation,
    type Theme
  } from '../theme/tokens';
  import { client } from '../api';
  import { isPlanDagEnabled, setPlanDagEnabled } from '../chat-render-utils';
  import { AhModal } from './ah-modal';
  import { notify } from './ah-notification';
  import { notifyError } from '../utils/errors';
  import {
    clearCache,
    clearData,
    measureStorage,
    type StorageBreakdown
  } from '../utils/storage-usage';
  import { getReminderUnread, clearReminderUnread } from '../plugin-notify';
  import ProviderKeySettings from './provider-key-settings.svelte';
  import { APP_EVENTS } from '../app-events';

  /** 应用版本号，build-time 由 vite define（__APP_VERSION__）注入，取自 package.json。 */
  // @ts-ignore - vite define 注入
  const APP_VERSION = __APP_VERSION__;

  /**
   * 设置中心的分组 id。
   * 注意：父级经 ah-goto 传来的 `group` 是运行时字符串，可能仍是历史值（如已下线的 account），
   * 故类型收敛不等于运行期可信，定位前仍必须走 GROUP_IDS 校验（见 $effect）。
   */
  type SettingsGroup = 'keys' | 'system' | 'appearance' | 'about';

  /** 主题偏好：dark / light 落 localStorage，system 表示清除偏好、跟随系统。 */
  type ThemeMode = Theme | 'system';

  /** 「侧边栏默认收起」偏好的本地存储键（与 App.svelte 的 SIDEBAR_COLLAPSED_KEY 一致）。 */
  const SIDEBAR_COLLAPSED_KEY = 'ah:sidebar-collapsed';
  /** 「深度思考收起」偏好的本地存储键（与 App.svelte 的 DEEP_THINK_COLLAPSED_KEY 一致）。 */
  const DEEP_THINK_COLLAPSED_KEY = 'ah:deep-think-collapsed';

  /**
   * 统一包一层 Lucide 线型 SVG（同屏同库同风格：24 viewBox / currentColor / round）。
   *
   * ⚠️ 迁移后图标以完整 `<svg>…</svg>` 字符串表示，模板里经 {@html} 注入：
   * innerHTML 在 HTML 上下文解析完整 <svg> 元素没问题（SVG 外来内容会被正确建到
   * SVG 命名空间）；原 Lit 版「必须用 svg 标签而不能用 html 标签」的坑只影响
   * **裸 svg 子元素**（circle/path 等）在无 &lt;svg&gt; 上下文的解析，此处不存在。
   */
  function svgIcon(body: string, strokeWidth = '1.8'): string {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  }

  // ── 分组图标（顶部 Tab）──
  const ICON_KEYS = svgIcon(
    `<circle cx="8" cy="8" r="4" /><path d="M11 11l8 8M16 16l2-2M19 19l2-2" />`
  );
  const ICON_SYSTEM = svgIcon(
    `<path d="M4 7h11M18 7h2M4 17h2M9 17h11" /><circle cx="16" cy="7" r="2.2" /><circle cx="6" cy="17" r="2.2" />`
  );
  const ICON_APPEARANCE = svgIcon(
    `<path d="M12 3a9 9 0 1 0 0 18c1 0 1.6-1 1.3-1.9-.4-1 .3-2 1.3-2H17a3 3 0 0 0 3-3c0-5-4-9-8-9Z" /><circle cx="7.5" cy="10" r="1" /><circle cx="12" cy="7.5" r="1" /><circle cx="16.5" cy="10" r="1" />`
  );
  const ICON_ABOUT = svgIcon(
    `<circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" />`
  );

  // ── 行图标（stroke 1.7，与分组图标同库但更细，形成「导航 > 内容」的层级感）──
  const ICON_ACTIVITY = svgIcon(
    `<path d="M22 12h-4l-3 9L9 3l-3 9H2" />`,
    '1.7'
  );
  const ICON_LINK = svgIcon(
    `<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1" /><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" />`,
    '1.7'
  );
  const ICON_REFRESH = svgIcon(
    `<path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 4v5h-5" />`,
    '1.7'
  );
  const ICON_BELL = svgIcon(
    `<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M10.5 21a2 2 0 0 0 3 0" />`,
    '1.7'
  );
  const ICON_THEME = svgIcon(
    `<circle cx="12" cy="12" r="4" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" />`,
    '1.7'
  );
  const ICON_SIDEBAR = svgIcon(
    `<rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" />`,
    '1.7'
  );
  const ICON_TAG = svgIcon(
    `<path d="M20 12v7a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-7" /><path d="M9 12V4h6v8M9 12h6" />`,
    '1.7'
  );
  const ICON_LANG = svgIcon(
    `<circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18" />`,
    '1.7'
  );

  // ── 存储空间行图标 ──
  const ICON_STORAGE = svgIcon(
    `<ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5" /><path d="M3 12c0 1.66 4.03 3 9 3s9-1.34 9-3" />`,
    '1.7'
  );
  const ICON_TRASH = svgIcon(
    `<path d="M3 6h18" /><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" /><path d="M19 6l-1 13.5A2.5 2.5 0 0 1 15.5 22h-7A2.5 2.5 0 0 1 6 19.5L5 6" />`,
    '1.7'
  );
  // ── 存储空间四行：应用 / 数据 / 缓存 / 危险动作 ──
  const ICON_APP = svgIcon(
    `<path d="M12 3l8 4.4v9.2L12 21l-8-4.4V7.4L12 3Z" /><path d="M12 12l8-4.4M12 12v9M12 12L4 7.6" />`,
    '1.7'
  );
  const ICON_DATA = svgIcon(
    `<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />`,
    '1.7'
  );
  const ICON_CACHE = svgIcon(
    `<rect x="3" y="4" width="18" height="4" rx="1" /><path d="M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8" /><path d="M10 13h4" />`,
    '1.7'
  );
  const ICON_ALERT = svgIcon(
    `<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4M12 17h.01" />`,
    '1.7'
  );
  /** 计划多 Agent 执行行图标：DAG 拓扑节点（一源节点分叉到两个下游节点）。 */
  const ICON_PLAN_DAG = svgIcon(
    `<circle cx="5" cy="6" r="2.2" /><circle cx="17" cy="4.5" r="2.2" /><circle cx="17" cy="12" r="2.2" /><circle cx="13" cy="19" r="2.2" /><path d="M7 6.8l8 6.6M7 5.4l8-1.5M13 16.8V14.2" />`,
    '1.7'
  );

  /**
   * 人读字节数；null / 不可用显示为破折号。
   * 存储四行（总计 / 应用 / 数据 / 缓存）与清理结果提示共用。
   */
  function formatBytes(n: number | null | undefined): string {
    if (n === null || n === undefined || !Number.isFinite(n)) return '—';
    if (n < 1024) return `${Math.round(n)} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let v = n / 1024;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i += 1;
    }
    return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
  }

  const GROUPS: Array<{
    id: SettingsGroup;
    /** 桌面 tab 全名 */
    label: string;
    /** 移动 tab 短名（等分平铺时不易换行） */
    short: string;
    icon: string;
  }> = [
    { id: 'system', label: '系统与网络', short: '系统', icon: ICON_SYSTEM },
    { id: 'keys', label: '模型与密钥', short: '密钥', icon: ICON_KEYS },
    { id: 'appearance', label: '外观', short: '外观', icon: ICON_APPEARANCE },
    { id: 'about', label: '关于', short: '关于', icon: ICON_ABOUT }
  ];

  /** 默认分组 = 首个分组（模型与密钥，设置里最常改的一项）。 */
  const DEFAULT_GROUP: SettingsGroup = GROUPS[0]!.id;

  /** 合法分组 id 集合：用于忽略父级传来的未知 / 已下线分组（如已移除的 account）。 */
  const GROUP_IDS = new Set<SettingsGroup>(GROUPS.map((g) => g.id));

  // ── 属性（原 @property）──
  /**
   * 目标分组（由父级经 ah-goto 传入）。配合 groupSeq 使用：
   * 仅当 groupSeq 变化时才重新定位，避免用户手动切 Tab 后被父级渲染覆盖。
   * 未知 / 已下线分组（如已移除的 account）一律忽略，保持当前分组不出现空白内容区。
   */
  let {
    visible = true,
    group = 'keys',
    groupSeq = 0,
    sidebarCollapsed = false,
    deepThinkCollapsed = false
  }: {
    visible?: boolean;
    group?: string;
    groupSeq?: number;
    sidebarCollapsed?: boolean;
    deepThinkCollapsed?: boolean;
  } = $props();

  // ── 内部状态（原 @state）──
  let active: SettingsGroup = $state(DEFAULT_GROUP);
  let themeMode: ThemeMode = $state('system');
  /** 计划多 Agent 执行开关（P3）：直接持久化到 localStorage key `ah_plan_dag`，
   * 不走父级持有——chat 的 confirmPlan 每次确认时实时读 isPlanDagEnabled()，
   * 设置页改完即生效，无需跨组件事件总线；两入口（设置 Tab / 我的→设置抽屉）
   * 各持一个组件实例，均从同一 key 初始化，重新进入即读到最新值。 */
  let planDagEnabled = $state(true);
  /** 系统与网络：服务端 LLM 连通状态（null = 尚未检测）。 */
  let llmLive: boolean | null = $state(null);
  let checking = $state(false);
  /** 系统与网络：本地未读提醒数。 */
  let unread = $state(0);
  /** 存储空间：总计 / 应用 / 数据 / 缓存 四项占用（null = 尚未测量）。 */
  let storage: StorageBreakdown | null = $state(null);
  let clearingCache = $state(false);
  let clearingData = $state(false);

  /** 已挂载过的分组：切换回来时保留组件状态（如密钥面板已加载的 Key），无需重新拉取。
   * 用普通对象 + `$state` 代替 Set：Svelte 5 对对象属性的读/写是响应式的，
   * 而 Set 的 `.add()` / `.has()` 不会被追踪。 */
  let mountedGroups = $state<Record<SettingsGroup, boolean>>({
    [DEFAULT_GROUP]: true
  } as Record<SettingsGroup, boolean>);

  /** 根元素：用于向祖先派发 bubbles+composed 事件（原 this.dispatchEvent）。 */
  let root: HTMLElement | undefined = $state();

  /** 原 connectedCallback：初始化偏好与未读数。 */
  onMount(() => {
    // 主题偏好：有显式存储值则为 dark / light，否则视为跟随系统。
    const stored =
      typeof localStorage !== 'undefined'
        ? localStorage.getItem(THEME_STORAGE_KEY)
        : null;
    themeMode = stored === 'dark' || stored === 'light' ? stored : 'system';
    // 侧边栏 / 深度思考收起偏好：与主题同理从存储取初值 —— 抽屉里的设置中心
    // （「我的 → 设置」「配置 API Key」）不绑定这些属性，靠此处保证开关显示
    // 与真实偏好一致。设置 Tab 由父级绑定，绑定值即存储值的镜像，二者一致。
    if (typeof localStorage !== 'undefined') {
      sidebarCollapsed = localStorage.getItem(SIDEBAR_COLLAPSED_KEY) !== 'false';
      deepThinkCollapsed =
        localStorage.getItem(DEEP_THINK_COLLAPSED_KEY) === 'true';
      // 计划多 Agent 执行开关：单一事实源 isPlanDagEnabled()（localStorage 不可用时恒为默认「开」）。
      planDagEnabled = isPlanDagEnabled();
    }
    unread = getReminderUnread().count;
  });

  // 原 willUpdate：父级每次经 ah-goto 请求定位分组都会自增 groupSeq，
  // 只有此时才覆盖用户手动选择；随后维护已挂载分组与分组级数据加载。
  let prevGroupSeq = 0;
  $effect(() => {
    const seq = groupSeq;
    if (seq !== prevGroupSeq) {
      prevGroupSeq = seq;
      if (GROUP_IDS.has(group as SettingsGroup)) {
        active = group as SettingsGroup;
      }
    }
    // 父级传入/用户切换后，把当前分组标记为已挂载（惰性渲染）。
    // 该写操作在 untrack 内，避免 effect 自我追踪导致无限循环。
    untrack(() => {
      mountedGroups[active] = true;
      if (active === 'system') {
        void checkServer();
        // 存储占用随使用变化，每次进入「系统与网络」都重新测量一次。
        void refreshStorage();
        unread = getReminderUnread().count;
      }
      if (active === 'appearance') {
        // 计划多 Agent 开关：实例可能比开关变更更早挂载（抽屉常驻 / 两入口各一实例），
        // 每次进入「外观」从同一 key 重新对齐，避免显示陈旧值。
        planDagEnabled = isPlanDagEnabled();
      }
    });
  });

  /** 当前分组的列下标：驱动移动端滑动指示条的位移（找不到时退回 0）。 */
  const activeIndex = $derived(
    Math.max(0, GROUPS.findIndex((g) => g.id === active))
  );

  /** 向祖先派发 bubbles+composed 事件（原 this.dispatchEvent 契约不变）。 */
  function fire(name: string, detail?: unknown): void {
    root?.dispatchEvent(
      new CustomEvent(name, { detail, bubbles: true, composed: true })
    );
  }

  function selectGroup(id: SettingsGroup): void {
    if (active === id) return;
    active = id;
    mountedGroups[id] = true;
  }

  /** 真实拉取 /api/v1/state，读取服务端 LLM 连通状态（live / mock）。 */
  async function checkServer(): Promise<void> {
    if (checking) return;
    checking = true;
    try {
      const s = await client.getState();
      llmLive = !!s?.openrouter;
    } catch (e) {
      llmLive = null;
      notifyError(e, {
        title: '服务端状态',
        fallback: '无法连接服务端，请检查网络或稍后重试',
        key: 'settings-state'
      });
    } finally {
      checking = false;
    }
  }

  /** 重新检测：本地重取状态，并广播 ah-refresh 让顶栏 pill 等全局指示同步。 */
  async function recheck(): Promise<void> {
    await checkServer();
    fire(APP_EVENTS.refresh);
    if (llmLive !== null) {
      notify.success(llmLive ? '服务端状态：LLM live' : '服务端状态：LLM mock');
    }
  }

  function setThemeMode(mode: ThemeMode): void {
    themeMode = mode;
    if (mode === 'system') {
      // 清除显式偏好 → 回落到系统偏好（不写回存储，保持「跟随系统」语义）。
      localStorage.removeItem(THEME_STORAGE_KEY);
      const sys: Theme =
        typeof matchMedia !== 'undefined' &&
        matchMedia('(prefers-color-scheme: light)').matches
          ? 'light'
          : 'dark';
      // 只落 DOM 属性，不写存储；原生状态栏同步随 setTheme 的兄弟路径补上（见 tokens.ts）。
      // 绕过 setTheme 直接写 data-theme，故手动走 withThemeAnimation 保持颜色过渡一致。
      withThemeAnimation(() => {
        document.documentElement.setAttribute('data-theme', sys);
      });
      syncNativeStatusBar(sys);
    } else {
      setTheme(mode);
    }
    // 通知顶层同步 theme 状态（顶栏主题按钮的文案 / 图标由 App.svelte 持有）。
    window.dispatchEvent(
      new CustomEvent(APP_EVENTS.themeChanged, { detail: { theme: getTheme() } })
    );
  }

  function toggleSidebar(): void {
    const collapsed = !sidebarCollapsed;
    sidebarCollapsed = collapsed;
    fire('ah-sidebar-collapsed', { collapsed });
  }

  /** 深度思考收起偏好变更：派发给父级持久化（默认折叠时，对话中深度思考不再默认展开）。 */
  function toggleDeepThinkCollapsed(): void {
    const collapsed = !deepThinkCollapsed;
    deepThinkCollapsed = collapsed;
    fire('ah-deep-think-collapsed', { collapsed });
  }

  /**
   * 计划多 Agent 执行开关变更：即时持久化到 localStorage key（单一事实源），
   * 并提示下次计划确认时生效。不走父级事件——chat 的 confirmPlan 每次确认时
   * 实时读 isPlanDagEnabled()，改完即生效，无需跨组件事件总线。
   */
  function togglePlanDag(): void {
    const on = !planDagEnabled;
    planDagEnabled = on;
    setPlanDagEnabled(on);
    notify.success(on ? '计划多 Agent 执行已开启' : '计划多 Agent 执行已关闭');
  }

  function clearUnread(): void {
    clearReminderUnread();
    unread = 0;
    // 同步顶层红点（App.svelte 按 detail 回填提醒未读状态）。
    window.dispatchEvent(
      new CustomEvent('ah-reminder-unread', {
        detail: { tabId: '', count: 0 }
      })
    );
    notify.success('已清空通知未读');
  }

  /** 下拉刷新：按当前激活分组重载数据（系统组重测服务状态 + 存储占用）。 */
  export async function refresh(): Promise<void> {
    unread = getReminderUnread().count;
    if (active === 'system') {
      void checkServer();
      void refreshStorage();
    }
  }

  /** 重新测量存储四项占用（进入「系统与网络」时、以及每次清理后调用）。 */
  async function refreshStorage(): Promise<void> {
    storage = await measureStorage();
  }

  /** 「清除缓存」：只清缓存（原生缓存目录 + CacheStorage），不动登录状态与偏好，无需二次确认。 */
  async function onClearCache(): Promise<void> {
    if (clearingCache) return;
    clearingCache = true;
    try {
      const r = await clearCache();
      await refreshStorage();
      if (!r.ran) {
        notify.info('当前环境没有可清除的缓存');
        return;
      }
      notify.success(
        r.bytes ? `已清除缓存（约 ${formatBytes(r.bytes)}）` : '已清除缓存'
      );
    } catch (e) {
      notifyError(e, {
        title: '存储空间',
        fallback: '清除缓存失败',
        key: 'settings-cache'
      });
    } finally {
      clearingCache = false;
    }
  }

  /**
   * 「清除数据」：二次确认后清空本地数据 + 缓存，随后重载回登录页。
   *
   * 该动作会抹掉登录凭据与全部偏好（对齐 Android「清除存储」语义），
   * 故用带破坏性红色按钮的确认弹框拦截误触；确认文案明确写出「需要重新登录」。
   */
  async function onClearData(): Promise<void> {
    if (clearingData) return;
    const ok = await AhModal.confirm({
      variant: 'warning',
      danger: true,
      title: '清除数据',
      message:
        '将删除本地全部数据与缓存（登录状态、主题偏好、会话与模型选择等），清除后需要重新登录。此操作不可恢复。',
      confirmText: '清除数据',
      cancelText: '取消',
      maskClosable: false
    });
    if (!ok) return;

    clearingData = true;
    try {
      const r = await clearData();
      notify.success(
        r.bytes
          ? `已清除本地数据（约 ${formatBytes(r.bytes)}），即将返回登录页`
          : '已清除本地数据，即将返回登录页'
      );
      // 本地凭据已清空：广播给入口层（main.ts）切回登录页，而不是整页 reload
      // —— 更快，也不会把刚弹出的结果提示一起刷掉。
      window.dispatchEvent(new CustomEvent(APP_EVENTS.sessionCleared));
    } catch (e) {
      notifyError(e, {
        title: '存储空间',
        fallback: '清除数据失败',
        key: 'settings-data'
      });
      clearingData = false;
    }
  }
</script>

<div
  class="ah-c"
  hidden={!visible}
  bind:this={root}
  style="--set-groups: {GROUPS.length}"
>
  <div class="setwin">
    <div class="head">
      <div class="tabs" role="tablist" style="--tab-i: {activeIndex}">
        {#each GROUPS as g (g.id)}
          <button
            class="ttab"
            class:on={active === g.id}
            role="tab"
            aria-selected={active === g.id ? 'true' : 'false'}
            title={g.label}
            onclick={() => selectGroup(g.id)}
          >
            {@html g.icon}
            <span class="tl full">{g.label}</span>
            <span class="tl short">{g.short}</span>
          </button>
        {/each}
        <!-- 移动端滑动指示条：装饰性，故 aria-hidden；位移由 --tab-i 驱动 -->
        <span class="tab-ink" aria-hidden="true"></span>
      </div>
    </div>

    <div class="pane">
      {#if mountedGroups['keys']}
        <section data-group="keys" hidden={active !== 'keys'}>
          <ProviderKeySettings />
        </section>
      {/if}
      {#if mountedGroups['system']}
        <section data-group="system" hidden={active !== 'system'}>
          <div class="sec-title">服务与网络</div>
          <div class="card">
            <div class="row">
              <span class="ri">{@html ICON_ACTIVITY}</span>
              <span class="rc">
                <span class="rl">服务状态</span>
                <span class="rd">模型调用当前使用真实模型或离线 Mock</span>
              </span>
              <span class="badge {llmLive === null ? 'muted' : llmLive ? 'ok' : 'warn'}">
                {checking
                  ? '检测中…'
                  : llmLive === null
                  ? '未检测'
                  : llmLive
                  ? 'LLM live'
                  : 'LLM mock'}
              </span>
            </div>
            <div class="row">
              <span class="ri">{@html ICON_LINK}</span>
              <span class="rc">
                <span class="rl">接口地址</span>
                <span class="rd mono">
                  {typeof window !== 'undefined' ? window.location.origin : ''}
                </span>
              </span>
            </div>
            <div class="row">
              <span class="ri">{@html ICON_REFRESH}</span>
              <span class="rc">
                <span class="rl">重新检测</span>
                <span class="rd">重新拉取服务端状态并同步全局指示</span>
              </span>
              <button class="btn" disabled={checking} onclick={() => recheck()}>
                {checking ? '检测中…' : '检测'}
              </button>
            </div>
          </div>

          <div class="sec-title">本地数据</div>
          <div class="card">
            <div class="row">
              <span class="ri">{@html ICON_BELL}</span>
              <span class="rc">
                <span class="rl">通知未读</span>
                <span class="rd">
                  本地累计 {unread} 条未读提醒（底栏红点来源）
                </span>
              </span>
              <button
                class="btn"
                disabled={unread === 0}
                onclick={() => clearUnread()}
              >
                清空
              </button>
            </div>
          </div>

          <div class="sec-title">存储空间</div>
          <div class="card">
            <div class="row">
              <span class="ri">{@html ICON_STORAGE}</span>
              <span class="rc">
                <span class="rl">总计</span>
                <span class="rd">应用 + 数据 + 缓存</span>
              </span>
              <span class="sv">{formatBytes(storage?.total)}</span>
            </div>
            <div class="row">
              <span class="ri">{@html ICON_APP}</span>
              <span class="rc">
                <span class="rl">应用</span>
                <span class="rd">应用自身加载的相关资源</span>
              </span>
              <span class="sv">{formatBytes(storage?.app)}</span>
            </div>
            <div class="row">
              <span class="ri">{@html ICON_DATA}</span>
              <span class="rc">
                <span class="rl">数据</span>
                <span class="rd">
                  {storage?.native ? '应用私有文件与本地存储' : '浏览器本地存储'}
                </span>
              </span>
              <span class="sv">{formatBytes(storage?.data)}</span>
            </div>
            <div class="row">
              <span class="ri danger">{@html ICON_ALERT}</span>
              <span class="rc">
                <span class="rl">清除数据</span>
                <span class="rd">删除全部本地数据与缓存，清除后需重新登录</span>
              </span>
              <button
                class="btn danger"
                disabled={clearingData}
                onclick={() => onClearData()}
              >
                {clearingData ? '清除中…' : '清除'}
              </button>
            </div>
            <div class="row">
              <span class="ri">{@html ICON_CACHE}</span>
              <span class="rc">
                <span class="rl">缓存</span>
                <span class="rd">
                  {storage?.native ? '应用缓存目录，可安全清理' : '浏览器资源缓存'}
                </span>
              </span>
              <span class="sv">{formatBytes(storage?.cache)}</span>
            </div>
            <div class="row">
              <span class="ri">{@html ICON_TRASH}</span>
              <span class="rc">
                <span class="rl">清除缓存</span>
                <span class="rd">只清缓存，不影响登录状态与偏好</span>
              </span>
              <button
                class="btn"
                disabled={clearingCache}
                onclick={() => onClearCache()}
              >
                {clearingCache ? '清除中…' : '清除'}
              </button>
            </div>
          </div>
        </section>
      {/if}
      {#if mountedGroups['appearance']}
        <section data-group="appearance" hidden={active !== 'appearance'}>
          <div class="sec-title">主题</div>
          <div class="card">
            <div class="row seg-row">
              <span class="ri">{@html ICON_THEME}</span>
              <span class="rc">
                <span class="rl">主题</span>
                <span class="rd">深色 / 浅色 / 跟随系统偏好</span>
              </span>
              <span class="seg">
                <button
                  class={themeMode === 'dark' ? 'on' : ''}
                  onclick={() => setThemeMode('dark')}
                >
                  深色
                </button>
                <button
                  class={themeMode === 'light' ? 'on' : ''}
                  onclick={() => setThemeMode('light')}
                >
                  浅色
                </button>
                <button
                  class={themeMode === 'system' ? 'on' : ''}
                  onclick={() => setThemeMode('system')}
                >
                  跟随系统
                </button>
              </span>
            </div>
            <div class="row">
              <span class="ri">{@html ICON_SIDEBAR}</span>
              <span class="rc">
                <span class="rl">侧边栏默认收起</span>
                <span class="rd">进入应用时折叠左侧导航（桌面端）</span>
              </span>
              <button
                class="toggle"
                class:on={sidebarCollapsed}
                role="switch"
                aria-checked={sidebarCollapsed ? 'true' : 'false'}
                aria-label="侧边栏默认收起"
                onclick={() => toggleSidebar()}
              ></button>
            </div>
          </div>
          <div class="sec-title">对话</div>
          <div class="card">
            <div class="row">
              <span class="ri">{@html ICON_APPEARANCE}</span>
              <span class="rc">
                <span class="rl">深度思考收起</span>
                <span class="rd">
                  开启后对话中的深度思考默认折叠，不展开推理过程
                </span>
              </span>
              <button
                class="toggle"
                class:on={deepThinkCollapsed}
                role="switch"
                aria-checked={deepThinkCollapsed ? 'true' : 'false'}
                aria-label="深度思考收起"
                onclick={() => toggleDeepThinkCollapsed()}
              ></button>
            </div>
            <div class="row">
              <span class="ri">{@html ICON_PLAN_DAG}</span>
              <span class="rc">
                <span class="rl">计划多 Agent 执行</span>
                <span class="rd">
                  开启后「计划」确认时按任务依赖并行执行、共享中间产物（默认开；关闭则逐任务串行执行）
                </span>
              </span>
              <button
                class="toggle"
                class:on={planDagEnabled}
                role="switch"
                aria-checked={planDagEnabled ? 'true' : 'false'}
                aria-label="计划多 Agent 执行"
                onclick={() => togglePlanDag()}
              ></button>
            </div>
          </div>
        </section>
      {/if}
      {#if mountedGroups['about']}
        <section data-group="about" hidden={active !== 'about'}>
          <div class="card">
            <div class="row">
              <span class="ri">{@html ICON_TAG}</span>
              <span class="rc">
                <span class="rl">版本</span>
                <span class="rd mono">v{APP_VERSION}</span>
              </span>
            </div>
            <div class="row">
              <span class="ri">{@html ICON_LANG}</span>
              <span class="rc">
                <span class="rl">界面语言</span>
                <span class="rd">简体中文</span>
              </span>
            </div>
          </div>
        </section>
      {/if}
    </div>
  </div>
</div>

<style>
  .ah-c {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-height: 0;
    width: 100%;
    /* 与内嵌 provider-key-settings 的 max-width 对齐：否则密钥分区的卡片
     会比其它分组窄（内层面板自带 760px 上限），同一窗口出现两种卡片宽度。
     桌面宽屏下水平居中，避免窗口贴左、右侧留大片空白。 */
    max-width: 760px;
    margin-inline: auto;
    font-family: var(--ah-font-sans);
    color: var(--ah-text);
  }
  /* 惰性挂载：非激活分组保留在 DOM（不丢已加载状态）但隐藏。
   根的 display:flex 会盖过浏览器默认 [hidden]，加 !important 保险。 */
  .ah-c[hidden] {
    display: none !important;
  }
  /* 分组惰性挂载的隐藏：section 自身 display 样式会盖过浏览器默认 [hidden]，
     必须显式 !important（原 Lit 版 [hidden] 规则，迁移时曾遗漏 → 切 Tab 无效）。 */
  .ah-c :global([hidden]) {
    display: none !important;
  }

  /* 设置窗口：与 design/settings-center-mockup.html 方案 B 一致。
   桌面撑满内容区、内容区自身滚动；移动端高度自适应、由页面滚动。 */
  .setwin {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-height: 0;
    border-radius: var(--ah-radius-lg);
    background: var(--ah-surface-1);
    overflow: hidden;
  }

  /* ── 顶部平铺 Tab ── */
  .head {
    border-bottom: 1px solid var(--ah-border);
    padding: 14px 14px 10px;
    flex: 0 0 auto;
  }

  /* 移动端返回「我的」入口（桌面无此需求，隐藏） */
  .h-back {
    display: none;
    border: none;
    background: none;
    color: var(--ah-text-muted);
    font-size: 18px;
    line-height: 1;
    padding: 2px 6px;
    margin-left: -4px;
    border-radius: var(--ah-radius-sm);
    cursor: pointer;
  }
  .h-back:hover {
    color: var(--ah-text);
    background: var(--ah-surface-2);
  }
  .tabs {
    display: flex;
    gap: 6px;
  }
  .ttab {
    flex: 1 1 0;
    min-width: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
    padding: 9px 8px;
    border-radius: 9px;
    border: 1px solid transparent;
    background: transparent;
    color: var(--ah-text-muted);
    font-size: 13px;
    font-family: var(--ah-font-sans);
    cursor: pointer;
    white-space: nowrap;
    transition: background 120ms ease, color 120ms ease,
      border-color 120ms ease;
  }
  .ttab:hover {
    background: var(--ah-surface-2);
    color: var(--ah-text);
  }
  .ttab.on {
    background: var(--ah-accent-soft);
    color: var(--ah-accent);
    font-weight: 600;
    border-color: color-mix(in srgb, var(--ah-accent) 30%, transparent);
  }
  .ttab:focus-visible {
    outline: 2px solid var(--ah-accent);
    outline-offset: 2px;
  }
  /* svg 图标经 {@html} 注入（无 scoping class），须 :global 选中 */
  .ttab :global(svg) {
    width: 15px;
    height: 15px;
    flex: 0 0 auto;
  }
  .tl.short {
    display: none;
  }
  /* 移动端激活指示条：桌面端沿用 accent-soft 底色块，故默认不渲染。 */
  .tab-ink {
    display: none;
  }
  /* 移动端切页动画（关键帧全局定义，仅 ≤760px 使用；置于 :global 保持原名，
   供 :global(svg) 上的 animation 引用）。 */
  :global {
    @keyframes set-tab-pop {
      from {
        transform: scale(0.86);
        opacity: 0.55;
      }
      to {
        transform: none;
        opacity: 1;
      }
    }
    @keyframes set-pane-in {
      from {
        opacity: 0;
        transform: translateY(6px);
      }
      to {
        opacity: 1;
        transform: none;
      }
    }
  }

  /* ── 内容区 ── */
  .pane {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    padding: 18px 20px 24px;
  }

  .sec-title {
    font-size: 11px;
    color: var(--ah-text-faint);
    font-weight: 600;
    letter-spacing: 0.4px;
    padding: 4px 2px 8px;
    margin-top: 14px;
  }
  .pane .sec-title:first-of-type {
    margin-top: 0;
  }
  .card {
    border: 1px solid var(--ah-border);
    background: var(--ah-surface-1);
    border-radius: var(--ah-radius-md);
    padding: 4px 14px;
    margin-bottom: 12px;
  }

  /* 通用设置行：图标盒 + 文案 + 右侧控件 */
  .row {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    padding: 12px 0;
    border-top: 1px solid var(--ah-border);
    background: none;
    border-left: none;
    border-right: none;
    border-bottom: none;
    color: inherit;
    font-family: var(--ah-font-sans);
    text-align: left;
  }
  .card .row:first-child {
    border-top: none;
  }
  button.row {
    cursor: pointer;
    border-radius: var(--ah-radius-sm);
  }
  button.row:hover {
    background: var(--ah-surface-2);
  }
  button.row:focus-visible {
    outline: 2px solid var(--ah-accent);
    outline-offset: -2px;
  }
  .ri {
    width: 30px;
    height: 30px;
    border-radius: 9px;
    background: var(--ah-surface-3);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
    color: var(--ah-text-muted);
  }
  .ri :global(svg) {
    width: 16px;
    height: 16px;
  }
  .rc {
    flex: 1 1 auto;
    min-width: 0;
  }
  .rl {
    font-size: 13.5px;
    font-weight: 600;
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .rd {
    font-size: 11.5px;
    color: var(--ah-text-faint);
    margin-top: 2px;
    word-break: break-all;
  }
  .rd.mono {
    font-family: var(--ah-font-mono);
    font-size: 11px;
  }

  /* 状态徽标 / 次要按钮 */
  .badge {
    font-size: 11px;
    font-weight: 600;
    padding: 3px 10px;
    border-radius: var(--ah-radius-pill);
    flex: 0 0 auto;
  }
  .badge.ok {
    color: var(--ah-success);
    background: var(--ah-success-soft);
  }
  .badge.warn {
    color: var(--ah-warning);
    background: var(--ah-warning-soft);
  }
  .badge.muted {
    color: var(--ah-text-muted);
    background: var(--ah-surface-3);
  }
  .btn {
    flex: 0 0 auto;
    border: 1px solid var(--ah-border);
    background: transparent;
    color: var(--ah-text-muted);
    font-size: 12.5px;
    font-family: var(--ah-font-sans);
    padding: 6px 13px;
    border-radius: var(--ah-radius-md);
    cursor: pointer;
    white-space: nowrap;
    transition: color 120ms ease, border-color 120ms ease;
  }
  .btn:hover:not(:disabled) {
    color: var(--ah-text);
    border-color: var(--ah-text-faint);
  }
  .btn:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
  .btn:focus-visible {
    outline: 2px solid var(--ah-accent);
    outline-offset: 2px;
  }

  /* 开关 */
  .toggle {
    position: relative;
    width: 40px;
    height: 23px;
    flex: 0 0 auto;
    border-radius: var(--ah-radius-pill);
    background: var(--ah-surface-3);
    border: 1px solid var(--ah-border);
    cursor: pointer;
    padding: 0;
    transition: background 150ms ease, border-color 150ms ease;
  }
  .toggle::after {
    content: '';
    position: absolute;
    top: 2px;
    left: 2px;
    width: 17px;
    height: 17px;
    border-radius: 50%;
    background: var(--ah-text-muted);
    transition: transform 150ms ease, background 150ms ease;
  }
  .toggle.on {
    background: var(--ah-accent);
    border-color: var(--ah-accent);
  }
  .toggle.on::after {
    transform: translateX(17px);
    background: #fff;
  }
  .toggle:focus-visible {
    outline: 2px solid var(--ah-accent);
    outline-offset: 2px;
  }

  /* 存储空间：右侧数值列（等宽字体、右对齐，便于纵向比对四项大小） */
  .sv {
    flex: 0 0 auto;
    font-family: var(--ah-font-mono);
    font-size: 12px;
    color: var(--ah-text-muted);
    white-space: nowrap;
  }
  /* 破坏性操作（清除数据）：danger 着色但不做实心色块，避免与唯一强调点「保存」抢视觉 */
  .ri.danger {
    color: var(--ah-danger);
    background: color-mix(in srgb, var(--ah-danger) 14%, transparent);
  }
  .btn.danger {
    color: var(--ah-danger);
    border-color: color-mix(in srgb, var(--ah-danger) 45%, transparent);
  }
  .btn.danger:hover:not(:disabled) {
    color: var(--ah-danger);
    border-color: var(--ah-danger);
    background: color-mix(in srgb, var(--ah-danger) 10%, transparent);
  }

  /* 分段控件 */
  .seg {
    display: inline-flex;
    gap: 4px;
    padding: 3px;
    background: var(--ah-surface-2);
    border-radius: 10px;
    flex: 0 0 auto;
  }
  .seg button {
    border: none;
    background: none;
    color: var(--ah-text-muted);
    font-size: 12.5px;
    font-family: var(--ah-font-sans);
    padding: 6px 12px;
    border-radius: 7px;
    cursor: pointer;
    white-space: nowrap;
    /* 点击微交互：选中态背景/字重平滑过渡 + 按下回缩 */
    transition: color 0.18s ease, background 0.18s ease,
      transform 0.12s ease, border-color 0.18s ease;
  }
  .seg button:hover {
    color: var(--ah-text);
  }
  .seg button:active {
    transform: scale(0.94);
  }
  .seg button.on {
    background: var(--ah-accent);
    color: #fff;
    font-weight: 600;
  }
  .seg button:focus-visible {
    outline: 2px solid var(--ah-accent);
    outline-offset: 2px;
  }

  /* ── 移动端（≤760px，与 app 断点一致）：等分网格平铺 ──
   列数取 --set-groups（= 分组数，由根元素内联样式写入），
   避免「分组增删、这里的列数忘了同步」把网格空出一格或挤出第二行。 */
  @media (max-width: 760px) {
    /* 移动端：根撑满 drawer .body 可视区（100%），
       使 .setwin 占满剩余高度、.pane 内部滚动，
       从而 .head 天然固定在视口内，不随 .body 整体滚动带走。 */
    .ah-c {
      height: 100%;
    }
    .setwin {
      border-radius: 14px;
      height: 100%;
    }
    /* .head 固定：.pane 内部滚动（overflow-y:auto）时，
       .head 在 .setwin 顶部 flex:0 0 auto，始终可见，
       补背景色遮住下方滚过的内容。 */
    .head {
      position: sticky;
      top: 0;
      z-index: 2;
      flex: 0 0 auto;
      background: var(--ah-surface-1);
      padding: 10px 0 8px;
    }
    .tabs {
      display: grid;
      grid-template-columns: repeat(var(--set-groups, 4), minmax(0, 1fr));
      gap: 4px;
    }
    .ttab {
      flex-direction: column;
      gap: 3px;
      padding: 8px 2px;
      font-size: 10.5px;
      line-height: 1.15;
      border-radius: 10px;
      white-space: normal;
      text-align: center;
    }
    .ttab :global(svg) {
      width: 17px;
      height: 17px;
    }
    /* ── 顶部 Tab：移动端去掉底色与边框，改用滑动指示条 + 切换动画 ──
     等分列宽必须无缝（gap:0），否则指示条的位移距离与列宽对不上。 */
    .tabs {
      position: relative;
      gap: 0;
    }
    .ttab {
      position: relative;
      z-index: 1;
      background: transparent;
      border-color: transparent;
      border-radius: 0;
      transition: color 180ms ease, transform 140ms ease;
    }
    .ttab:hover {
      background: transparent;
      color: var(--ah-text-muted);
    }
    .ttab.on {
      background: transparent;
      border-color: transparent;
      color: var(--ah-accent);
    }
    .ttab:active {
      transform: scale(0.94);
    }
    /* 选中项图标轻微弹入（class 切换即重放） */
    .ttab.on :global(svg) {
      animation: set-tab-pop 260ms cubic-bezier(0.2, 0.9, 0.3, 1.2);
    }
    /* 滑动指示条：宽度 = 一列，靠 translateX(下标 × 100%) 平移到当前列 */
    .tab-ink {
      display: block;
      position: absolute;
      left: 0;
      top: 0;
      z-index: 0;
      width: calc(100% / var(--set-groups, 4));
      height: 100%;
      pointer-events: none;
      transform: translateX(calc(var(--tab-i, 0) * 100%));
      transition: transform 280ms cubic-bezier(0.22, 0.61, 0.36, 1);
    }
    .tab-ink::after {
      content: '';
      position: absolute;
      left: 50%;
      bottom: 0;
      width: 18px;
      height: 2px;
      margin-left: -9px;
      border-radius: 2px;
      background: var(--ah-accent);
    }
    /* 内容切页：section 由 hidden 变可见时会重放该动画 */
    section[data-group] {
      animation: set-pane-in 220ms ease-out both;
    }
    .tl.full {
      display: none;
    }
    .tl.short {
      display: inline;
    }
    .pane {
      padding: 14px 12px 18px;
    }
    /* 触控目标：行与图标盒略放大，便于手指命中（≥44px 行高）。
     默认不允许行内控件换行，避免移动端出现「标签独占一行、按钮/开关另起一行」的碎裂观感；
     分段控件（主题选择）需要独占整行，单独加 .seg-row 放行换行。 */
    .row {
      gap: 10px;
      padding: 13px 0;
      flex-wrap: nowrap;
    }
    .row.seg-row {
      flex-wrap: wrap;
    }
    .ri {
      width: 32px;
      height: 32px;
    }
    .btn {
      padding: 8px 14px;
    }
    /* 分段控件独占一行：三段（深色/浅色/跟随系统）在 320px 屏上约占 190px，
     与说明文字同行会把文案挤成竖排（每行 2–3 字的窄柱）。
     换行后左缩进对齐文案起点（图标盒 32px + gap 10px），三段时间等分整行。 */
    .seg {
      flex: 1 1 100%;
      margin-left: 42px;
      margin-top: 2px;
    }
    .seg button {
      flex: 1 1 0;
      padding: 8px 6px;
      text-align: center;
    }
    /* 移动端隐藏滚动条（保留 .pane 可滚动）：原组件未引入 sharedStyles，
       不受 base 的 ≤760px 隐藏块约束，必须自带；断点与 app 壳一致。
       滚动条规则经 :global 命中组件内全部后代元素（原 shadow `*` 选择器语义）。 */
    .ah-c :global(*) {
      scrollbar-width: none;
      -ms-overflow-style: none;
    }
    .ah-c :global(*)::-webkit-scrollbar {
      display: none;
      width: 0;
      height: 0;
    }
  }

  /* 降低动效偏好：关掉移动端的滑条位移、图标弹入与切页动画（无障碍） */
  @media (max-width: 760px) and (prefers-reduced-motion: reduce) {
    .tab-ink,
    .ttab,
    .ttab.on :global(svg),
    section[data-group] {
      transition: none;
      animation: none;
    }
  }
</style>

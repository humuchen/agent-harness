<script lang="ts">
/**
 * 顶层应用壳（ah-app → App.svelte，Svelte 5 迁移版）
 * ----------------------------------------------------------------
 * 顶栏（连接状态 + 令牌）、Tab 导航、各面板容器。
 * 面板常驻挂载，通过 visible prop + 根元素 hidden 属性显隐；
 * 面板 refresh() 经 bind:this 调用（原 DOM query + refresh 方案的同构替代）。
 *
 * 事件契约（与原 Lit 版一致）：
 *  - 面板派发 ah-goto / ah-refresh / ah-sidebar-collapsed / ah-deep-think-collapsed
 *    （bubbles+composed）→ 无 shadow 边界后直达 window，本壳统一监听 window；
 *  - 本壳派发 ah:close-overlays / ah:bar-start / ah:bar-stop 于 window。
 */
  import { onMount, onDestroy } from 'svelte';
  import { tick } from 'svelte';
  import { client, authedFetch, fetchMe } from './api';
  import type { ServerState } from '@agent-harness/client';
  import {
    getTheme,
    toggleTheme,
    type Theme,
    type BrandConfig,
    BRAND_DEFAULT
  } from './theme/tokens';
  import { pluginUIRegistry } from './plugin-ui-registry';
  import { notifyError } from './utils/errors';
  import {
    startPluginNotify,
    stopPluginNotify,
    getReminderUnread,
    clearReminderUnread,
    type ReminderUnread
  } from './plugin-notify';
  import { TopProgressBar } from './top-progress-bar';
  import { PullToRefreshController } from './pull-refresh';
  import { APP_EVENTS } from './app-events';
  // 触感反馈：Tab 切换给一次「刻度感」振动（手机端导航质感）；
  // 边缘滑开抽屉是纯手势，显式补轻震。
  import { hapticSelection, hapticTap } from './utils/haptics';

  // 各面板组件（常驻挂载，visible 控制显隐）
  import Workspace from './workspace.svelte';
  import Dashboard from './dashboard.svelte';
  import Chat from './chat.svelte';
  import Run from './run.svelte';
  import Verify from './verify.svelte';
  import Env from './env.svelte';
  import Mcp from './mcp.svelte';
  import Approvals from './approvals.svelte';
  import Observability from './observability.svelte';
  import Audit from './audit.svelte';
  import OrgTree from './org-tree.svelte';
  import ArtifactLibrary from './artifact-library.svelte';
  import SkillManager from './skill-manager.svelte';
  import DataSourceUi from './data-source-ui.svelte';
  import SandboxConsole from './sandbox-console.svelte';
  import SupplyChain from './supply-chain.svelte';
  import PluginsConsole from './plugins-console.svelte';
  import PlanBoard from './plan-board.svelte';
  import SettingsCenter from './components/settings-center.svelte';
  import UserMenu from './components/user-menu.svelte';

  type Tab =
    | 'workspace'
    | 'dashboard'
    | 'run'
    | 'verify'
    | 'env'
    | 'mcp'
    | 'approvals'
    | 'observability'
    | 'audit'
    | 'org'
    | 'artifact'
    | 'skill'
    | 'datasource'
    | 'sandbox'
    | 'supplychain'
    | 'chat'
    | 'plugins'
    | 'plan'
    | 'settings'
    | 'me'
    | (string & {});

  const SIDEBAR_COLLAPSED_KEY = 'ah:sidebar-collapsed';
  /** 深度思考收起偏好（设置-外观）：开启后对话中深度思考默认折叠。默认 false（展开）。 */
  const DEEP_THINK_COLLAPSED_KEY = 'ah:deep-think-collapsed';

  /**
   * 移动端文档滚动 + 下拉刷新依赖「进页即顶部」：浏览器默认 scrollRestoration=auto
   * 会在刷新后恢复上次的滚动位置，看板类长页面恢复到中部时下拉刷新手势
   * （要求页面在顶部）会被静默拦截，表现为「下拉刷新没生效」。改为手动管理。
   */
  if (typeof history !== 'undefined' && 'scrollRestoration' in history) {
    history.scrollRestoration = 'manual';
  }

  /**
   * 侧边栏收起态只显示「短标签」(data-short)。不同 Tab 的首字可能相同
   * （如「客资看板」与「客服后台」首字都是「客」），若直接取首字会在收起态
   * 出现两个一模一样的字。这里做全局去重：优先 1 字，冲突则逐步加长到
   * 2 字 / 3 字，极端情况用完整 label 兜底，保证收起态每个 Tab 的短标签唯一可辨。
   */
  function uniqueShort(label: string, used: Set<string>): string {
    for (let n = 2; n <= label.length; n++) {
      const cand = label.slice(0, n);
      if (!used.has(cand)) {
        used.add(cand);
        return cand;
      }
    }
    let i = 1;
    let cand = `${label}(${i})`;
    while (used.has(cand)) cand = `${label}(${++i})`;
    used.add(cand);
    return cand;
  }

  /**
   * Tab 归类：PC 侧边栏与移动端抽屉**一致**按 group 渲染分组标题，不再区分端。
   */
  type TabGroup = 'use' | 'ability' | 'observe' | 'govern';

  const TABS: Array<{ id: Tab; label: string; short: string; group: TabGroup }> = [
    { id: 'workspace', label: '工作台', short: '总览', group: 'use' },
    { id: 'chat', label: '对话', short: '对话', group: 'use' },
    { id: 'mcp', label: 'MCP', short: 'M', group: 'ability' },
    { id: 'observability', label: '可观测', short: '观测', group: 'observe' },
    { id: 'audit', label: '审计', short: '审计', group: 'observe' },
    { id: 'org', label: '组织', short: '组织', group: 'govern' },
    { id: 'artifact', label: '档案', short: '档案', group: 'observe' },
    { id: 'skill', label: '技能', short: '技能', group: 'ability' },
    { id: 'datasource', label: '数据源', short: '源', group: 'ability' },
    { id: 'sandbox', label: '沙箱', short: '沙箱', group: 'observe' },
    { id: 'verify', label: '自检', short: '自检', group: 'observe' },
    { id: 'env', label: '环境', short: '环境', group: 'observe' },
    { id: 'supplychain', label: '供应链', short: 'CI', group: 'govern' },
    { id: 'plugins', label: '插件', short: '插件', group: 'ability' },
    { id: 'plan', label: '计划', short: '计划', group: 'use' }
  ];

  const GROUP_TITLE: Record<TabGroup, string> = {
    use: '使用 · 工作流',
    ability: '能力 · 资产',
    observe: '观测 · 运维',
    govern: '治理 · 系统'
  };
  const GROUP_ORDER: TabGroup[] = ['use', 'ability', 'observe', 'govern'];

  /** 按 group 分组的 Tab（PC 侧边栏与移动端抽屉一致）。 */
  const tabGroups: Array<{ group: TabGroup; title: string; items: typeof TABS }> =
    GROUP_ORDER.map((g) => ({
      group: g,
      title: GROUP_TITLE[g],
      items: TABS.filter((t) => t.group === g)
    })).filter((g) => g.items.length > 0);

  /** History 路由：从 location.pathname 解析初始 Tab（如 /chat → chat）。 */
  function initialTabFromPath(): string {
    const seg = window.location.pathname.replace(/^\/+|\/+$/g, '');
    return seg || 'workspace';
  }

  // ── 状态（原 @state 逐一对应） ──────────────────────────────────────
  // P3-1: 品牌位配置（原 AhApp.brand 属性，无外部写入点，取默认值）
  const brand: BrandConfig = BRAND_DEFAULT;
  let tab: Tab = $state(initialTabFromPath());
  // C6 惰性首挂载：重面板（PlanBoard/PluginsConsole/Audit）首次切到才挂载，之后保留
  //（状态不丢）。此前 18 个面板一次性常驻挂载，首屏与常驻内存成本高；配合既有的
  // activatePanel 补拉机制（切 Tab 后 ref.refresh），未挂载面板在首次进入时正常拉数。
  let visitedTabs = $state(new Set<string>([initialTabFromPath()]));
  let serverState = $state<ServerState | null>(null);
  let err = $state<string | null>(null);
  let theme = $state<Theme>(getTheme());
  let me = $state<{
    username: string;
    role: string;
    email: string | null;
  } | null>(null);
  let sidebarCollapsed = $state(
    localStorage.getItem(SIDEBAR_COLLAPSED_KEY) !== 'false'
  );
  /** 深度思考收起偏好（设置-外观）：默认 false（深度思考默认展开）。 */
  let deepThinkCollapsed = $state(
    localStorage.getItem(DEEP_THINK_COLLAPSED_KEY) === 'true'
  );
  /** 全局运行中指示器：任意面板（chat / run）发起运行即亮起，全部结束后熄灭。 */
  let globalRunning = $state(false);
  let settingsGroup = $state('keys');
  let settingsSeq = $state(0);
  /** 顶部进度条实例。 */
  const progressBar = TopProgressBar.getInstance();
  let drawerOpen = $state(false);
  /** 顶栏刷新按钮的加载态：点击后旋转图标直到 refreshActivePanel 完成。 */
  let pageRefreshing = $state(false);
  /** 插件动态 Tab（来自服务端 /api/plugins，无业务词）。 */
  let pluginTabs = $state<Array<{ id: string; label: string; short: string }>>([]);
  /** 正在加载（服务端实时渲染）的插件 Tab id；非空时内容区显示骨架屏。 */
  let pluginLoading = $state<string | null>(null);
  let reminderUnread = $state<ReminderUnread>({ tabId: '', count: 0 });
  /** 移动端下拉刷新控制器（挂载后创建，卸载时解绑）。 */
  let ptr: PullToRefreshController | undefined;

  // ── 面板实例引用（bind:this，替代原 shadowRoot query + refresh 调用） ──
  let workspaceRef: Workspace | undefined = $state();
  let dashboardRef: Dashboard | undefined = $state();
  let chatRef: Chat | undefined = $state();
  let runRef: Run | undefined = $state();
  let verifyRef: Verify | undefined = $state();
  let envRef: Env | undefined = $state();
  let mcpRef: Mcp | undefined = $state();
  let approvalsRef: Approvals | undefined = $state();
  let observabilityRef: Observability | undefined = $state();
  let auditRef: Audit | undefined = $state();
  let orgTreeRef: OrgTree | undefined = $state();
  let artifactRef: ArtifactLibrary | undefined = $state();
  let skillRef: SkillManager | undefined = $state();
  let datasourceRef: DataSourceUi | undefined = $state();
  let sandboxRef: SandboxConsole | undefined = $state();
  let supplyChainRef: SupplyChain | undefined = $state();
  let pluginsRef: PluginsConsole | undefined = $state();
  let planBoardRef: PlanBoard | undefined = $state();
  let settingsCenterRef: SettingsCenter | undefined = $state();

  // ── DOM 引用 ──
  let contentEl: HTMLElement | undefined = $state();
  let mainEl: HTMLElement | undefined = $state();
  let themeToggleBtn: HTMLButtonElement | undefined = $state();

  /**
   * 当前 Tab 对应的面板实例（插件 Tab / 我的 返回 null，走特型容器）。
   * 注意：部分面板（verify/env/mcp 等）本就没有公开 refresh（原 Lit 版即由
   * typeof 守卫兜底），故这里用宽类型承接，调用处仍按 typeof fn === 'function' 守卫。
   */
  type PanelHandle = { refresh?: () => void | Promise<void> };
  function activePanelRef(): PanelHandle | undefined {
    const refs: Record<string, unknown> = {
      workspace: workspaceRef,
      dashboard: dashboardRef,
      chat: chatRef,
      run: runRef,
      verify: verifyRef,
      env: envRef,
      mcp: mcpRef,
      approvals: approvalsRef,
      observability: observabilityRef,
      audit: auditRef,
      org: orgTreeRef,
      artifact: artifactRef,
      skill: skillRef,
      datasource: datasourceRef,
      sandbox: sandboxRef,
      supplychain: supplyChainRef,
      plugins: pluginsRef,
      plan: planBoardRef,
      settings: settingsCenterRef
    };
    return refs[tab] as PanelHandle | undefined;
  }

  // ── 生命周期与事件订阅（原 connectedCallback / disconnectedCallback） ──
  onMount(() => {
    void refreshState();
    theme = getTheme();
    // 拉取当前登录用户资料（顶栏头像 / 角色展示）。
    void loadMe();
    // 拉取插件视图（动态 Tab），失败不阻断主面板。
    void loadPluginViews();
    // 子面板发来的刷新请求（如创建/销毁环境后）；同时重拉插件视图。
    window.addEventListener(APP_EVENTS.refresh, onRefreshRequest);
    // 插件集合变化（启用/停用/升级）：重拉动态 Tab。
    window.addEventListener('ah-plugins-changed', onPluginsChanged as EventListener);
    // 未读提醒数变化。
    reminderUnread = getReminderUnread();
    window.addEventListener('ah-reminder-unread', onReminderUnread as EventListener);
    // 启动插件主动提醒轮询。
    startPluginNotify();
    // 子面板请求切换 Tab。
    window.addEventListener(APP_EVENTS.goto, onGoto as EventListener);
    // 设置中心切换主题 / 侧边栏偏好 → 回填顶层状态。
    window.addEventListener(APP_EVENTS.themeChanged, onThemeChanged);
    window.addEventListener('ah-sidebar-collapsed', onSidebarCollapsed as EventListener);
    window.addEventListener(
      'ah-deep-think-collapsed',
      onDeepThinkCollapsed as EventListener
    );
    // 全局运行中指示器。
    window.addEventListener(APP_EVENTS.runStart, onRunStart);
    window.addEventListener(APP_EVENTS.runStop, onRunStop);
    // History 路由：浏览器后退 / 前进时从 pathname 恢复 Tab。
    window.addEventListener('popstate', onPopState);
    // 移动端 Deep Link（piagent://chat/:sessionId 等，由原生壳转成 ah:deeplink）。
    window.addEventListener(APP_EVENTS.deeplink, onDeepLink as EventListener);
    // 移动端下拉刷新控制器：此时 .content / .main 已稳定存在。
    if (contentEl && mainEl && !ptr) {
      ptr = new PullToRefreshController({
        content: contentEl,
        mount: mainEl,
        isEnabled: () => ptrEnabled(),
        onRefresh: () => refreshActivePanel()
      });
      ptr.attach();
    }
  });

  onDestroy(() => {
    ptr?.detach();
    ptr = undefined;
    window.removeEventListener('popstate', onPopState);
    window.removeEventListener(APP_EVENTS.deeplink, onDeepLink as EventListener);
    window.removeEventListener('ah-plugins-changed', onPluginsChanged as EventListener);
    window.removeEventListener('ah-reminder-unread', onReminderUnread as EventListener);
    window.removeEventListener(APP_EVENTS.refresh, onRefreshRequest);
    window.removeEventListener(APP_EVENTS.goto, onGoto as EventListener);
    window.removeEventListener(APP_EVENTS.themeChanged, onThemeChanged);
    window.removeEventListener('ah-sidebar-collapsed', onSidebarCollapsed as EventListener);
    window.removeEventListener(
      'ah-deep-think-collapsed',
      onDeepThinkCollapsed as EventListener
    );
    window.removeEventListener(APP_EVENTS.runStart, onRunStart);
    window.removeEventListener(APP_EVENTS.runStop, onRunStop);
    stopPluginNotify();
  });

  function onRefreshRequest(): void {
    refreshState();
    void loadPluginViews();
  }

  function onPluginsChanged(): void {
    void loadPluginViews();
  }

  /** 未读提醒数变化：刷新红点状态（detail 含归属 tabId 与最新计数）。 */
  function onReminderUnread(e: CustomEvent<ReminderUnread>): void {
    const d = e.detail;
    reminderUnread = {
      tabId: d?.tabId ?? '',
      count: Number(d?.count) || 0
    };
  }

  /** 子面板请求切换 Tab：detail 为 string（Tab id），或 { tab, group } / { tab, sessionId }。 */
  function onGoto(
    e: CustomEvent<string | { tab?: string; group?: string; sessionId?: string }>
  ): void {
    const d = e.detail;
    if (!d) return;
    if (typeof d === 'string') {
      setTab(d);
      return;
    }
    if (!d.tab) return;
    // 从工作台打开指定会话：切到对话页后通知 chat 选中该会话。
    if (d.tab === 'chat' && d.sessionId) {
      void openChatSession(d.sessionId);
      return;
    }
    // 携带分组：更新目标分组并自增序号，保证重复请求同一分组也能重新定位。
    settingsGroup = d.group ?? 'keys';
    settingsSeq += 1;
    setTab(d.tab);
  }

  /** 设置中心改主题后的同步处理器（顶栏主题按钮文案 / 图标由本壳持有）。 */
  function onThemeChanged(): void {
    theme = getTheme();
    spinThemeIcon(); // 设置面板改主题时，侧栏主题按钮图标同步翻转一次
  }

  /** 设置中心改「侧边栏默认收起」偏好后的处理器。 */
  function onSidebarCollapsed(e: CustomEvent<{ collapsed?: boolean }>): void {
    const collapsed = !!(e as CustomEvent<{ collapsed?: boolean }>).detail?.collapsed;
    sidebarCollapsed = collapsed;
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(collapsed));
  }

  /** 设置中心改「深度思考收起」偏好后的处理器。 */
  function onDeepThinkCollapsed(e: CustomEvent<{ collapsed?: boolean }>): void {
    const collapsed = !!(e as CustomEvent<{ collapsed?: boolean }>).detail?.collapsed;
    deepThinkCollapsed = collapsed;
    localStorage.setItem(DEEP_THINK_COLLAPSED_KEY, String(collapsed));
  }

  function onRunStart(): void {
    globalRunning = true;
  }

  function onRunStop(): void {
    globalRunning = false;
  }

  /** History 路由的 popstate 处理器。 */
  function onPopState(): void {
    const prevTab = tab;
    tab = initialTabFromPath();
    visitedTabs.add(tab); // C6：前进/后退同样标记已访问
    closeDrawer();
    // 浏览器后退/前进时同步关闭所有覆盖层，防止移动端侧滑返回后抽屉/模态残留。
    closeAllOverlays();
    // 路由切换时显示顶部进度条
    if (prevTab !== tab) {
      window.dispatchEvent(new Event(APP_EVENTS.barStart));
      setTimeout(() => window.dispatchEvent(new Event(APP_EVENTS.barStop)), 600);
    }
    // 浏览器前进/后退切到新 Tab 时，补拉该面板数据。
    void activatePanel(tab);
  }

  /** 移动端 Deep Link 处理器。 */
  function onDeepLink(e: CustomEvent<{ path: string; raw: string }>): void {
    const path = e.detail?.path;
    if (!path) return;
    const seg = path.replace(/^\/+/, '').split('/')[0];
    if (seg) setTab(seg);
  }

  /** 屏幕左边沿手势 —— 边缘右滑打开侧栏抽屉（passive 监听，不 preventDefault）。 */
  let edgeStart = 0;
  let edgeStartY = 0;
  let edgeFired = false;
  let edgeActive = false;
  function onTouchStart(e: TouchEvent): void {
    if (e.touches.length !== 1) {
      edgeActive = false;
      return;
    }
    const t = e.touches[0]!;
    const edgeZone = Math.min(32, Math.max(24, window.innerWidth * 0.2));
    if (t.clientX <= edgeZone) {
      edgeActive = true;
      edgeFired = false;
      edgeStart = t.clientX;
      edgeStartY = t.clientY;
    } else {
      edgeActive = false;
    }
  }
  function onEdgeTouchMove(e: TouchEvent): void {
    if (!edgeActive || edgeFired || e.touches.length !== 1) return;
    const t = e.touches[0]!;
    const dx = t.clientX - edgeStart;
    const dy = Math.abs(t.clientY - edgeStartY);
    // 向右 20px 且竖直漂移不过大 → 视为「边缘右滑开抽屉」，单次滑动只触发一次
    if (dx > 20 && dy < 45 && !drawerOpen) {
      edgeFired = true;
      // 触感反馈：边缘滑开抽屉是纯手势（无 click），显式补一次轻震。
      hapticTap('light');
      onToggleDrawer();
    }
  }
  function onEdgeTouchEnd(): void {
    edgeActive = false;
    edgeFired = false;
  }

  /**
   * 统一的 Tab 切换入口：所有写入点（菜单点击 / ah-goto / 插件 Tab）都必须走这里，
   * 同步 pushState 写入路径，使浏览器后退 / 前进 / 刷新与 Tab 状态保持一致。
   */
  function setTab(next: string) {
    const prevTab = tab;
    tab = next;
    visitedTabs.add(next); // C6：标记已访问，触发重面板惰性首挂载
    const target = `/${next}`;
    if (window.location.pathname !== target) {
      history.pushState({ tab: next }, '', target);
    }
    // 路由切换时显示顶部进度条，加载完成后隐藏
    if (prevTab !== next) {
      // 触感反馈：真实发生切换时才给（初始挂载/重复点同一 Tab 不打扰）。
      hapticSelection();
      // 切换 Tab 时关闭所有覆盖层，避免旧抽屉/模态悬浮到新页面。
      closeAllOverlays();
      window.dispatchEvent(new Event(APP_EVENTS.barStart));
      // 短暂延迟后停止，模拟页面加载完成
      setTimeout(() => window.dispatchEvent(new Event(APP_EVENTS.barStop)), 600);
      // 新激活的面板此前在隐藏态挂载时跳过了首屏请求，此处补拉一次。
      void activatePanel(next);
    }
  }

  /**
   * 工作台/侧栏请求打开指定会话：切到对话 Tab 后调用 chat 的 selectSession。
   * 等待一次 tick，确保 chat 已解除 hidden 再调用，避免监听未就绪。
   */
  async function openChatSession(sessionId: string): Promise<void> {
    setTab('chat');
    await tick();
    chatRef?.selectSession(sessionId);
  }

  /**
   * 移动端底栏专用 Tab 切换。
   * - 导航到「资产」时默认落到 MCP（能力分组的首 Tab）；
   * - 切换时关闭移动抽屉，保证操作链干净。
   */
  function setMobileTab(next: 'workspace' | 'chat' | 'mcp' | 'plugins' | 'me') {
    setTab(next);
    closeDrawer();
  }

  /**
   * 拉取服务端 /api/plugins 的插件视图列表，填充前端注册表与动态 Tab。
   * 失败仅告警，不阻断主面板渲染。
   */
  async function loadPluginViews() {
    try {
      const res = await authedFetch('/api/plugins');
      if (!res.ok) return;
      const data = (await res.json()) as {
        views?: Array<{ tabId: string; label: string; html: string }>;
      };
      const views = data.views ?? [];
      pluginUIRegistry.reset();
      for (const v of views) pluginUIRegistry.register(v);
      // 以静态 Tab 已有 short 为种子做去重。
      const used = new Set(TABS.map((t) => t.short));
      pluginTabs = views.map((v) => ({
        id: v.tabId,
        label: v.label,
        short: uniqueShort(v.label, used)
      }));
    } catch (e) {
      // 拉取失败不阻断主面板（回退旧快照），但要让用户知道视图可能不是最新的。
      notifyError(e, {
        title: '插件视图',
        fallback: '插件视图加载失败，展示的可能是旧数据',
        key: 'plugin-views'
      });
    }
  }

  /**
   * 打开插件动态 Tab：先向服务端重新拉取插件视图，再切换到目标 Tab。
   */
  function openPluginTab(id: string) {
    // 先即时切换 Tab（高亮 + 骨架屏），再异步拉取，消除「点击后无反应」等待感。
    setTab(id);
    closeDrawer();
    // 进入承载提醒的 Tab 即清零未读。
    if (reminderUnread.tabId === id) clearReminderUnread();
    pluginLoading = id;
    void loadPluginViews().finally(() => {
      if (pluginLoading === id) pluginLoading = null;
    });
  }

  /**
   * 拉取服务端状态。成功只用于顶栏「运行中」指示的前置判断，失败则保留 err 文案
   * 并额外弹一条通知。
   */
  function refreshState() {
    client
      .getState()
      .then((s) => {
        serverState = s;
        err = null;
      })
      .catch((e) => {
        err = String(e?.message ?? e);
        notifyError(e, { title: '服务端状态', key: 'app-state' });
      });
  }

  /** 拉取当前登录用户资料（username / role / email），供顶栏头像菜单展示。 */
  async function loadMe() {
    const meData = await fetchMe();
    if (meData) me = meData;
  }

  function onToggleTheme() {
    theme = toggleTheme();
    spinThemeIcon();
  }

  /**
   * 主题切换时侧栏主题按钮的图标翻转动画：
   * 给 .theme-toggle 临时挂 .spun 类触发 ah-theme-spin 关键帧，500ms 后移除。
   */
  function spinThemeIcon() {
    const btn = themeToggleBtn;
    if (!btn) return;
    btn.classList.remove('spun');
    // 强制 reflow 后再加类，保证连点也能重启动画
    void btn.offsetWidth;
    btn.classList.add('spun');
    window.setTimeout(() => btn.classList.remove('spun'), 520);
  }

  function onToggleSidebar() {
    sidebarCollapsed = !sidebarCollapsed;
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(sidebarCollapsed));
  }

  function onToggleDrawer() {
    drawerOpen = !drawerOpen;
    syncBodyScroll();
  }

  function closeDrawer() {
    if (!drawerOpen) return;
    drawerOpen = false;
    syncBodyScroll();
  }

  /**
   * 关闭所有覆盖层（抽屉、模态、密码框等）。
   * 路由切换或浏览器后退/前进时派发全局事件，各组件订阅后自行关闭。
   */
  function closeAllOverlays() {
    window.dispatchEvent(new CustomEvent(APP_EVENTS.closeOverlays));
  }

  /** 移动端抽屉打开时锁定背景滚动，关闭后还原。 */
  function syncBodyScroll() {
    document.body.style.overflow = drawerOpen ? 'hidden' : '';
  }

  /** 是否允许下拉刷新：触摸设备 + 抽屉关闭 + 当前非对话/我的页。 */
  function ptrEnabled(): boolean {
    if (!isTouchDevice()) return false;
    if (drawerOpen) return false;
    if (tab === 'chat' || tab === 'me') return false;
    return true;
  }

  /**
   * 下拉刷新触发：调用当前激活面板的 refresh()；插件视图改为重拉服务端渲染；
   * 同时刷新顶栏服务端状态。对话/我的页由 ptrEnabled 已排除，此处仅兜底。
   */
  async function refreshActivePanel(): Promise<void> {
    if (tab === 'me') return;
    if (pluginTabs.some((t) => t.id === tab)) {
      // 必须 await：顶栏刷新按钮的旋转反馈与下拉刷新的 loading 指示
      // 都依赖本 Promise 真实等待数据回来。
      await loadPluginViews();
      return;
    }
    const ref = activePanelRef();
    const fn = ref?.refresh;
    if (typeof fn === 'function') {
      try {
        await fn.call(ref);
      } catch (e) {
        notifyError(e, { title: '刷新失败', key: 'ptr-refresh' });
      }
    }
    refreshState();
  }

  /**
   * 顶栏刷新按钮：与滚动位置无关的显式刷新入口（移动端）。
   */
  async function onTopbarRefresh(): Promise<void> {
    if (pageRefreshing) return;
    pageRefreshing = true;
    try {
      await refreshActivePanel();
    } finally {
      pageRefreshing = false;
    }
  }

  /**
   * 激活某 Tab 后补拉对应面板数据。面板随应用壳一起挂载，但隐藏态时各面板
   * refresh() 有 `if (!visible) return` 守卫、不会发起首屏请求；切到该 Tab
   * （可见）后由本方法触发一次 refresh()，避免「打开页面却是空数据」。
   */
  async function activatePanel(_tab: string) {
    await tick();
    if (tab === 'me') return;
    if (pluginTabs.some((t) => t.id === tab)) {
      void loadPluginViews();
      return;
    }
    const ref = activePanelRef();
    const fn = ref?.refresh;
    if (typeof fn === 'function') {
      try {
        await fn.call(ref);
      } catch (e) {
        notifyError(e, { title: '加载失败', key: 'tab-activate' });
      }
    }
  }

  /** 是否为触摸设备（仅触摸才需要下拉刷新手势）。 */
  function isTouchDevice(): boolean {
    return 'ontouchstart' in window || (navigator.maxTouchPoints ?? 0) > 0;
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="shell ah-c{tab === 'chat' ? ' chat-mode' : ''}"
  ontouchstart={onTouchStart}
  ontouchmove={onEdgeTouchMove}
  ontouchend={onEdgeTouchEnd}
>
  <aside
    class="sidebar{sidebarCollapsed ? ' collapsed' : ''}{drawerOpen ? ' open' : ''}"
  >
    <div class="brand">
      <svg
        class="logo"
        viewBox="0 0 100 100"
        fill="currentColor"
        aria-hidden="true"
      >
        <path d="M50 6 L84 20 L50 34 L16 20 Z" />
        <path d="M50 36 L84 50 L50 64 L16 50 Z" />
        <path d="M50 66 L84 80 L50 94 L16 80 Z" />
      </svg>
      <span class="brand-text">{brand?.productName ?? 'Agent Harness'}</span>
      <button
        class="sidebar-toggle"
        title={sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'}
        onclick={onToggleSidebar}
        aria-label={sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'}
      >
        <svg
          class="toggle-icon"
          viewBox="0 0 16 14"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <rect x="0.8" y="0.8" width="14.4" height="12.4" rx="2.4" />
          <path d="M5.4 0.8v12.4" />
        </svg>
      </button>
    </div>
    <nav class="nav">
      {#each tabGroups as g (g.group)}
        <div class="nav-group-title">{g.title}</div>
        {#each g.items as t (t.id)}
          <button
            class="nav-item{tab === t.id ? ' active' : ''}"
            data-short={t.short}
            title={t.label}
            onclick={() => {
              setTab(t.id);
              closeDrawer();
            }}
          >
            <span class="nav-text">{t.label}</span>
          </button>
        {/each}
      {/each}
    </nav>
    {#if pluginTabs.length}
      <div class="nav-sep"></div>
      {#each pluginTabs as t (t.id)}
        {@const unread = reminderUnread.tabId === t.id ? reminderUnread.count : 0}
        <button
          class="nav-item plugin{tab === t.id ? ' active' : ''}"
          data-short={t.short}
          title={unread > 0 ? `${t.label}（${unread} 条未读提醒）` : t.label}
          onclick={() => openPluginTab(t.id)}
        >
          <span class="nav-text">{t.label}</span>
          {#if unread > 0}
            <span class="nav-dot" aria-label={`${unread} 条未读提醒`}
              >{unread > 99 ? '99+' : unread}</span
            >
          {/if}
        </button>
      {/each}
    {/if}
    <div class="nav-spacer"></div>
    <div class="sidebar-foot">
      <button
        bind:this={themeToggleBtn}
        class="theme-toggle"
        title={theme === 'dark' ? '切换亮色主题' : '切换暗色主题'}
        onclick={onToggleTheme}
      >
        <span class="theme-text">{theme === 'dark' ? '暗色主题' : '亮色主题'}</span>
        <span class="theme-icon">{theme === 'dark' ? '☾' : '☀'}</span>
      </button>
      <!-- 移动端账户口子节点，抽屉底部「我的」快速入口 -->
      <button
        class="nav-item nav-mine"
        data-short="我"
        title="我的"
        onclick={() => {
          setTab('me');
          closeDrawer();
        }}
      >
        <span class="nav-text">我的</span>
      </button>
    </div>
  </aside>

  <div
    class="scrim{drawerOpen ? ' show' : ''}"
    role="presentation"
    onclick={() => closeDrawer()}
  ></div>

  <div class="main" bind:this={mainEl}>
    <header class="topbar">
      {#if tab !== 'chat'}
        <button
          class="menu-btn"
          title="打开导航"
          onclick={() => onToggleDrawer()}
          aria-label="打开导航"
        >
          ☰
        </button>
      {/if}
      <div class="state">
        {#if serverState}
          {#if globalRunning}
            <span class="pill running">运行中</span>
          {/if}
        {:else}
          <span class="pill err">{err ?? '连接中…'}</span>
        {/if}
      </div>
      <!-- 移动端显式刷新入口（桌面 CSS 隐藏）：与滚动位置无关。对话页有自己的
           会话刷新路径、「我的」页无数据可刷，均不渲染。 -->
      {#if tab !== 'chat' && tab !== 'me'}
        <button
          class="topbar-refresh{pageRefreshing ? ' spinning' : ''}"
          title="刷新当前页"
          aria-label="刷新当前页"
          onclick={() => void onTopbarRefresh()}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M21 12a9 9 0 1 1-2.64-6.36" />
            <path d="M21 3v6h-6" />
          </svg>
        </button>
      {/if}
    </header>

    <main class="content{tab === 'chat' ? ' chat' : ''}" bind:this={contentEl}>
      <Workspace bind:this={workspaceRef} visible={tab === 'workspace'} />
      <Dashboard bind:this={dashboardRef} visible={tab === 'dashboard'} />
      <Chat
        bind:this={chatRef}
        visible={tab === 'chat'}
        role={me?.role ?? ''}
        deepThinkCollapsed={deepThinkCollapsed}
      />
      <Run bind:this={runRef} visible={tab === 'run'} />
      <Verify bind:this={verifyRef} visible={tab === 'verify'} />
      <Env bind:this={envRef} visible={tab === 'env'} />
      <Mcp bind:this={mcpRef} visible={tab === 'mcp'} />
      <Approvals bind:this={approvalsRef} visible={tab === 'approvals'} />
      <Observability
        bind:this={observabilityRef}
        visible={tab === 'observability'}
      />
      {#if visitedTabs.has('audit')}
        <Audit bind:this={auditRef} visible={tab === 'audit'} />
      {/if}
      <OrgTree bind:this={orgTreeRef} visible={tab === 'org'} />
      <ArtifactLibrary bind:this={artifactRef} visible={tab === 'artifact'} />
      <SkillManager bind:this={skillRef} visible={tab === 'skill'} />
      <DataSourceUi bind:this={datasourceRef} visible={tab === 'datasource'} />
      <SandboxConsole bind:this={sandboxRef} visible={tab === 'sandbox'} />
      <SupplyChain bind:this={supplyChainRef} visible={tab === 'supplychain'} />
      {#if visitedTabs.has('plugins')}
        <PluginsConsole bind:this={pluginsRef} visible={tab === 'plugins'} />
      {/if}
      {#if visitedTabs.has('plan')}
        <PlanBoard bind:this={planBoardRef} visible={tab === 'plan'} />
      {/if}
      <!-- 设置 Tab：综合设置中心（顶部平铺分组 Tab；「模型与密钥」内嵌 BYOK 面板） -->
      <SettingsCenter
        bind:this={settingsCenterRef}
        visible={tab === 'settings'}
        group={settingsGroup}
        groupSeq={settingsSeq}
        sidebarCollapsed={sidebarCollapsed}
        deepThinkCollapsed={deepThinkCollapsed}
      />
      <!-- 我的 Tab：复用 ah-user-menu，头像＋改密＋退出全部收进来 -->
      <div class="me-view" hidden={tab !== 'me'}>
        {#if me}
          <UserMenu
            username={me.username}
            role={me.role}
            email={me.email ?? ''}
            standalone
          />
        {:else}
          <div class="me-skeleton">
            <div
              class="sk sk-line"
              style="width:120px;height:120px;border-radius:50%"
            ></div>
            <div class="sk sk-line" style="width:40%"></div>
            <div class="sk sk-line" style="width:60%"></div>
          </div>
        {/if}
      </div>
      {#if pluginTabs.some((t) => t.id === tab)}
        <div class="plugin-view">
          {#if pluginLoading === tab}
            <div class="skeleton">
              <div class="sk-line" style="width:40%"></div>
              <div class="sk-line" style="width:90%"></div>
              <div class="sk-line" style="width:80%"></div>
              <div class="sk-line" style="width:95%"></div>
              <div class="sk-line" style="width:60%"></div>
            </div>
          {:else}
            {@html pluginUIRegistry.getHtml(tab)}
          {/if}
        </div>
      {/if}
    </main>

    <!-- 品牌信息已收敛到「我的」页（移动端）与登录页，桌面内容区不再渲染品牌脚。 -->

    <!-- 移动端底栏 Tab（≤760px 显示）：工作台/对话/资产/插件/我的 -->
    <div class="mobile-tabbar" role="tablist">
      <button
        class="m-tab{tab === 'workspace' ? ' on' : ''}"
        role="tab"
        aria-selected={tab === 'workspace'}
        onclick={() => setMobileTab('workspace')}
        aria-label="工作台"
      >
        <span class="ti">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <rect x="3" y="3" width="8" height="8" rx="1.5" />
            <rect x="13" y="3" width="8" height="5" rx="1.5" />
            <rect x="13" y="10" width="8" height="11" rx="1.5" />
            <rect x="3" y="13" width="8" height="8" rx="1.5" />
          </svg>
        </span>
      </button>
      <button
        class="m-tab{tab === 'chat' ? ' on' : ''}"
        role="tab"
        aria-selected={tab === 'chat'}
        onclick={() => setMobileTab('chat')}
        aria-label="对话"
      >
        <span class="ti">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path
              d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"
            />
            <path d="M8 9h8M8 13h5" />
          </svg>
        </span>
      </button>
      <button
        class="m-tab{tab === 'mcp' || tab === 'skill' || tab === 'datasource'
          ? ' on'
          : ''}"
        role="tab"
        aria-selected={tab === 'mcp' || tab === 'skill' || tab === 'datasource'}
        onclick={() => setMobileTab('mcp')}
        aria-label="资产"
      >
        <span class="ti">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M12 3 4 7v10l8 4 8-4V7l-8-4Z" />
            <path d="M4 7l8 4 8-4" />
            <path d="M12 11v10" />
          </svg>
        </span>
      </button>
      <button
        class="m-tab{tab === 'plugins' ? ' on' : ''}"
        role="tab"
        aria-selected={tab === 'plugins'}
        onclick={() => setMobileTab('plugins')}
        aria-label="插件"
      >
        <span class="ti">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path
              d="M9 4h6a2 2 0 0 1 2 2v1h2a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-2v1a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2v-1H5a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2h2V6a2 2 0 0 1 2-2Z"
            />
            <path d="M12 4v2M12 18v2M4 12h2M18 12h2" />
          </svg>
        </span>
      </button>
      <button
        class="m-tab{tab === 'me' ? ' on' : ''}"
        role="tab"
        aria-selected={tab === 'me'}
        onclick={() => setMobileTab('me')}
        aria-label="我的"
      >
        <span class="ti">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <circle cx="12" cy="8" r="4" />
            <path d="M5 20a7 7 0 0 1 14 0" />
          </svg>
        </span>
      </button>
    </div>
  </div>
</div>

<style>
  /* 面板显隐：根元素 hidden 属性（原 :host([hidden]) 语义，全局属性选择器）。 */
  .content :global([hidden]) {
    display: none !important;
  }

  /* 插件 Tab 的未读提醒红点徽标（原 navDotCss）。 */
  .nav-dot {
    flex: none;
    margin-left: auto;
    min-width: 16px;
    height: 16px;
    padding: 0 4px;
    box-sizing: border-box;
    border-radius: 999px;
    background: var(--ah-danger, #e5484d);
    color: #fff;
    font-size: 10px;
    font-weight: 600;
    line-height: 16px;
    text-align: center;
    font-variant-numeric: tabular-nums;
  }
  /* 收起态：只剩短标签、宽度紧张，退化为右上角的小圆点（隐去数字，只表「有未读」）。 */
  .sidebar.collapsed .nav-dot {
    position: absolute;
    top: 4px;
    right: 4px;
    margin-left: 0;
    width: 8px;
    min-width: 8px;
    height: 8px;
    padding: 0;
    font-size: 0;
    line-height: 0;
  }

  /* 桌面端恢复 :host 视口锁定（原 desktopShellCss）。 */
  @media (min-width: 761px) and (min-height: 761px) {
    .ah-c {
      height: 100vh;
      height: 100dvh;
      overflow: hidden;
    }
  }

  /* 移动端顶层壳 :host 覆盖（原 mobileShellCss，仅作用于应用壳根）。 */
  @media (max-width: 760px), (orientation: landscape) and (max-height: 760px) {
    .ah-c {
      /* 底部固定栏高度：单一来源，供 .content 底部留白引用。
         自定义属性从应用壳根沿 DOM 向下继承，面板内的 calc(var(--ah-tabbar-h))
         消费不受影响（继承跨边界——Svelte 无 shadow，天然成立）。 */
      --ah-tabbar-h: calc(48px + env(safe-area-inset-bottom, 0px));
      height: auto;
      min-height: 100dvh;
      overflow: visible;
    }
  }

  /* 对话 Tab 外壳锁定（原 chatShellCss）。 */
  @media (max-width: 900px), (orientation: landscape) and (max-height: 760px) {
    .shell.chat-mode {
      position: fixed;
      inset: 0;
      z-index: 1;
      display: flex;
      flex-direction: row;
      overflow: hidden;
    }
    .shell.chat-mode .main {
      display: flex;
      flex-direction: column;
      height: 100%;
      overflow: hidden;
    }
    .shell.chat-mode .topbar {
      display: none;
    }
    /* 移动端对话页：隐藏刷新按钮，仅留状态与菜单，节省竖向空间 */
    .shell.chat-mode .topbar .ghost {
      display: none;
    }
    .shell.chat-mode .content {
      flex: 1 1 auto;
      min-height: 0;
      overflow: hidden;
      /* 固定底栏 Tab 总高 = 48px + safe-area；chat height:100% 占满
         content-box，composer 落在 content-box 底部。要让输入框与底栏之间
         有 ~16px 呼吸距离 → 留白 = 48px（与共享样式 .content 一致）。 */
      padding-bottom: calc(48px + env(safe-area-inset-bottom, 0px));
    }
  }

  /* 移动端下拉刷新指示器（原 ptrCss）：指示器由 PullToRefreshController 动态挂载到
     .main，不在本组件模板中，故用 :global。仅触摸手势触发，桌面无副作用。 */
  :global(.ptr-indicator) {
    position: fixed;
    left: 0;
    right: 0;
    top: 0;
    height: 0;
    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    color: var(--ah-text-dim, #8b93a7);
    font-size: 13px;
    z-index: 25;
    pointer-events: none;
    background: transparent;
  }
  :global(.ptr-indicator .ptr-spin) {
    width: 18px;
    height: 18px;
    border: 2px solid var(--ah-border, #3a3f4b);
    border-top-color: var(--ah-accent, #4c8dff);
    border-radius: 50%;
    animation: ptr-spin 0.7s linear infinite;
  }
  @keyframes ptr-spin {
    to {
      transform: rotate(360deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    :global(.ptr-indicator .ptr-spin) {
      animation-duration: 1.4s;
    }
  }
  /* 顶栏显式刷新按钮（移动端显示）：下拉刷新要求页面在顶部，用户浏览到
     看板中部时没有刷新出口 —— 该按钮提供与滚动位置无关的可靠刷新入口。
     桌面隐藏（无下拉刷新预期，各面板自带刷新入口）。 */
  .topbar-refresh {
    flex: 0 0 auto;
    width: 34px;
    height: 34px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--ah-radius-sm);
    background: var(--ah-surface-2);
    border: 1px solid var(--ah-border);
    color: var(--ah-text-muted);
    cursor: pointer;
    padding: 0;
    font-family: inherit;
    transition:
      color 0.15s,
      border-color 0.15s;
  }
  .topbar-refresh:hover {
    color: var(--ah-text);
    border-color: var(--ah-accent);
  }
  .topbar-refresh svg {
    width: 16px;
    height: 16px;
    display: block;
  }
  /* 顶栏刷新按钮点击后的旋转反馈：加载期间持续旋转，提示刷新已在进行 */
  .topbar-refresh.spinning svg {
    animation: ptr-spin 0.7s linear infinite;
  }
  @media (min-width: 761px) {
    .topbar-refresh {
      display: none;
    }
  }
</style>

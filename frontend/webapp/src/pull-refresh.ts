/**
 * 移动端下拉刷新控制器（框架无关，纯 DOM 手势实现）。
 *
 * 设计要点：
 * - 移动端（≤760px）外层壳被解锁为文档自然滚动，滚动容器是 window（见 styles/responsive.ts），
 *   因此手势判定以 window.scrollY 为准，在滚动到顶（scrollY<=0）且向下拖拽时触发。
 * - 仅触摸设备生效（'ontouchstart' / maxTouchPoints）；桌面鼠标不会触发。
 * - 触发后对外回调 onRefresh()（由外壳负责调用当前激活面板的 refresh()），
 *   同时给内容区施加 translateY 橡皮筋效果、并在顶栏下方露出刷新指示器。
 * - 不触碰 Lit 渲染的 DOM 节点（只平移 .content、挂一个独立 indicator），
 *   避免与外壳的模板 diff 失同步。
 */

/** 下拉刷新阶段，供 CSS 通过 data-phase 区分样式。 */
export type PtrPhase = 'idle' | 'pull' | 'ready' | 'loading';

export interface PullToRefreshOptions {
  /** 内容容器：下拉时对其施加 translateY 橡皮筋效果（移动端即 .content）。 */
  content: HTMLElement;
  /** 指示器挂载点（建议 .main）；指示器用 position:fixed，挂载点仅作容器。 */
  mount: HTMLElement;
  /** 当前是否允许下拉刷新（非对话/我的、触摸设备、抽屉关闭等由外壳判定）。 */
  isEnabled: () => boolean;
  /** 触发刷新回调，返回 Promise，结束后自动收起指示器。 */
  onRefresh: () => Promise<void> | void;
}

/** 触发刷新所需的最小下拉距离（px）。 */
const THRESHOLD = 64;
/** 下拉阻尼系数（位移随手指位移按比例缩小，避免一次性拉到底）。 */
const DAMPING = 0.5;
/** 下拉最大可视距离（px），防止橡皮筋过度。 */
const MAX_PULL = 96;

export class PullToRefreshController {
  private readonly content: HTMLElement;
  private readonly mount: HTMLElement;
  private readonly isEnabled: () => boolean;
  private readonly onRefresh: () => Promise<void> | void;

  private readonly indicator: HTMLDivElement;
  private readonly textEl: HTMLSpanElement;

  private startY = 0;
  private pulling = false;
  /** 当前下拉的可视距离（已阻尼）。 */
  private dist = 0;
  private phase: PtrPhase = 'idle';
  private refreshing = false;
  /** 顶栏高度（指示器的固定定位 top 基准）。 */
  private topbarH = 0;

  constructor(opts: PullToRefreshOptions) {
    this.content = opts.content;
    this.mount = opts.mount;
    this.isEnabled = opts.isEnabled;
    this.onRefresh = opts.onRefresh;

    this.indicator = document.createElement('div');
    this.indicator.className = 'ptr-indicator';
    this.indicator.dataset.phase = 'idle';
    const spin = document.createElement('span');
    spin.className = 'ptr-spin';
    this.textEl = document.createElement('span');
    this.textEl.className = 'ptr-text';
    this.textEl.textContent = '下拉刷新';
    this.indicator.appendChild(spin);
    this.indicator.appendChild(this.textEl);
  }

  /** 绑定触摸监听并挂载指示器；同时压制原生 overscroll，避免与浏览器/WebView 下拉刷新打架。 */
  attach(): void {
    window.addEventListener('touchstart', this.touchStart, { passive: true });
    window.addEventListener('touchmove', this.touchMove, { passive: false });
    window.addEventListener('touchend', this.touchEnd);
    window.addEventListener('touchcancel', this.touchEnd);
    document.body.style.overscrollBehaviorY = 'contain';
    this.mount.appendChild(this.indicator);
  }

  /** 解绑并移除指示器，还原原生 overscroll 行为。 */
  detach(): void {
    window.removeEventListener('touchstart', this.touchStart);
    window.removeEventListener('touchmove', this.touchMove);
    window.removeEventListener('touchend', this.touchEnd);
    window.removeEventListener('touchcancel', this.touchEnd);
    document.body.style.overscrollBehaviorY = '';
    this.indicator.remove();
  }

  private readonly touchStart = (e: TouchEvent): void => {
    if (!this.isEnabled() || this.refreshing) return;
    // 仅当页面已滚到最顶（文档滚动容器 scrollY<=0）才允许下拉。
    if (window.scrollY > 0) return;
    if (e.touches.length !== 1) return;
    this.startY = e.touches[0]!.clientY;
    this.pulling = true;
    this.dist = 0;
  };

  private readonly touchMove = (e: TouchEvent): void => {
    if (!this.pulling || e.touches.length !== 1) return;
    const y = e.touches[0]!.clientY;
    const delta = y - this.startY;

    // 手指上移或页面已离开顶部 → 取消本次下拉，交还原生滚动。
    if (delta <= 0 || window.scrollY > 0) {
      if (this.dist !== 0) {
        this.dist = 0;
        this.setPhase('idle');
        this.render();
      }
      this.pulling = false;
      return;
    }

    // 命中下拉：阻止原生滚动/回弹，施加阻尼位移。
    e.preventDefault();
    this.topbarH = this.topbarHeight();
    this.dist = Math.min(delta * DAMPING, MAX_PULL);
    this.setPhase(this.dist >= THRESHOLD ? 'ready' : 'pull');
    this.render();
  };

  private readonly touchEnd = (): void => {
    if (!this.pulling) return;
    this.pulling = false;
    if (this.dist >= THRESHOLD) {
      void this.doRefresh();
    } else {
      this.dist = 0;
      this.setPhase('idle');
      this.render();
    }
  };

  private async doRefresh(): Promise<void> {
    this.refreshing = true;
    // 刷新中保持指示器可见高度。
    this.dist = THRESHOLD;
    this.setPhase('loading');
    this.render();
    try {
      await this.onRefresh();
    } catch {
      // 单个面板的刷新错误由其自身 notifyError 处理，这里不重复弹。
    } finally {
      this.refreshing = false;
      this.dist = 0;
      this.setPhase('idle');
      this.render();
    }
  }

  private setPhase(p: PtrPhase): void {
    this.phase = p;
    this.indicator.dataset.phase = p;
    this.textEl.textContent =
      p === 'loading'
        ? '刷新中…'
        : p === 'ready'
          ? '释放刷新'
          : '下拉刷新';
  }

  private render(): void {
    // 指示器：贴在顶栏正下方，随下拉距离长高。
    this.indicator.style.top = `${this.topbarH}px`;
    this.indicator.style.height = `${this.dist}px`;
    // 内容区橡皮筋：仅在拖拽/收起瞬间关闭过渡，避免每帧抖动。
    if (this.phase === 'idle' || this.refreshing) {
      this.content.style.transition = 'transform .25s ease';
    } else {
      this.content.style.transition = 'none';
    }
    this.content.style.transform =
      this.dist > 0 ? `translateY(${this.dist}px)` : '';
  }

  private topbarHeight(): number {
    const tb = this.mount.querySelector('.topbar') as HTMLElement | null;
    return tb ? tb.offsetHeight : 0;
  }
}

/**
 * chat-scroll-store —— 消息区滚动跟随 + 窗口化渲染状态（chat.svelte 拆分首刀）。
 *
 * 职责（自 chat.svelte 外迁的完整状态簇）：
 * - 钉底跟随（stickToBottom）与「回到底部」按钮显隐（showScrollDown）；
 * - 窗口化渲染（windowSize）：长会话默认只渲染最近 WINDOW_INITIAL 条，上滚
 *   接近顶部按 WINDOW_STEP 渐进扩容（上限 WINDOW_MAX）——常驻 DOM 从 O(n)
 *   降到 O(窗口)；与 .thread 的 content-visibility:auto、.scroll 的
 *   overflow-anchor:auto（原生滚动锚定）叠加使用。
 *
 * Svelte 5：class 字段 $state 在 .svelte.ts 内可用，导出单例供组件读写。
 * scrollEl 为 DOM 引用（bind:this 注入），刻意不做响应式。
 */
const WINDOW_INITIAL = 60;
const WINDOW_STEP = 200;
const WINDOW_MAX = 5000;
/** 触发扩容的「接近顶部」阈值（px）。 */
const WINDOW_EXPAND_AT = 420;
/** 距底阈值（px）：容忍亚像素/轻微回弹，认为已到底部则隐藏按钮、恢复跟随。
 *  同时被 chat.svelte 的思考区钉底逻辑复用（同款距底判定）。 */
export const AT_BOTTOM_THRESHOLD = 24;

export class ChatScrollStore {
  /** 消息区滚动容器 DOM（bind:this 注入）。 */
  scrollEl: HTMLElement | null = null;
  /** 是否处于「钉底」跟随状态：true 时新消息/更新自动滚到底部。 */
  stickToBottom = $state(true);
  /** 浮动「回到底部」按钮是否可见（未钉底时显示）。 */
  showScrollDown = $state(false);
  /** 窗口化渲染：当前渲染的消息窗口大小。 */
  windowSize = $state(WINDOW_INITIAL);

  /** 仅当处于钉底状态才把消息区滚到底部（渲染后调用，不触发状态变更）。 */
  scrollToBottom(): void {
    const el = this.scrollEl;
    if (el && this.stickToBottom) el.scrollTop = el.scrollHeight;
  }

  /**
   * 消息区滚动监听：计算距底距离，更新钉底状态与浮动按钮显隐；接近顶部时
   * 渐进扩窗。overflow-anchor 负责扩容插入头部 DOM 时锚定视口不跳动。
   * @param totalVisible 当前过滤后的可见消息总数（由组件传入，store 不依赖组件状态）。
   */
  onScrollFollow(totalVisible: number): void {
    const el = this.scrollEl;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBottom = distance <= AT_BOTTOM_THRESHOLD;
    this.stickToBottom = atBottom;
    this.showScrollDown = !atBottom;
    if (el.scrollTop <= WINDOW_EXPAND_AT && this.windowSize < totalVisible) {
      this.windowSize = Math.min(
        totalVisible,
        this.windowSize + WINDOW_STEP,
        WINDOW_MAX
      );
    }
  }

  /**
   * 切到钉底并隐藏浮动按钮（新会话 / 切换会话 / 发送新消息时调用）。
   * 窗口化渲染：换会话 = 换消息集，窗口重置回初始值（旧会话的扩容不带入）。
   */
  resetToBottom(): void {
    this.stickToBottom = true;
    this.showScrollDown = false;
    this.windowSize = WINDOW_INITIAL;
  }

  /** 点击浮动按钮：平滑滚回底部并重新开启钉底跟随。 */
  scrollToBottomSmooth(): void {
    const el = this.scrollEl;
    if (!el) return;
    this.stickToBottom = true;
    this.showScrollDown = false;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }
}

/** 模块级单例：chat.svelte 全文件共用同一滚动状态。 */
export const chatScroll = new ChatScrollStore();

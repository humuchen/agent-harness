/**
 * chat.ts 滚动簇抽离（Phase 4）。
 *
 * 把消息区滚动跟随逻辑（钉底状态、浮动「回到底部」按钮显隐、平滑回底、
 * 深度思考区流式钉底）收进一个轻量控制器 `ChatScroll`，由 AhChat 持有为
 * `this.scrollCtl`。原 @state stickToBottom / showScrollDown 迁移到控制器内部，
 * 通过 host.requestUpdate() 驱动重渲染（与原 @state 行为一致）；scrollRef 也归
 * 控制器所有。AhChat 仅通过 `this.scrollCtl.xxx()` 调用，零 this.* 泄漏到组件状态层。
 */
import { createRef, type Ref } from 'lit/directives/ref.js';

/** 控制器所需的宿主能力：addController 注册生命周期、requestUpdate 触发重渲染、
 *  renderRoot 供「深度思考区钉底」查询 DOM。与 LitElement 契约对齐（不依赖 lit 类型）。 */
interface ScrollHost {
  addController(controller: unknown): void;
  requestUpdate(): void;
  readonly renderRoot: HTMLElement | DocumentFragment;
}

/** 距底阈值（px）：容忍亚像素/轻微回弹，认为已到底部则隐藏按钮、恢复跟随。 */
const AT_BOTTOM_THRESHOLD = 24;

export class ChatScroll {
  /** 消息区滚动容器引用（渲染模板中经 ref() 绑定）。 */
  readonly scrollRef: Ref<HTMLElement> = createRef<HTMLElement>();
  /** 是否处于「钉底」跟随状态：true 时新消息/更新自动滚到底部。 */
  stickToBottom = true;
  /** 浮动「回到底部」按钮是否可见（未钉底时显示）。 */
  showScrollDown = false;

  private host: ScrollHost;

  constructor(host: ScrollHost) {
    this.host = host;
    host.addController(this);
  }

  /** 切到钉底并隐藏浮动按钮（新会话 / 切换会话 / 发送新消息时调用）。 */
  resetToBottom() {
    this.stickToBottom = true;
    this.showScrollDown = false;
    this.host.requestUpdate();
  }

  /** 仅当处于钉底状态才把消息区滚到底部（updated() 中调用，不触发状态变更）。 */
  scrollToBottom() {
    const el = this.scrollRef.value;
    if (el && this.stickToBottom) el.scrollTop = el.scrollHeight;
  }

  /** 消息区滚动监听：计算距底距离，更新钉底状态与浮动按钮显隐。 */
  onScroll() {
    const el = this.scrollRef.value;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBottom = distance <= AT_BOTTOM_THRESHOLD;
    if (this.stickToBottom !== atBottom || this.showScrollDown === atBottom) {
      this.stickToBottom = atBottom;
      this.showScrollDown = !atBottom;
      this.host.requestUpdate();
    }
  }

  /** 点击浮动按钮：平滑滚回底部并重新开启钉底跟随。 */
  scrollToBottomSmooth() {
    const el = this.scrollRef.value;
    if (!el) return;
    this.stickToBottom = true;
    this.showScrollDown = false;
    this.host.requestUpdate();
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }

  /**
   * 深度思考区流式（打字机）输出时，若内容已撑满上限，始终将视口钉在底部，
   * 保证最新推理「从下往上」逐字可见。只在思考区处于 live（流式、未折叠）时生效，
   * 思考结束后不再抢滚动，方便用户自由回看上面的推理文本。
   */
  scrollThinkToBottom() {
    requestAnimationFrame(() => {
      const tb = this.host.renderRoot.querySelector(
        '.think.live .think-body'
      ) as HTMLElement | null;
      // 折叠时不跟随滚动（用户主动隐藏），展开时才自动滚到底
      if (tb && !tb.closest('.think.collapsed')) tb.scrollTop = tb.scrollHeight;
    });
  }
}

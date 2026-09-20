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
  // 思考区内滚动的「钉底」状态不再用共享布尔，而是挂在每个滚动容器自身
  // （dataset.thinkStick）：深度思考面板与计划思考面板（P5）各自维护独立状态，
  // 互不干扰。避免「某类面板不存在时把共享 thinkStick 误重置为 true」导致另一
  // 面板被强制回底、把用户的滚轮操作"吃掉"。

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
   * 深度思考区流式（打字机）输出时，若内容已撑满上限，将视口钉在底部，
   * 保证最新推理「从下往上」逐字可见。只在思考区处于 live（流式、未折叠）时生效，
   * 思考结束后不再抢滚动，方便用户自由回看上面的推理文本。
   *
   * 仅当用户没有主动向上滚动（thinkStick）时才钉底：用户滚离底部后暂停跟随，
   * 滚回底部自动恢复 —— 否则流式期间每个 token 都强制回底，滚轮等于失效。
   */
  scrollThinkToBottom() {
    requestAnimationFrame(() => {
      // 两类「思考区正文」滚动容器：深度思考面板（普通对话流式）与计划思考面板
      // （P5 静默执行）。二者不会同时 live（计划执行 vs 普通对话流式），但各自维护
      // 独立的钉底状态（dataset.thinkStick），互不干扰——杜绝共享布尔被误重置。
      const targets = [
        this.host.renderRoot.querySelector(
          '.think.live .think-body'
        ) as HTMLElement | null,
        this.host.renderRoot.querySelector(
          '.plan-thinking .pt-think-body'
        ) as HTMLElement | null,
      ].filter(
        (x): x is HTMLElement => !!x && !x.closest('.think.collapsed')
      );
      for (const tb of targets) {
        this.bindThinkScroll(tb);
        if (this.thinkSticks(tb)) tb.scrollTop = tb.scrollHeight;
      }
    });
  }

  /**
   * 用户手动展开某个思考区后调用：把该思考区正文滚到底部，
   * 对齐 live 流式时的「钉底」视角（默认收起偏好下展开旧思考，直接看到推理结尾）。
   * max-height 有 0.25s 过渡，过渡结束后再校准一次，避免停在半途。
   */
  scrollThinkBlockToBottom(msgId: string) {
    requestAnimationFrame(() => {
      const tb = this.host.renderRoot.querySelector(
        `.think[data-mid="${msgId}"] .think-body`
      ) as HTMLElement | null;
      if (!tb || tb.closest('.think.collapsed')) return;
      // 用户主动展开旧思考：钉底对齐结尾（dataset 钉底状态置 true）。
      tb.dataset.thinkStick = '1';
      tb.scrollTop = tb.scrollHeight;
      setTimeout(() => {
        if (tb.isConnected && !tb.closest('.think.collapsed'))
          tb.scrollTop = tb.scrollHeight;
      }, 300);
    });
  }

  /**
   * 给思考区正文绑 scroll 监听（每次重渲染 DOM 重建，按需重绑）：
   * 钉底状态挂在元素自身 dataset.thinkStick（缺省 '1'=钉底）。用户滚离底部 →
   * 置 '0' 暂停跟随；滚回底部 → 置 '1' 恢复。程序回底触发的 scroll 事件距底为 0，
   * 不会误判为用户上滚。
   */
  private bindThinkScroll(tb: HTMLElement) {
    if (tb.dataset.thinkScrollBound === '1') return;
    tb.dataset.thinkScrollBound = '1';
    tb.dataset.thinkStick = '1';
    tb.addEventListener('scroll', () => {
      const distance = tb.scrollHeight - tb.scrollTop - tb.clientHeight;
      tb.dataset.thinkStick = distance <= AT_BOTTOM_THRESHOLD ? '1' : '0';
    });
  }

  /** 该思考区是否处于钉底跟随：dataset.thinkStick 非 '0' 即视为钉底（缺省 true）。 */
  private thinkSticks(tb: HTMLElement): boolean {
    return tb.dataset.thinkStick !== '0';
  }
}

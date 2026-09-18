/**
 * 计划模式（P0）：propose 阶段的「已进行 Xs」实时计时器。
 *
 * 纯轻量原生自定义元素（不引 Lit）：每秒把 textContent 自增刷新，断开连接即停表。
 * 用原生元素而非 Lit 组件的原因：只承担「时间文本自增」一个职责，挂进 ah-chat 的
 * shadow 树后可直接继承宿主样式（.plan-elapsed 控制外观），无需独立 shadow root 与主题接线。
 *
 * 用法：<plan-elapsed ts="1718...."></plan-elapsed>（ts = 消息创建时间戳，毫秒）。
 */
class PlanElapsed extends HTMLElement {
  private timer: ReturnType<typeof setInterval> | null = null;

  static get observedAttributes(): string[] {
    return ['ts'];
  }

  connectedCallback(): void {
    this.render();
    if (!this.timer) {
      this.timer = setInterval(() => this.render(), 1000);
    }
  }

  disconnectedCallback(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  attributeChangedCallback(): void {
    if (this.isConnected) this.render();
  }

  /** 按当前 ts 属性刷新文本；文本未变化时不写 DOM（避免每秒无谓的渲染失效）。 */
  private render(): void {
    const ts = Number(this.getAttribute('ts') ?? 0);
    const sec = ts > 0 ? Math.max(0, Math.round((Date.now() - ts) / 1000)) : 0;
    const text =
      sec >= 60 ? `已进行 ${Math.floor(sec / 60)}m ${sec % 60}s` : `已进行 ${sec}s`;
    if (this.textContent !== text) this.textContent = text;
  }
}

if (!customElements.get('plan-elapsed')) {
  customElements.define('plan-elapsed', PlanElapsed);
}

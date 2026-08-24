/**
 * popup：通用弹层 / 模态（前端应用层「Popup」落地）。
 *
 * @deprecated 全仓无调用点，已由 `components/ah-modal.ts`（<ah-modal>）取代——
 * 后者覆盖变体体系（info/confirm/warning/danger）、尺寸预设、命令式 API、
 * 焦点圈闭环与离场动画。请勿在新代码中引用；本文件仅作历史保留，计划下个迭代删除。
 *
 * 轻量 modal：scrim + 居中面板 + 标题 + 三个命名插槽（header / 默认 / footer）。
 * 支持 Esc 关闭、scrim 点击关闭、`open` 属性反射控制、关闭后派发 `close` 事件。
 * 打开时记录触发焦点元素，关闭后归还焦点（无障碍基础）。零依赖，纯 Lit。
 *
 * 用法：
 *   <ah-popup ?open=${this.show} title="确认" @close=${() => (this.show = false)}>
 *     <p>内容</p>
 *     <div slot="footer"><button @click=${...}>确定</button></div>
 *   </ah-popup>
 */
import { LitElement, html, css, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import type { PropertyValues } from 'lit';

@customElement('ah-popup')
export class AhPopup extends LitElement {
  static styles = css`
    :host {
      display: none;
    }
    :host([open]) {
      display: block;
    }
    .scrim {
      position: fixed;
      inset: 0;
      z-index: 1000;
      background: rgba(0, 0, 0, 0.55);
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .panel {
      width: min(100%, var(--ah-popup-width, 480px));
      max-height: min(80vh, 720px);
      display: flex;
      flex-direction: column;
      background: var(--ah-surface-1);
      color: var(--ah-text);
      border: 1px solid var(--ah-border);
      border-radius: var(--ah-radius-lg);
      box-shadow: var(--ah-shadow);
      overflow: hidden;
      outline: none;
    }
    .head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 14px 18px;
      border-bottom: 1px solid var(--ah-border);
    }
    .title {
      font-family: var(--ah-font-display);
      font-weight: 600;
      font-size: 15px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .close {
      border: none;
      background: none;
      color: var(--ah-text-faint);
      font-size: 18px;
      line-height: 1;
      cursor: pointer;
      padding: 2px 8px;
      border-radius: var(--ah-radius-sm);
    }
    .close:hover {
      color: var(--ah-text);
      background: var(--ah-surface-2);
    }
    .body {
      padding: 16px 18px;
      overflow-y: auto;
      flex: 1 1 auto;
    }
    .foot {
      display: flex;
      justify-content: flex-end;
      gap: 10px;
      padding: 12px 18px;
      border-top: 1px solid var(--ah-border);
    }
  `;

  /** 是否打开（reflect 到属性，方便 :host([open]) 样式控制）。 */
  @property({ type: Boolean, reflect: true })
  open = false;

  /** 弹层标题（可选）。 */
  @property({ type: String })
  title = '';

  /** 面板宽度（CSS 值，如 "520px" / "min(90vw, 640px)"）。 */
  @property({ type: String })
  width = '480px';

  /** 记录打开前的焦点元素，关闭时归还。 */
  private lastFocus: HTMLElement | null = null;

  updated(changed: PropertyValues) {
    if (changed.has('open')) {
      if (this.open) {
        this.lastFocus = document.activeElement as HTMLElement | null;
        // 面板可聚焦，把焦点移入弹层（Esc 才能冒泡到面板的 keydown 监听）
        const panel = this.shadowRoot?.querySelector<HTMLElement>('.panel');
        panel?.focus();
      } else if (this.lastFocus) {
        try {
          this.lastFocus.focus();
        } catch {
          /* 触发元素已被移除等场景忽略 */
        }
        this.lastFocus = null;
      }
    }
  }

  private onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') this.close();
  }

  private close() {
    if (!this.open) return;
    this.open = false;
    this.dispatchEvent(
      new CustomEvent('close', { bubbles: true, composed: true })
    );
  }

  render() {
    if (!this.open) return nothing;
    return html`
      <div class="scrim" @click=${(e: MouseEvent) => {
        // 仅点击 scrim 本身（而非面板内部）才关闭
        if (e.target === e.currentTarget) this.close();
      }}>
        <div
          class="panel"
          style="--ah-popup-width:${this.width}"
          role="dialog"
          aria-modal="true"
          aria-label=${this.title || '弹窗'}
          tabindex="-1"
          @keydown=${this.onKeydown}
        >
          ${this.title || this.hasSlot('header')
            ? html`<div class="head">
                <div class="title">${this.title}</div>
                <slot name="header"></slot>
                <button type="button" class="close" title="关闭" @click=${this.close}>×</button>
              </div>`
            : ''}
          <div class="body"><slot></slot></div>
          <slot name="footer" class="foot"></slot>
        </div>
      </div>
    `;
  }

  /** 检测某命名插槽是否有内容（用于决定是否渲染头部）。 */
  private hasSlot(name: string): boolean {
    return !!this.querySelector(`[slot="${name}"]`);
  }
}

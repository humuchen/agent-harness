/**
 * ah-swipe-item：通用「滑动露出操作」列表项组件。
 * ---------------------------------------------------------------
 * 设计定位（通用约定，后续同类需求直接复用）：
 * 任何列表行想获得「横向滑动露出编辑/删除等操作按钮」的能力，把行包一层
 * <ah-swipe-item id=… group=…>，默认 slot 放行内容、actions slot 放操作按钮
 * 即可。组件封装了全部手势与状态，宿主零状态管理：
 *
 *   <ah-swipe-item group="chat-sessions" id="s-1">
 *     <div class="session-row">…行内容，@click=选择…</div>
 *     <template slot="actions">
 *       <button class="swipe-act" @click=重命名>✎</button>
 *       <button class="swipe-act danger" @click=删除>🗑</button>
 *     </template>
 *
 * 手势规则：
 * - 触屏（pointer:coarse / hover:none）启用：横向拖动露出右侧操作区，
 *   松手按 45% 阈值吸附（展开/回弹）；已展开时点按行内容自动收起；
 *   纵向位移占优则立即交回原生滚动（列表可正常上下滑）。
 * - 鼠标/触屏两用的 hover 设备：操作区默认隐藏（宿主自行用 hover 浮现
 *   等价入口，如本仓会话列表的 .acts），组件不响应横向拖拽，避免
 *   与原生滚轮/拖选冲突。
 *
 * 组排他（同一 group 内同时只允许一个项展开）：
 * 展开某项时，向 `ah:swipe-close` 全局事件广播；同组兄弟项收到后收起。
 * 宿主删除/重排行 DOM 时，被删项在 disconnectedCallback 中自动注销，
 * 无需宿主清理。
 *
 * 事件（宿主订阅，detail 均含 id）：
 * - @ah-swipe-open   手势或属性设置展开后（宿主可据此重置选中态）
 * - @ah-swipe-close  收起后（宿主可据此恢复点击语义：点展开的行=关闭而非选中）
 * - 操作区按钮由宿主在自己的 slot 内容上直接绑 @click 处理业务，
 *   点击时组件已自动收起（见 onSlotActionClick），宿主只需做业务。
 */
import { LitElement, html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { PropertyValues } from 'lit';
import {
  clampSwipeOffset,
  detectSwipeAxis,
  shouldSnapOpen
} from '../utils/swipe-gesture';
import type { SwipeAxisState } from '../utils/swipe-gesture';

/** 全局组排他信号：detail.group 为组名，同组其他 ah-swipe-item 收起自身。 */
const SWIPE_GROUP_CLOSE_EVENT = 'ah:swipe-close';

@customElement('ah-swipe-item')
export class AhSwipeItem extends LitElement {
  static styles = css`
    :host {
      display: block;
      position: relative;
      overflow: hidden;
      /* 圆角继承宿主链（行圆角由父级 .swipe 壳或本 host 承担） */
      border-radius: inherit;
      /* 允许纵向滚动穿透、拦截横向拖动给手势处理 */
      touch-action: pan-y;
      -webkit-touch-callout: none;
    }
    /* 操作区：贴右侧、整行高；内容左移后自然「露出」。
       按钮区宽由内容决定（actions slot 两个按钮通常 56+56=112px 起）。 */
    .bg {
      position: absolute;
      top: 0;
      right: 0;
      bottom: 0;
      z-index: 0;
      display: flex;
      align-items: stretch;
      pointer-events: none; /* 仅展开（内容让出该区域）时才可点 */
    }
    :host([open]) .bg {
      pointer-events: auto;
    }
    .content {
      position: relative;
      z-index: 1;
      display: block;
      transition: transform 0.22s cubic-bezier(0.2, 0.8, 0.3, 1);
      will-change: transform;
      /* 内容自带底色盖住操作区；宿主行背景色在内容元素上声明 */
    }
    .content.dragging {
      transition: none;
    }
    .swipe-act {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      min-width: 56px;
      padding: 0 12px;
      border: none;
      border-radius: 0;
      background: var(--ah-surface-2);
      color: var(--ah-text);
      font: inherit;
      font-size: 13px;
      cursor: pointer;
      user-select: none;
    }
    .swipe-act.danger {
      background: var(--ah-danger-soft, var(--ah-surface-2));
      color: var(--ah-danger);
    }
    /* hover 设备：隐藏滑动操作区（宿主自带 hover 按钮入口，见 ah-swipe-item 文件头） */
    @media (hover: hover) and (pointer: fine) {
      .bg {
        display: none;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .content {
        transition: none;
      }
    }
  `;

  /** 行 id（宿主事件 detail 与组排他注销用；由宿主传入，组件不自造）。 */
  @property({ type: String })
  id = '';

  /** 组名：同组同时仅一个展开。缺省 'default'。 */
  @property({ type: String })
  group = 'default';

  /** 展开态（宿主可命令式设置，如「长按呼出编辑模式」；手势也会写它）。 */
  @property({ type: Boolean, reflect: true })
  open = false;

  @state()
  private dragging = false;

  /** 操作区量测宽度（px）：位移上限与吸附都基于它。0=未量测。 */
  private maxOffset = 0;

  /** 手势（触屏拖动期间非空；非响应式，直接驱动 DOM，保证跟手无重渲染滞后）。 */
  private gesture:
    | (SwipeAxisState & {
        swiped: boolean;
      })
    | null = null;
  /** tap-close / 滑动收尾后抑制紧随其后的 click（避免点按已展开行误触「选中会话」）。 */
  private suppressNextClick = false;

  connectedCallback() {
    super.connectedCallback();
    // 订阅全局组排他信号：同组其他项展开时收起自己。
    window.addEventListener(SWIPE_GROUP_CLOSE_EVENT, this.onGroupClose);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener(SWIPE_GROUP_CLOSE_EVENT, this.onGroupClose);
  }

  private onGroupClose = (e: Event) => {
    const group = (e as CustomEvent<{ group: string; id?: string }>).detail?.group;
    if (group !== this.group || this.id === ((e as CustomEvent).detail?.id ?? undefined))
      return;
    if (this.open) this.close();
  };

  updated(changed: PropertyValues) {
    if (changed.has('open')) {
      if (this.open) this.setMaxOffset();
      this.applyTransform();
      // 展开广播：同组兄弟收起（自身在广播里按 id 豁免）。
      if (this.open) {
        window.dispatchEvent(
          new CustomEvent(SWIPE_GROUP_CLOSE_EVENT, {
            detail: { group: this.group, id: this.id }
          })
        );
      }
      this.dispatchEvent(
        new CustomEvent(this.open ? 'ah-swipe-open' : 'ah-swipe-close', {
          bubbles: true,
          composed: true,
          detail: { id: this.id, group: this.group }
        })
      );
    }
  }

  /** 量测操作区宽度（slot 内容由宿主投影，需等渲染完成后量测）。 */
  private setMaxOffset() {
    const bg = this.renderRoot?.querySelector<HTMLElement>('.bg');
    if (!bg) return;
    const w = bg.scrollWidth;
    if (w > 0) this.maxOffset = w;
  }

  private get contentEl(): HTMLElement | null {
    return this.renderRoot?.querySelector<HTMLElement>('.content') ?? null;
  }

  /** 位移上限：操作区实测宽（未量测到默认 128px），与吸附/变换全链路同源。 */
  private cap(): number {
    return this.maxOffset > 0 ? this.maxOffset : 128;
  }

  private applyTransform() {
    const el = this.contentEl;
    if (!el) return;
    el.style.transform = this.open ? `translateX(-${this.cap()}px)` : '';
  }

  /** 命令式收起（宿主 / 组排他 / 路由切换均走这里）。 */
  close() {
    if (!this.open) return;
    this.open = false;
  }

  /** 展开态点按内容=自动收起（tap-close，移动端惯例；并抑制本次 click 防穿透选中）。 */
  private onClick = () => {
    if (this.suppressNextClick) {
      this.suppressNextClick = false;
      return;
    }
    if (this.open) {
      this.open = false;
      this.suppressNextClick = true;
    }
  };

  /** 触屏手势起点（主指；点在操作区上时不启动内容拖动）。 */
  private onTouchStart = (e: TouchEvent) => {
    if (this.gesture || e.touches.length !== 1) return;
    const t = e.touches[0];
    if (!t) return;
    if ((e.target as HTMLElement).closest?.('.bg')) return;
    this.gesture = { axis: 'none', x0: t.clientX, y0: t.clientY, swiped: false };
    if (this.open) this.setMaxOffset();
  };

  private onTouchMove = (e: TouchEvent) => {
    const g = this.gesture;
    if (!g) return;
    const t = e.touches[0];
    if (!t) return;
    const next = detectSwipeAxis(g, t.clientX, t.clientY);
    if (next === 'h' && g.axis !== 'h') {
      // 判定为横向手势：内容跟手（dragging 类关掉过渡，避免 0.22s 滞后）。
      this.dragging = true;
      this.contentEl?.classList.add('dragging');
    }
    g.axis = next;
    if (g.axis !== 'h') return; // 纵向占优：交回原生滚动（host touch-action: pan-y）
    g.swiped = g.swiped || Math.abs(t.clientX - g.x0) > 8;
    const cap = this.cap();
    // 左滑（dx<0）露出右侧操作区：内容跟随指尖左移（translateX 负值），
    // 从起点位移（open=-cap / closed=0）出发叠加 dx，钳制在 [-cap, 0]。
    const shift = this.open ? -cap : 0;
    const dx = t.clientX - g.x0;
    const translate = clampSwipeOffset(shift + dx, -cap, 0);
    const el = this.contentEl;
    if (el) el.style.transform = `translateX(${translate}px)`;
    // 暂存最后一次的「已露出量」（-translate，>=0），松手吸附用。
    this.lastOffset = -translate;
  };

  /** 手势结束时的最终露出量（松手吸附输入）。 */
  private lastOffset = 0;

  /** 松手：按 45% 阈值吸附展开/回弹。 */
  private onTouchEnd = () => {
    const g = this.gesture;
    if (!g) return;
    this.gesture = null;
    this.contentEl?.classList.remove('dragging');
    this.dragging = false;
    const snappedOpen = shouldSnapOpen(this.lastOffset, this.cap());
    this.suppressNextClick = g.swiped || snappedOpen;
    if (snappedOpen !== this.open) this.open = snappedOpen;
    else this.applyTransform();
  };

  /** 手势取消（系统手势接管 / 第二指落下）：按当前位移就近吸附。 */
  private onTouchCancel = () => {
    if (!this.gesture) return;
    this.gesture = null;
    this.contentEl?.classList.remove('dragging');
    this.dragging = false;
    const snappedOpen = shouldSnapOpen(this.lastOffset, this.cap());
    if (snappedOpen !== this.open) this.open = snappedOpen;
    else this.applyTransform();
  };

  /**
   * 操作区点击兜底：宿主 slot 按钮自行处理业务（按钮 @click 会随宿主事件冒泡到这里），
   * 点击后自动收起，保证「操作完立即还原行」的一致体验。
   */
  private onSlotActionClick = () => {
    if (this.open) this.open = false;
  };

  render() {
    return html`
      <div class="inner">
        <div class="bg" aria-hidden="true" @click=${this.onSlotActionClick}>
          <slot name="actions"></slot>
        </div>
        <div
          class="content ${this.dragging ? 'dragging' : ''}"
          @click=${this.onClick}
          @touchstart=${this.onTouchStart}
          @touchmove=${this.onTouchMove}
          @touchend=${this.onTouchEnd}
          @touchcancel=${this.onTouchCancel}
        >
          <slot></slot>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'ah-swipe-item': AhSwipeItem;
  }
}

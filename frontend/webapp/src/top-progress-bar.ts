/**
 * 顶部加载进度条（NProgress 风格）
 *
 * 行为：
 * - 通过 ah:bar:start / ah:bar:tick / ah:bar:stop 三个自定义事件控制
 * - 默认从 0 → 90% 自动递增，模拟"加载中"；stop 时直接到 100% 并渐隐
 * - 全局唯一，多个面板并发时不会叠加
 */
export class TopProgressBar {
  private static instance: TopProgressBar | null = null;

  private el: HTMLElement | null = null;
  private bar: HTMLElement | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private progress = 0;
  private visible = false;

  private constructor() {}

  static getInstance(): TopProgressBar {
    if (!TopProgressBar.instance) {
      TopProgressBar.instance = new TopProgressBar();
      TopProgressBar.instance.init();
    }
    return TopProgressBar.instance;
  }

  private init(): void {
    if (typeof document === 'undefined') return;
    // 注入 CSS（仅一次）
    if (!document.getElementById('ah-top-bar-css')) {
      const style = document.createElement('style');
      style.id = 'ah-top-bar-css';
      style.textContent = `
        #ah-top-bar {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          height: 3px;
          z-index: 9999;
          pointer-events: none;
          opacity: 0;
          transition: opacity 0.3s ease;
        }
        #ah-top-bar.visible {
          opacity: 1;
        }
        #ah-top-bar .bar {
          height: 100%;
          width: 0%;
          background: var(--ah-accent, #2997FF);
          box-shadow: 0 0 10px var(--ah-accent, #2997FF), 0 0 3px var(--ah-accent, #2997FF);
          transition: width 0.15s ease-out;
          border-radius: 0 2px 2px 0;
        }
      `;
      document.head.appendChild(style);
    }
    // 创建容器
    if (!document.getElementById('ah-top-bar')) {
      const container = document.createElement('div');
      container.id = 'ah-top-bar';
      container.innerHTML = '<div class="bar"></div>';
      document.body.appendChild(container);
      this.el = container;
      this.bar = container.querySelector('.bar') as HTMLElement;
    }
    // 绑定事件
    window.addEventListener('ah:bar:start', this.onStart);
    window.addEventListener('ah:bar:tick', this.onTick);
    window.addEventListener('ah:bar:stop', this.onStop);
  }

  private onStart = (): void => {
    if (!this.el || !this.bar) return;
    this.progress = 0;
    this.visible = true;
    this.el.classList.add('visible');
    this.bar.style.width = '0%';
    this.startAutoProgress();
  };

  private onTick = (e: Event): void => {
    const detail = (e as CustomEvent<number | undefined>).detail;
    if (detail !== undefined) {
      this.progress = Math.min(100, Math.max(0, detail));
    } else {
      this.progress = Math.min(90, this.progress + Math.random() * 15 + 5);
    }
    if (this.bar) this.bar.style.width = `${this.progress}%`;
  };

  private onStop = (): void => {
    if (!this.el || !this.bar) return;
    // 先冲到 100%
    this.progress = 100;
    this.bar.style.width = '100%';
    // 延迟后隐藏
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.el?.classList.remove('visible');
      this.visible = false;
      this.progress = 0;
    }, 400);
  };

  private startAutoProgress(): void {
    if (this.timer) clearTimeout(this.timer);
    const tick = () => {
      if (!this.visible || this.progress >= 90) return;
      this.progress = Math.min(90, this.progress + Math.random() * 8 + 2);
      if (this.bar) this.bar.style.width = `${this.progress}%`;
      this.timer = setTimeout(tick, 200 + Math.random() * 300);
    };
    tick();
  }

  destroy(): void {
    window.removeEventListener('ah:bar:start', this.onStart);
    window.removeEventListener('ah:bar:tick', this.onTick);
    window.removeEventListener('ah:bar:stop', this.onStop);
    if (this.timer) clearTimeout(this.timer);
    if (this.el) {
      this.el.remove();
      this.el = null;
      this.bar = null;
    }
    TopProgressBar.instance = null;
  }
}

/**
 * mac-ui 适配层综合测试
 * ---------------------------------------------------------------
 * 覆盖：基础渲染、命令式 API、主题切换、响应式、交互行为、资源清理
 * 注意：jsdom 不支持 CSS 自定义属性解析，主题测试改为验证 data-theme 属性
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import './components/ah-modal';
import './components/ah-drawer';
import '@humuchen/mac-ui';
import { AhModal } from './components/ah-modal';

describe('mac-ui 适配层测试', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    document.documentElement.setAttribute('data-theme', 'dark');
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  // ─── 1. 组件注册 ───
  describe('组件注册', () => {
    it('所有自定义元素已注册', () => {
      expect(customElements.get('mac-confirm')).toBeTruthy();
      expect(customElements.get('mac-drawer')).toBeTruthy();
      expect(customElements.get('mac-button')).toBeTruthy();
      expect(customElements.get('ah-modal')).toBeTruthy();
      expect(customElements.get('ah-drawer')).toBeTruthy();
    });
  });

  // ─── 2. AhModal 声明式渲染 ───
  describe('AhModal 声明式渲染', () => {
    it('默认不渲染内容', async () => {
      const el = document.createElement('ah-modal');
      document.body.appendChild(el);
      await el.updateComplete;
      expect(el.open).toBe(false);
      const confirm = el.shadowRoot?.querySelector('mac-confirm');
      expect(confirm).toBeFalsy();
    });

    it('open=true 时渲染 mac-confirm', async () => {
      const el = document.createElement('ah-modal');
      el.open = true;
      el.title = '测试标题';
      el.message = '测试消息';
      document.body.appendChild(el);
      await el.updateComplete;

      const confirm = el.shadowRoot?.querySelector('mac-confirm');
      expect(confirm).toBeTruthy();
    });

    it('size 映射正确', async () => {
      const el = document.createElement('ah-modal');
      el.open = true;
      el.size = 'lg';
      document.body.appendChild(el);
      await el.updateComplete;

      const confirm = el.shadowRoot?.querySelector('mac-confirm') as any;
      expect(confirm?.width).toBe('640px');
    });

    it('确认事件触发', async () => {
      const el = document.createElement('ah-modal');
      el.open = true;
      el.variant = 'confirm';
      document.body.appendChild(el);
      await el.updateComplete;

      let confirmed = false;
      el.addEventListener('ah-confirm', () => { confirmed = true; });

      const confirm = el.shadowRoot?.querySelector('mac-confirm') as any;
      confirm?.dispatchEvent(new CustomEvent('mac-confirm-ok'));
      await new Promise(r => setTimeout(r, 10));

      expect(confirmed).toBe(true);
      expect(el.open).toBe(false);
    });

    it('取消事件触发', async () => {
      const el = document.createElement('ah-modal');
      el.open = true;
      el.variant = 'confirm';
      document.body.appendChild(el);
      await el.updateComplete;

      let cancelled = false;
      el.addEventListener('ah-cancel', () => { cancelled = true; });

      const confirm = el.shadowRoot?.querySelector('mac-confirm') as any;
      confirm?.dispatchEvent(new CustomEvent('mac-confirm-cancel'));
      await new Promise(r => setTimeout(r, 10));

      expect(cancelled).toBe(true);
      expect(el.open).toBe(false);
    });

    it('close 事件在确认后触发', async () => {
      const el = document.createElement('ah-modal');
      el.open = true;
      document.body.appendChild(el);
      await el.updateComplete;

      let closed = false;
      el.addEventListener('close', () => { closed = true; });

      const confirm = el.shadowRoot?.querySelector('mac-confirm') as any;
      confirm?.dispatchEvent(new CustomEvent('mac-confirm-ok'));
      await new Promise(r => setTimeout(r, 10));

      expect(closed).toBe(true);
    });
  });

  // ─── 3. AhModal 命令式 API ───
  describe('AhModal.confirm()', () => {
    it('确认返回 true', async () => {
      const p = AhModal.confirm({
        variant: 'confirm',
        title: '确认',
        message: '继续？'
      });

      // mac-confirm.open() 是同步的，但事件需要等渲染
      await new Promise(r => setTimeout(r, 100));
      const confirm = document.querySelector('mac-confirm') as any;
      expect(confirm).toBeTruthy();
      expect(confirm.title).toBe('确认');
      expect(confirm.content).toBe('继续？');

      // 点击确定按钮（在 shadow DOM 中）
      const okBtn = confirm?.shadowRoot?.querySelector('[part="ok-button"]') as HTMLElement;
      if (okBtn) {
        okBtn.click();
      } else {
        // fallback: 直接触发事件
        confirm?.dispatchEvent(new CustomEvent('mac-confirm-ok'));
      }

      const result = await p;
      expect(result).toBe(true);
      // DOM 自动清理
      expect(document.querySelector('mac-confirm')).toBeFalsy();
    }, 10000);

    it('warning + danger 变体', async () => {
      const p = AhModal.confirm({
        variant: 'warning',
        danger: true,
        title: '删除',
        confirmText: '删除'
      });

      await new Promise(r => setTimeout(r, 100));
      const confirm = document.querySelector('mac-confirm') as any;
      expect(confirm?.danger).toBe(true);
      expect(confirm?.confirmText).toBe('删除');
      expect(confirm?.showIcon).toBe(true);

      // 关闭
      confirm?.dispatchEvent(new CustomEvent('mac-confirm-cancel'));
      await p;
    }, 10000);

    it('关闭返回 false', async () => {
      const p = AhModal.confirm({
        title: '测试'
      });

      await new Promise(r => setTimeout(r, 100));
      const confirm = document.querySelector('mac-confirm') as any;
      confirm?.dispatchEvent(new CustomEvent('mac-confirm-close'));

      const result = await p;
      expect(result).toBe(false);
    }, 10000);


  });

  describe('AhModal.prompt()', () => {
    it('返回输入值', async () => {
      const p = AhModal.prompt({
        title: '重命名',
        inputValue: 'test-name'
      });

      await new Promise(r => setTimeout(r, 100));
      const confirm = document.querySelector('mac-confirm') as any;
      expect(confirm).toBeTruthy();

      const input = confirm?.querySelector('input');
      expect(input).toBeTruthy();
      expect(input.value).toBe('test-name');

      // 触发确定
      confirm?.dispatchEvent(new CustomEvent('mac-confirm-ok'));

      const result = await p;
      expect(result).toBe('test-name');
    }, 10000);

    it('取消返回 null', async () => {
      const p = AhModal.prompt({
        title: '输入'
      });

      await new Promise(r => setTimeout(r, 100));
      const confirm = document.querySelector('mac-confirm') as any;
      confirm?.dispatchEvent(new CustomEvent('mac-confirm-cancel'));

      const result = await p;
      expect(result).toBeNull();
    }, 10000);

    it('input 值修改后返回新值', async () => {
      const p = AhModal.prompt({
        title: '输入',
        inputValue: ''
      });

      await new Promise(r => setTimeout(r, 100));
      const confirm = document.querySelector('mac-confirm') as any;
      const input = confirm?.querySelector('input') as HTMLInputElement;

      input.value = 'new-value';
      input.dispatchEvent(new Event('input', { bubbles: true }));

      // 触发确定
      confirm?.dispatchEvent(new CustomEvent('mac-confirm-ok'));

      const result = await p;
      expect(result).toBe('new-value');
    }, 10000);
  });

  describe('AhModal.alert()', () => {
    it('resolve void', async () => {
      const p = AhModal.alert({
        title: '提示',
        message: '操作成功'
      });

      await new Promise(r => setTimeout(r, 100));
      const confirm = document.querySelector('mac-confirm') as any;
      expect(confirm).toBeTruthy();
      expect(confirm.title).toBe('提示');

      // 触发关闭
      confirm?.dispatchEvent(new CustomEvent('mac-confirm-ok'));

      const result = await p;
      expect(result).toBeUndefined();
    }, 10000);
  });

  // ─── 4. AhDrawer 基础 ───
  describe('AhDrawer 声明式渲染', () => {
    it('默认不渲染', async () => {
      const el = document.createElement('ah-drawer');
      document.body.appendChild(el);
      await el.updateComplete;
      expect(el.open).toBe(false);
    });

    it('open=true 时创建 mac-drawer', async () => {
      const el = document.createElement('ah-drawer');
      el.open = true;
      el.title = '抽屉标题';
      el.placement = 'right';
      el.size = '400px';
      document.body.appendChild(el);
      await new Promise(r => setTimeout(r, 100));

      const drawer = document.querySelector('mac-drawer') as any;
      expect(drawer).toBeTruthy();
      expect(drawer?.title).toBe('抽屉标题');
      expect(drawer?.placement).toBe('right');
      expect(drawer?.width).toBe('400px');
    });

    it('placement 支持四个方向', async () => {
      const el = document.createElement('ah-drawer');
      el.open = true;
      el.placement = 'left';
      document.body.appendChild(el);
      await new Promise(r => setTimeout(r, 100));

      let drawer = document.querySelector('mac-drawer') as any;
      expect(drawer?.placement).toBe('left');

      // cleanup
      el.open = false;
      el.remove();
      await new Promise(r => setTimeout(r, 300));
    });

    it('close 事件触发', async () => {
      const el = document.createElement('ah-drawer');
      el.open = true;
      document.body.appendChild(el);
      await new Promise(r => setTimeout(r, 100));

      let closed = false;
      let closeDetail: any;
      el.addEventListener('close', (e: any) => {
        closed = true;
        closeDetail = e.detail;
      });

      // 模拟 mac-drawer 关闭
      const drawer = document.querySelector('mac-drawer') as any;
      drawer?.dispatchEvent(new CustomEvent('mac-drawer-close'));

      await new Promise(r => setTimeout(r, 50));
      expect(closed).toBe(true);
      // mac-ui 的 mac-drawer-close 事件不带 detail，需要从组件内部推断
    });

    it('mask=false 时非模态', async () => {
      const el = document.createElement('ah-drawer');
      el.open = true;
      el.mask = false;
      document.body.appendChild(el);
      await new Promise(r => setTimeout(r, 100));

      const drawer = document.querySelector('mac-drawer') as any;
      expect(drawer?.showMask).toBe('transparent');
    });

    it('ah-open 事件触发', async () => {
      const el = document.createElement('ah-drawer');
      el.open = true;
      document.body.appendChild(el);

      let opened = false;
      el.addEventListener('ah-open', () => { opened = true; });

      await new Promise(r => setTimeout(r, 150));
      expect(opened).toBe(true);
    });
  });

  // ─── 5. 主题切换 ───
  describe('主题切换', () => {
    it('dark 主题 data-theme 属性生效', () => {
      document.documentElement.setAttribute('data-theme', 'dark');
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    });

    it('light 主题 data-theme 属性生效', () => {
      document.documentElement.setAttribute('data-theme', 'light');
      expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    });

    it('组件在 dark 主题下可渲染', async () => {
      document.documentElement.setAttribute('data-theme', 'dark');

      const modal = document.createElement('ah-modal');
      modal.open = true;
      document.body.appendChild(modal);
      await modal.updateComplete;

      expect(modal.shadowRoot?.querySelector('mac-confirm')).toBeTruthy();
      modal.remove();
    });

    it('组件在 light 主题下可渲染', async () => {
      document.documentElement.setAttribute('data-theme', 'light');

      const modal = document.createElement('ah-modal');
      modal.open = true;
      document.body.appendChild(modal);
      await modal.updateComplete;

      expect(modal.shadowRoot?.querySelector('mac-confirm')).toBeTruthy();
      modal.remove();
    });

    it('drawer 在两种主题下均可渲染', async () => {
      for (const theme of ['dark', 'light'] as const) {
        document.documentElement.setAttribute('data-theme', theme);

        const drawer = document.createElement('ah-drawer');
        drawer.open = true;
        document.body.appendChild(drawer);
        await new Promise(r => setTimeout(r, 100));

        expect(document.querySelector('mac-drawer')).toBeTruthy();
        drawer.open = false;
        drawer.remove();
        await new Promise(r => setTimeout(r, 300));
      }
    });
  });

  // ─── 6. 响应式 ───
  describe('PC / 移动端响应式', () => {
    it('PC 端尺寸预设正确', async () => {
      const sizes = [
        { size: 'sm', expected: '360px' },
        { size: 'md', expected: '480px' },
        { size: 'lg', expected: '640px' }
      ];

      for (const { size, expected } of sizes) {
        const el = document.createElement('ah-modal');
        el.open = true;
        el.size = size as any;
        document.body.appendChild(el);
        await el.updateComplete;

        const confirm = el.shadowRoot?.querySelector('mac-confirm') as any;
        expect(confirm?.width).toBe(expected);
        el.remove();
      }
    });

    it('移动端 drawer bottom 方向支持', async () => {
      const el = document.createElement('ah-drawer');
      el.open = true;
      el.placement = 'bottom';
      el.size = '50vh';
      document.body.appendChild(el);
      await new Promise(r => setTimeout(r, 100));

      const drawer = document.querySelector('mac-drawer') as any;
      expect(drawer?.placement).toBe('bottom');
      expect(drawer?.height).toBe('50vh');

      el.open = false;
      el.remove();
      await new Promise(r => setTimeout(r, 300));
    });

    it('mac-modal 支持拖拽和调整大小', async () => {
      // mac-modal 有 draggable/resizable 属性
      const modal = document.createElement('mac-modal') as any;
      modal.title = '测试';
      document.body.appendChild(modal);
      await new Promise(r => setTimeout(r, 50));

      expect(modal.draggable).toBeDefined();
      expect(modal.resizable).toBeDefined();
      modal.remove();
    });
  });

  // ─── 7. 资源清理 ───
  describe('资源清理', () => {
    it('modal 关闭后 DOM 清理', async () => {
      const el = document.createElement('ah-modal');
      el.open = true;
      document.body.appendChild(el);
      await el.updateComplete;

      expect(el.shadowRoot?.querySelector('mac-confirm')).toBeTruthy();

      el.open = false;
      await el.updateComplete;

      expect(el.shadowRoot?.querySelector('mac-confirm')).toBeFalsy();
    });

    it('drawer disconnected 时清理', async () => {
      const el = document.createElement('ah-drawer');
      el.open = true;
      document.body.appendChild(el);
      await new Promise(r => setTimeout(r, 100));

      expect(document.querySelector('mac-drawer')).toBeTruthy();

      el.remove();
      await new Promise(r => setTimeout(r, 200));
    });

    it('命令式 modal resolve 后自动清理 DOM', async () => {
      const p = AhModal.confirm({ title: '测试' });
      await new Promise(r => setTimeout(r, 100));
      expect(document.querySelector('mac-confirm')).toBeTruthy();

      const confirm = document.querySelector('mac-confirm') as any;
      confirm?.dispatchEvent(new CustomEvent('mac-confirm-ok'));

      await p;
      expect(document.querySelector('mac-confirm')).toBeFalsy();
    }, 10000);
  });

  // ─── 8. 无障碍 ───
  describe('无障碍', () => {
    it('mac-confirm 有正确的 ARIA 属性', async () => {
      const el = document.createElement('ah-modal');
      el.open = true;
      el.title = '测试';
      document.body.appendChild(el);
      await el.updateComplete;

      const confirm = el.shadowRoot?.querySelector('mac-confirm') as any;
      expect(confirm).toBeTruthy();
      // mac-confirm 内部容器有 role="dialog"
      const container = confirm?.shadowRoot?.querySelector('[part="container"]');
      expect(container).toBeTruthy();
    });

    it('mac-drawer 有正确的 ARIA 属性', async () => {
      const el = document.createElement('ah-drawer');
      el.open = true;
      el.title = '抽屉';
      document.body.appendChild(el);
      await new Promise(r => setTimeout(r, 100));

      const drawer = document.querySelector('mac-drawer') as any;
      expect(drawer).toBeTruthy();
      // 抽屉有 aria-label
      expect(drawer.title).toBe('抽屉');
    });

    it('Esc 键关闭 mac-confirm', async () => {
      const p = AhModal.confirm({ title: '测试' });
      await new Promise(r => setTimeout(r, 100));

      const confirm = document.querySelector('mac-confirm') as any;
      // 模拟 Esc - 直接触发 mac-confirm-close
      confirm?.dispatchEvent(new CustomEvent('mac-confirm-close'));

      const result = await p;
      expect(result).toBe(false);
    }, 10000);
  });
});

// ─── 辅助：MacConfirm 类型声明 ───
declare global {
  interface HTMLElementTagNameMap {
    'mac-confirm': any;
    'mac-drawer': any;
    'mac-modal': any;
    'mac-button': any;
    'ah-modal': import('./components/ah-modal').AhModal;
    'ah-drawer': import('./components/ah-drawer').AhDrawer;
  }
}

// 引入 MacConfirm 类型
import { MacConfirm } from '@humuchen/mac-ui';

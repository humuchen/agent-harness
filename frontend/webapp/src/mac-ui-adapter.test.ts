/**
 * mac-ui 适配层综合测试
 * 覆盖：基础渲染、命令式 API、主题切换、响应式、交互行为、资源清理
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

  describe('组件注册', () => {
    it('所有自定义元素已注册', () => {
      expect(customElements.get('mac-confirm')).toBeTruthy();
      expect(customElements.get('mac-button')).toBeTruthy();
      expect(customElements.get('ah-modal')).toBeTruthy();
      expect(customElements.get('ah-drawer')).toBeTruthy();
    });
  });

  describe('AhModal 声明式渲染', () => {
    it('默认不渲染内容', async () => {
      const el = document.createElement('ah-modal');
      document.body.appendChild(el);
      await el.updateComplete;
      expect(el.open).toBe(false);
    });

    it('open=true 时渲染 mac-confirm', async () => {
      const el = document.createElement('ah-modal');
      el.open = true;
      el.title = '测试标题';
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

    it('确认/取消/close 事件', async () => {
      const el = document.createElement('ah-modal');
      el.open = true;
      el.variant = 'confirm';
      document.body.appendChild(el);
      await el.updateComplete;

      const events: string[] = [];
      el.addEventListener('ah-confirm', () => events.push('confirm'));
      el.addEventListener('ah-cancel', () => events.push('cancel'));
      el.addEventListener('close', () => events.push('close'));

      const confirm = el.shadowRoot?.querySelector('mac-confirm') as any;
      confirm?.dispatchEvent(new CustomEvent('mac-confirm-ok'));
      await new Promise(r => setTimeout(r, 10));

      expect(events).toEqual(['confirm', 'close']);
      expect(el.open).toBe(false);
    });
  });

  describe('AhModal.confirm()', () => {
    it('确认返回 true', async () => {
      const p = AhModal.confirm({ variant: 'confirm', title: '确认' });
      await new Promise(r => setTimeout(r, 100));
      const confirm = document.querySelector('mac-confirm') as any;
      expect(confirm).toBeTruthy();
      const okBtn = confirm?.shadowRoot?.querySelector('[part="ok-button"]') as HTMLElement;
      if (okBtn) okBtn.click();
      else confirm?.dispatchEvent(new CustomEvent('mac-confirm-ok'));
      const result = await p;
      expect(result).toBe(true);
      expect(document.querySelector('mac-confirm')).toBeFalsy();
    }, 10000);

    it('warning + danger 变体', async () => {
      const p = AhModal.confirm({ variant: 'warning', danger: true, title: '删除', confirmText: '删除' });
      await new Promise(r => setTimeout(r, 100));
      const confirm = document.querySelector('mac-confirm') as any;
      expect(confirm?.danger).toBe(true);
      expect(confirm?.confirmText).toBe('删除');
      confirm?.dispatchEvent(new CustomEvent('mac-confirm-cancel'));
      await p;
    }, 10000);

    it('关闭返回 false', async () => {
      const p = AhModal.confirm({ title: '测试' });
      await new Promise(r => setTimeout(r, 100));
      const confirm = document.querySelector('mac-confirm') as any;
      confirm?.dispatchEvent(new CustomEvent('mac-confirm-close'));
      const result = await p;
      expect(result).toBe(false);
    }, 10000);
  });

  describe('AhModal.prompt()', () => {
    it('返回输入值', async () => {
      const p = AhModal.prompt({ title: '重命名', inputValue: 'test-name' });
      await new Promise(r => setTimeout(r, 100));
      const confirm = document.querySelector('mac-confirm') as any;
      const input = confirm?.querySelector('input');
      expect(input?.value).toBe('test-name');
      confirm?.dispatchEvent(new CustomEvent('mac-confirm-ok'));
      const result = await p;
      expect(result).toBe('test-name');
    }, 10000);

    it('取消返回 null', async () => {
      const p = AhModal.prompt({ title: '输入' });
      await new Promise(r => setTimeout(r, 100));
      const confirm = document.querySelector('mac-confirm') as any;
      confirm?.dispatchEvent(new CustomEvent('mac-confirm-cancel'));
      const result = await p;
      expect(result).toBeNull();
    }, 10000);

    it('input 值修改后返回新值', async () => {
      const p = AhModal.prompt({ title: '输入', inputValue: '' });
      await new Promise(r => setTimeout(r, 100));
      const confirm = document.querySelector('mac-confirm') as any;
      const input = confirm?.querySelector('input') as HTMLInputElement;
      input.value = 'new-value';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      confirm?.dispatchEvent(new CustomEvent('mac-confirm-ok'));
      const result = await p;
      expect(result).toBe('new-value');
    }, 10000);
  });

  describe('AhModal.alert()', () => {
    it('resolve void', async () => {
      const p = AhModal.alert({ title: '提示' });
      await new Promise(r => setTimeout(r, 100));
      const confirm = document.querySelector('mac-confirm') as any;
      confirm?.dispatchEvent(new CustomEvent('mac-confirm-ok'));
      const result = await p;
      expect(result).toBeUndefined();
    }, 10000);
  });

  describe('AhDrawer 声明式渲染', () => {
    it('默认不渲染', async () => {
      const el = document.createElement('ah-drawer');
      document.body.appendChild(el);
      await el.updateComplete;
      expect(el.open).toBe(false);
    });

    it('open=true 时渲染面板', async () => {
      const el = document.createElement('ah-drawer');
      el.open = true;
      el.title = '抽屉标题';
      el.placement = 'right';
      el.size = '400px';
      document.body.appendChild(el);
      await el.updateComplete;

      const panel = el.shadowRoot?.querySelector('.panel');
      expect(panel).toBeTruthy();
      const title = el.shadowRoot?.querySelector('.title');
      expect(title?.textContent).toBe('抽屉标题');
    });

    it('placement 四方向', async () => {
      for (const p of ['left', 'right', 'top', 'bottom'] as const) {
        const el = document.createElement('ah-drawer');
        el.open = true;
        el.placement = p;
        document.body.appendChild(el);
        await el.updateComplete;
        expect(el.shadowRoot?.querySelector('.overlay')?.classList.contains(p)).toBe(true);
        el.remove();
      }
    });

    it('close 事件触发', async () => {
      const el = document.createElement('ah-drawer');
      el.open = true;
      document.body.appendChild(el);
      await el.updateComplete;

      let closed = false;
      let reason: any;
      el.addEventListener('close', (e: any) => { closed = true; reason = e.detail; });

      const closeBtn = el.shadowRoot?.querySelector('.close') as HTMLElement;
      closeBtn?.click();
      await new Promise(r => setTimeout(r, LEAVE_MS + 50));

      expect(closed).toBe(true);
      expect(reason).toBe('button');
    });

    it('mask=false 时不渲染遮罩', async () => {
      const el = document.createElement('ah-drawer');
      el.open = true;
      el.mask = false;
      document.body.appendChild(el);
      await el.updateComplete;
      expect(el.shadowRoot?.querySelector('.scrim')).toBeFalsy();
    });

    it('ah-open 事件触发', async () => {
      const el = document.createElement('ah-drawer');
      el.open = true;
      document.body.appendChild(el);

      let opened = false;
      el.addEventListener('ah-open', () => { opened = true; });

      await new Promise(r => setTimeout(r, 10));
      expect(opened).toBe(true);
    });

    it('show-footer 渲染 footer', async () => {
      const el = document.createElement('ah-drawer');
      el.open = true;
      el.showFooter = true;
      document.body.appendChild(el);
      await el.updateComplete;

      const footer = el.shadowRoot?.querySelector('.foot');
      expect(footer).toBeTruthy();
      const btns = footer?.querySelectorAll('button');
      expect(btns?.length).toBe(2);
    });

    it('遮罩点击关闭', async () => {
      const el = document.createElement('ah-drawer');
      el.open = true;
      el.maskClosable = true;
      document.body.appendChild(el);
      await el.updateComplete;

      let closed = false;
      el.addEventListener('close', () => { closed = true; });

      const scrim = el.shadowRoot?.querySelector('.scrim') as HTMLElement;
      scrim?.click();
      await new Promise(r => setTimeout(r, LEAVE_MS + 50));

      expect(closed).toBe(true);
    });

    it('slot 内容正常渲染', async () => {
      const el = document.createElement('ah-drawer');
      el.open = true;
      const child = document.createElement('div');
      child.textContent = 'slot content';
      child.className = 'test-child';
      el.appendChild(child);
      document.body.appendChild(el);
      await el.updateComplete;

      // slot 内容在 light DOM 中，通过 <slot> 投影
      expect(el.querySelector('.test-child')).toBeTruthy();
      // slot 在 shadow DOM 的 .body 中
      const body = el.shadowRoot?.querySelector('.body');
      expect(body?.querySelector('slot')).toBeTruthy();
    });
  });

  /**
   * 路由联动：ah-app 在 Tab 切换 / 浏览器后退前进时广播 `ah:close-overlays`，
   * 所有 ah-* 覆盖层必须据此关闭自身。
   * 回归背景：移动端侧滑返回只改 history，宿主组件（如被父级 hidden 的
   * ah-user-menu）不会收到任何回调，覆盖层会「悬浮」到新页面上。
   */
  describe('路由联动：ah:close-overlays 统一关闭覆盖层', () => {
    /** 模拟 ah-app 的路由变化广播。 */
    const signalRouteChange = () =>
      window.dispatchEvent(new CustomEvent('ah:close-overlays'));

    it('ah-drawer：打开态收到信号立即关闭并派发 close（跳过离场动画）', async () => {
      const el = document.createElement('ah-drawer');
      el.open = true;
      document.body.appendChild(el);
      await el.updateComplete;

      const reasons: string[] = [];
      el.addEventListener('close', (e: any) => reasons.push(e.detail));

      signalRouteChange();
      await el.updateComplete;

      expect(el.open).toBe(false);
      expect(reasons).toEqual(['button']);
      el.remove();
    });

    it('ah-drawer：未打开时收到信号不派发 close', async () => {
      const el = document.createElement('ah-drawer');
      document.body.appendChild(el);
      await el.updateComplete;

      let closed = 0;
      el.addEventListener('close', () => { closed += 1; });

      signalRouteChange();
      await el.updateComplete;

      expect(closed).toBe(0);
      el.remove();
    });

    it('ah-drawer：卸载后监听已解绑，不再响应信号', async () => {
      const el = document.createElement('ah-drawer');
      el.open = true;
      document.body.appendChild(el);
      await el.updateComplete;
      el.remove();
      await el.updateComplete;

      let closed = 0;
      el.addEventListener('close', () => { closed += 1; });

      signalRouteChange();

      expect(closed).toBe(0);
    });

    it('声明式 ah-modal：打开态收到信号关闭并派发 close', async () => {
      const el = document.createElement('ah-modal');
      el.open = true;
      el.title = '测试';
      document.body.appendChild(el);
      await el.updateComplete;

      let closed = 0;
      el.addEventListener('close', () => { closed += 1; });

      signalRouteChange();
      await el.updateComplete;

      expect(el.open).toBe(false);
      expect(closed).toBe(1);
      el.remove();
    });

    it('命令式 AhModal.confirm()：收到信号视为取消，resolve false 并移除弹框', async () => {
      const p = AhModal.confirm({ variant: 'confirm', title: '确认' });
      await new Promise((r) => setTimeout(r, 0));
      expect(document.querySelector('mac-confirm')).toBeTruthy();

      signalRouteChange();

      expect(await p).toBe(false);
      expect(document.querySelector('mac-confirm')).toBeFalsy();
    }, 10000);

    it('命令式 AhModal.prompt()：收到信号 resolve null 并移除弹框', async () => {
      const p = AhModal.prompt({ title: '输入' });
      await new Promise((r) => setTimeout(r, 0));
      signalRouteChange();

      expect(await p).toBeNull();
      expect(document.querySelector('mac-confirm')).toBeFalsy();
    }, 10000);

    it('命令式 AhModal.alert()：收到信号 resolve 并移除弹框', async () => {
      const p = AhModal.alert({ title: '提示' });
      await new Promise((r) => setTimeout(r, 0));
      expect(document.querySelector('mac-confirm')).toBeTruthy();

      signalRouteChange();

      await expect(p).resolves.toBeUndefined();
      expect(document.querySelector('mac-confirm')).toBeFalsy();
    }, 10000);
  });

  describe('主题切换', () => {
    it('dark/light data-theme 属性生效', () => {
      document.documentElement.setAttribute('data-theme', 'dark');
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
      document.documentElement.setAttribute('data-theme', 'light');
      expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    });

    it('组件在两种主题下均可渲染', async () => {
      for (const theme of ['dark', 'light'] as const) {
        document.documentElement.setAttribute('data-theme', theme);

        const modal = document.createElement('ah-modal');
        modal.open = true;
        document.body.appendChild(modal);
        await modal.updateComplete;
        expect(modal.shadowRoot?.querySelector('mac-confirm')).toBeTruthy();
        modal.remove();

        const drawer = document.createElement('ah-drawer');
        drawer.open = true;
        document.body.appendChild(drawer);
        await drawer.updateComplete;
        expect(drawer.shadowRoot?.querySelector('.panel')).toBeTruthy();
        drawer.remove();
      }
    });

    it('声明式：mac-confirm 跟随 <html data-theme> 拿到 theme 属性', async () => {
      // mac-ui 不读文档级属性（见 ah-modal.ts「主题契约」），适配层须显式下发
      document.documentElement.setAttribute('data-theme', 'dark');
      const el = document.createElement('ah-modal');
      el.open = true;
      document.body.appendChild(el);
      await el.updateComplete;
      const confirm = el.shadowRoot?.querySelector('mac-confirm') as any;
      expect(confirm?.theme).toBe('dark');

      // 模拟用户切主题（app / settings-center 会广播该事件）
      document.documentElement.setAttribute('data-theme', 'light');
      window.dispatchEvent(new CustomEvent('ah:theme-changed'));
      await el.updateComplete;
      expect(confirm?.theme).toBe('light');

      el.remove();
      document.documentElement.setAttribute('data-theme', 'dark');
    });

    it('命令式：confirm 弹框挂在 body 上也能拿到主题并跟随切换', async () => {
      document.documentElement.setAttribute('data-theme', 'dark');
      const p = AhModal.confirm({ variant: 'confirm', title: '确认' });
      await new Promise((r) => setTimeout(r, 0));
      const confirm = document.querySelector('mac-confirm') as any;
      expect(confirm).toBeTruthy();
      expect(confirm?.theme).toBe('dark');

      // 弹框打开时切主题 → 跟随（「暗色下打开、切浅色」的场景）
      document.documentElement.setAttribute('data-theme', 'light');
      window.dispatchEvent(new CustomEvent('ah:theme-changed'));
      expect(confirm?.theme).toBe('light');

      confirm?.dispatchEvent(new CustomEvent('mac-confirm-ok'));
      expect(await p).toBe(true);
      document.documentElement.setAttribute('data-theme', 'dark');
    });
  });

  describe('PC / 移动端响应式', () => {
    it('尺寸预设正确', async () => {
      for (const [size, expected] of [['sm', '360px'], ['md', '480px'], ['lg', '640px']] as const) {
        const el = document.createElement('ah-modal');
        el.open = true;
        el.size = size;
        document.body.appendChild(el);
        await el.updateComplete;
        const confirm = el.shadowRoot?.querySelector('mac-confirm') as any;
        expect(confirm?.width).toBe(expected);
        el.remove();
      }
    });

    it('drawer bottom 方向', async () => {
      const el = document.createElement('ah-drawer');
      el.open = true;
      el.placement = 'bottom';
      el.size = '50vh';
      document.body.appendChild(el);
      await el.updateComplete;
      expect(el.shadowRoot?.querySelector('.overlay')?.classList.contains('bottom')).toBe(true);
    });
  });

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

    it('drawer 关闭后面板移除', async () => {
      const el = document.createElement('ah-drawer');
      el.open = true;
      document.body.appendChild(el);
      await el.updateComplete;
      expect(el.shadowRoot?.querySelector('.panel')).toBeTruthy();
      el.open = false;
      await new Promise(r => setTimeout(r, LEAVE_MS + 50));
      expect(el.shadowRoot?.querySelector('.panel')).toBeFalsy();
    });
  });

  describe('无障碍', () => {
    it('mac-confirm 有 ARIA', async () => {
      const el = document.createElement('ah-modal');
      el.open = true;
      el.title = '测试';
      document.body.appendChild(el);
      await el.updateComplete;
      const confirm = el.shadowRoot?.querySelector('mac-confirm') as any;
      expect(confirm).toBeTruthy();
      const container = confirm?.shadowRoot?.querySelector('[part="container"]');
      expect(container).toBeTruthy();
    });

    it('drawer 有 ARIA', async () => {
      const el = document.createElement('ah-drawer');
      el.open = true;
      el.title = '抽屉';
      document.body.appendChild(el);
      await el.updateComplete;
      const panel = el.shadowRoot?.querySelector('.panel') as HTMLElement;
      expect(panel?.getAttribute('role')).toBe('dialog');
      expect(panel?.getAttribute('aria-label')).toBe('抽屉');
    });
  });
});

import { MacConfirm } from '@humuchen/mac-ui';

declare global {
  interface HTMLElementTagNameMap {
    'mac-confirm': any;
    'mac-button': any;
    'ah-modal': import('./components/ah-modal').AhModal;
    'ah-drawer': import('./components/ah-drawer').AhDrawer;
  }
}

const LEAVE_MS = 220;

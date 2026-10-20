/**
 * mac-ui 适配层综合测试（Svelte 5 迁移版）
 * 覆盖：基础渲染、命令式 API、主题切换、响应式、交互行为、资源清理
 *
 * 迁移说明：
 *  - mac-ui（MacConfirm/MacButton）仍是自定义元素，相关用例原样保留。
 *  - 声明式 <ah-modal> 已随迁移移除（新版 ah-modal.ts 只有命令式 AhModal API），
 *    相关用例删除；命令式 AhModal.confirm/alert/prompt 用法不变，原样保留。
 *  - ah-drawer 改为 Svelte 组件：用 mount(AhDrawer, {target, props}) 挂载，
 *    close/ah-open 事件改为 onclose / onahOpen 回调断言；无 shadowRoot，直接查 light DOM。
 *  - 原 static styles CSSResult 断言改为读取组件源码（vite ?raw）中的 CSS 文本，
 *    锁定的「移动端头部」CSS 前置条件不变。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount, unmount, tick } from 'svelte';
import type { ComponentProps } from 'svelte';
import '@humuchen/mac-ui';
import { AhModal } from './components/ah-modal';
import AhDrawer from './components/ah-drawer.svelte';
import drawerSource from './components/ah-drawer.svelte?raw';

type DrawerProps = ComponentProps<typeof AhDrawer>;
type DrawerInst = ReturnType<typeof mount<DrawerProps, Record<string, any>>>;
/** 本文件挂载过的组件实例：afterEach 统一卸载（清 window 监听等副作用）。 */
const insts: Record<string, unknown>[] = [];

/** 挂载一个 ah-drawer（target=document.body，light DOM 可直接查询）。 */
function mountDrawer(
  props: Partial<DrawerProps> = {}
): DrawerInst {
  const inst = mount(AhDrawer, {
    target: document.body,
    props: props as DrawerProps
  });
  insts.push(inst as unknown as Record<string, unknown>);
  return inst;
}

describe('mac-ui 适配层测试', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    document.documentElement.setAttribute('data-theme', 'dark');
  });

  afterEach(() => {
    for (const inst of insts) unmount(inst as never);
    insts.length = 0;
    document.body.innerHTML = '';
  });

  describe('组件注册', () => {
    it('所有自定义元素已注册', () => {
      expect(customElements.get('mac-confirm')).toBeTruthy();
      expect(customElements.get('mac-button')).toBeTruthy();
    });
  });

  describe('AhModal.confirm()', () => {
    it('确认返回 true', async () => {
      const p = AhModal.confirm({ variant: 'confirm', title: '确认' });
      await new Promise(r => setTimeout(r, 100));
      const confirm = document.querySelector('mac-confirm') as MacConfirm;
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
      const confirm = document.querySelector('mac-confirm') as MacConfirm;
      expect(confirm?.danger).toBe(true);
      expect(confirm?.confirmText).toBe('删除');
      confirm?.dispatchEvent(new CustomEvent('mac-confirm-cancel'));
      await p;
    }, 10000);

    it('关闭返回 false', async () => {
      const p = AhModal.confirm({ title: '测试' });
      await new Promise(r => setTimeout(r, 100));
      const confirm = document.querySelector('mac-confirm') as MacConfirm;
      confirm?.dispatchEvent(new CustomEvent('mac-confirm-close'));
      const result = await p;
      expect(result).toBe(false);
    }, 10000);
  });

  describe('AhModal.prompt()', () => {
    it('返回输入值', async () => {
      const p = AhModal.prompt({ title: '重命名', inputValue: 'test-name' });
      await new Promise(r => setTimeout(r, 100));
      const confirm = document.querySelector('mac-confirm') as MacConfirm;
      const input = confirm?.querySelector('input');
      expect(input?.value).toBe('test-name');
      confirm?.dispatchEvent(new CustomEvent('mac-confirm-ok'));
      const result = await p;
      expect(result).toBe('test-name');
    }, 10000);

    it('取消返回 null', async () => {
      const p = AhModal.prompt({ title: '输入' });
      await new Promise(r => setTimeout(r, 100));
      const confirm = document.querySelector('mac-confirm') as MacConfirm;
      confirm?.dispatchEvent(new CustomEvent('mac-confirm-cancel'));
      const result = await p;
      expect(result).toBeNull();
    }, 10000);

    it('input 值修改后返回新值', async () => {
      const p = AhModal.prompt({ title: '输入', inputValue: '' });
      await new Promise(r => setTimeout(r, 100));
      const confirm = document.querySelector('mac-confirm') as MacConfirm;
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
      const confirm = document.querySelector('mac-confirm') as MacConfirm;
      confirm?.dispatchEvent(new CustomEvent('mac-confirm-ok'));
      const result = await p;
      expect(result).toBeUndefined();
    }, 10000);
  });

  describe('AhDrawer 渲染', () => {
    it('默认不渲染', async () => {
      mountDrawer();
      await tick();
      expect(document.querySelector('.overlay')).toBeFalsy();
    });

    it('open=true 时渲染面板', async () => {
      mountDrawer({ open: true, title: '抽屉标题', placement: 'right', size: '400px' });
      await tick();
      const panel = document.querySelector('.panel');
      expect(panel).toBeTruthy();
      const title = document.querySelector('.title');
      expect(title?.textContent).toBe('抽屉标题');
    });

    it('placement 四方向', async () => {
      for (const p of ['left', 'right', 'top', 'bottom'] as const) {
        const inst = mountDrawer({ open: true, placement: p });
        await tick();
        expect(document.querySelector('.overlay')?.classList.contains(p)).toBe(true);
        unmount(inst);
        insts.length = 0;
        document.body.innerHTML = '';
      }
    });

    it('close 回调触发', async () => {
      let closed = false;
      let reason: unknown;
      mountDrawer({
        open: true,
        onclose: (r) => {
          closed = true;
          reason = r;
        }
      });
      await tick();

      const closeBtn = document.querySelector('.close') as HTMLElement;
      closeBtn?.click();
      await new Promise(r => setTimeout(r, LEAVE_MS + 50));

      expect(closed).toBe(true);
      expect(reason).toBe('button');
    });

    it('mask=false 时不渲染遮罩', async () => {
      mountDrawer({ open: true, mask: false });
      await tick();
      expect(document.querySelector('.scrim')).toBeFalsy();
    });

    /**
     * 移动端抽屉头部：标题与关闭按钮左右互换，且 × 换成返回箭头。
     *
     * 背景：移动端拇指可达区在屏幕左侧，「返回」又是高频动作，故把关闭键移到左侧
     * 并改用箭头图标（语义从「关闭弹层」转为「返回」）。桌面端保持原样。
     *
     * jsdom 不做布局（无 getComputedStyle 真实解算、媒体查询恒不匹配），
     * 因此这里锁定的是**产生该视觉的前置条件**——CSS 规则与 DOM 结构；
     * 实际像素位置由浏览器端到端验证（390×844 实测 btn.left=16 / title.left=70）。
     * 迁移后组件样式不再经 static styles 暴露，改为断言组件源码中的 CSS 文本（?raw）。
     */
    describe('移动端头部：标题与返回键互换', () => {
      /** 抽出 @media (max-width: 760px), (pointer: coarse) 块内的 .close / .title 规则。 */
      const mobileRules = (css: string, sel: string): string => {
        const at = css.indexOf('@media (max-width: 760px), (pointer: coarse)');
        expect(at, '应存在移动端媒体查询块').toBeGreaterThan(-1);
        const block = css.slice(at);
        const m = new RegExp(`${sel.replace('.', '\\.')}\\s*\\{([^}]*)\\}`).exec(block);
        expect(m, `移动端块内应有 ${sel} 规则`).toBeTruthy();
        return m?.[1] ?? '';
      };

      it('移动端：标题真居中——close 绝对定位，head 用 justify-content:center', () => {
        const css = drawerSource;
        // close 必须脱离文档流，否则 title 居中的是「扣掉按钮后的剩余区域」，
        // 整体偏右约 30px，肉眼可见没居中。
        const close = mobileRules(css, '.close');
        expect(close).toMatch(/position:\s*absolute/);
        expect(close).toMatch(/top:\s*50%/);
        expect(close).toMatch(/transform:\s*translateY\(-50%\)/);
        expect(close).toMatch(/margin-left:\s*0/);

        const head = mobileRules(css, '.head');
        expect(head).toMatch(/position:\s*relative/);
        expect(head).toMatch(/justify-content:\s*center/);

        // 标题左右等量留白，为按钮留出等宽空间（否则长标题会压到按钮下）
        const title = mobileRules(css, '.title');
        expect(title).toMatch(/text-align:\s*center/);
        expect(title).toMatch(/padding:\s*0 48px/);
        expect(title).toMatch(/margin-right:\s*0/);
      });

      it('移动端：返回键触控目标不小于 44px', () => {
        const rule = mobileRules(drawerSource, '.close');
        const h = /min-height:\s*(\d+)px/.exec(rule);
        const w = /min-width:\s*(\d+)px/.exec(rule);
        expect(Number(h?.[1])).toBeGreaterThanOrEqual(44);
        expect(Number(w?.[1])).toBeGreaterThanOrEqual(44);
      });

      it('两枚图标并存、按断点切换（避免 JS 匹配媒体查询导致首帧闪烁）', async () => {
        mountDrawer({ open: true });
        await tick();
        const btn = document.querySelector('.close') as HTMLElement;

        // × 与箭头同时渲染，靠 CSS display 切换
        expect(btn.querySelector('.ico-close')?.textContent?.trim()).toBe('×');
        expect(btn.querySelector('.ico-back svg')).toBeTruthy();
        // 两枚图标均为纯装饰，须对读屏隐藏
        expect(btn.querySelector('.ico-close')?.getAttribute('aria-hidden')).toBe('true');
        expect(btn.querySelector('.ico-back')?.getAttribute('aria-hidden')).toBe('true');

        const css = drawerSource;
        // 默认（桌面）只显示 ×，移动端只显示箭头
        expect(css).toMatch(/\.ico-back\s*\{[^}]*display:\s*none/);
        expect(mobileRules(css, '.ico-back')).toMatch(/display:\s*inline-flex/);
        expect(mobileRules(css, '.ico-close')).toMatch(/display:\s*none/);
      });

      /**
       * 返回图标与 md 预览页（access/server/src/markdown-preview.ts 的 .md-back-ico）
       * 保持一致。两处分属前端组件与服务端字符串模板、无共享代码，故在此把
       * path 钉死；服务端侧由 markdown-preview.test.cjs 钉同一常量。
       */
      it('返回图标 path 固定为 chevron（M15 18l-6-6 6-6），与服务端预览页一致', async () => {
        mountDrawer({ open: true });
        await tick();

        const svg = document.querySelector('.ico-back svg') as SVGElement;
        const path = svg?.querySelector('path')?.getAttribute('d');
        expect(path).toBe('M15 18l-6-6 6-6');
        expect(svg?.getAttribute('viewBox')).toBe('0 0 24 24');
        expect(svg?.getAttribute('stroke')).toBe('currentColor');
        // 描边样式与线宽须与 md-preview 一致，否则同图标粗细/端点不同
        expect(svg?.getAttribute('stroke-width')).toBe('2');
        expect(svg?.getAttribute('stroke-linecap')).toBe('round');
        expect(svg?.getAttribute('stroke-linejoin')).toBe('round');
      });

      it('无障碍名随断点切换：桌面「关闭」/ 移动「返回」', async () => {
        mountDrawer({ open: true });
        await tick();
        const btn = document.querySelector('.close') as HTMLElement;

        // 按钮视觉为纯图标，可访问名由视觉隐藏的文案提供
        expect(btn.querySelector('.lbl-close')?.textContent?.trim()).toBe('关闭');
        expect(btn.querySelector('.lbl-back')?.textContent?.trim()).toBe('返回');
        // 隐藏文案不得撑开布局（须为视觉隐藏写法）
        const css = drawerSource;
        expect(css).toMatch(/\.lbl-close,\s*\.lbl-back\s*\{[^}]*clip-path:\s*inset\(50%\)/);

        const block = mobileRules(css, '.lbl-back');
        expect(block).toMatch(/display:\s*block/);
        expect(mobileRules(css, '.lbl-close')).toMatch(/display:\s*none/);
      });

      it('DOM 顺序不变：close 仍在 title 之后（读屏与 Tab 次序不被打乱）', async () => {
        mountDrawer({ open: true, title: '执行详情' });
        await tick();

        const head = document.querySelector('.head') as HTMLElement;
        // Svelte scoped style 会给元素附加 svelte-xxx 哈希类，用 classList.contains 匹配。
        const kids = Array.from(head.children);
        expect(kids.findIndex((c) => c.classList.contains('title'))).toBeLessThan(
          kids.findIndex((c) => c.classList.contains('close'))
        );
        // 视觉换位靠 CSS order，不靠改 DOM
      });
    });

    it('ah-open 回调触发', async () => {
      let opened = false;
      mountDrawer({ open: true, onahOpen: () => { opened = true; } });
      await tick();
      expect(opened).toBe(true);
    });

    it('show-footer 渲染 footer', async () => {
      mountDrawer({ open: true, showFooter: true });
      await tick();

      const footer = document.querySelector('.foot');
      expect(footer).toBeTruthy();
      const btns = footer?.querySelectorAll('button');
      expect(btns?.length).toBe(2);
    });

    it('遮罩点击关闭', async () => {
      let closed = false;
      mountDrawer({ open: true, maskClosable: true, onclose: () => { closed = true; } });
      await tick();

      const scrim = document.querySelector('.scrim') as HTMLElement;
      scrim?.click();
      await new Promise(r => setTimeout(r, LEAVE_MS + 50));

      expect(closed).toBe(true);
    });

    it('body 插槽内容正常渲染', async () => {
      // 命令式挂载时经 createRawSnippet 提供 children（原 slot 内容）
      const children = createRawSnippet(() => ({
        render: () => '<span class="test-child">slot content</span>'
      }));
      mountDrawer({ open: true, children });
      await tick();

      expect(document.querySelector('.test-child')?.textContent).toBe('slot content');
    });
  });

  /**
   * 路由联动：app 壳在 Tab 切换 / 浏览器后退前进时广播 `ah:close-overlays`，
   * 所有覆盖层必须据此关闭自身。
   * 回归背景：移动端侧滑返回只改 history，宿主组件（如被父级 hidden 的
   * user-menu）不会收到任何回调，覆盖层会「悬浮」到新页面上。
   */
  describe('路由联动：ah:close-overlays 统一关闭覆盖层', () => {
    /** 模拟 app 壳的路由变化广播。 */
    const signalRouteChange = () =>
      window.dispatchEvent(new CustomEvent('ah:close-overlays'));

    it('ah-drawer：打开态收到信号立即关闭并回调 onclose（跳过离场动画）', async () => {
      const reasons: string[] = [];
      mountDrawer({ open: true, onclose: (r) => reasons.push(r) });
      await tick();

      signalRouteChange();
      await tick();

      expect(reasons).toEqual(['button']);
    });

    it('ah-drawer：未打开时收到信号不回调 onclose', async () => {
      let closed = 0;
      mountDrawer({ open: false, onclose: () => { closed += 1; } });
      await tick();

      signalRouteChange();
      await tick();

      expect(closed).toBe(0);
    });

    it('ah-drawer：卸载后监听已解绑，不再响应信号', async () => {
      let closed = 0;
      const inst = mountDrawer({ open: true, onclose: () => { closed += 1; } });
      await tick();
      unmount(inst);
      insts.length = 0;

      signalRouteChange();
      await tick();

      expect(closed).toBe(0);
      expect(document.querySelector('.overlay')).toBeFalsy();
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

        const inst = mountDrawer({ open: true });
        await tick();
        expect(document.querySelector('.panel')).toBeTruthy();
        unmount(inst);
        insts.length = 0;
        document.body.innerHTML = '';
      }
    });

    it('命令式：confirm 弹框挂在 body 上也能拿到主题并跟随切换', async () => {
      document.documentElement.setAttribute('data-theme', 'dark');
      const p = AhModal.confirm({ variant: 'confirm', title: '确认' });
      await new Promise((r) => setTimeout(r, 0));
      const confirm = document.querySelector('mac-confirm') as MacConfirm;
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
    it('命令式 confirm 弹框尺寸预设正确', async () => {
      for (const [size, expected] of [['sm', '360px'], ['md', '480px'], ['lg', '640px']] as const) {
        const p = AhModal.confirm({ variant: 'confirm', title: '尺寸', size });
        await new Promise(r => setTimeout(r, 100));
        const confirm = document.querySelector('mac-confirm') as MacConfirm;
        expect(confirm?.width).toBe(expected);
        confirm?.dispatchEvent(new CustomEvent('mac-confirm-cancel'));
        await p;
      }
    }, 10000);

    it('drawer bottom 方向', async () => {
      mountDrawer({ open: true, placement: 'bottom', size: '50vh' });
      await tick();
      expect(document.querySelector('.overlay')?.classList.contains('bottom')).toBe(true);
    });
  });

  describe('资源清理', () => {
    it('drawer 关闭（卸载）后面板移除', async () => {
      const inst = mountDrawer({ open: true });
      await tick();
      expect(document.querySelector('.panel')).toBeTruthy();
      unmount(inst);
      insts.length = 0;
      await tick();
      expect(document.querySelector('.panel')).toBeFalsy();
    });

    it('命令式 modal 确认后 DOM 清理', async () => {
      const p = AhModal.confirm({ variant: 'confirm', title: '确认' });
      await new Promise(r => setTimeout(r, 100));
      expect(document.querySelector('mac-confirm')).toBeTruthy();
      const confirm = document.querySelector('mac-confirm') as MacConfirm;
      confirm?.dispatchEvent(new CustomEvent('mac-confirm-ok'));
      await p;
      expect(document.querySelector('mac-confirm')).toBeFalsy();
    }, 10000);
  });

  describe('无障碍', () => {
    it('命令式 confirm 弹框内的 mac-confirm 有 ARIA', async () => {
      const p = AhModal.confirm({ variant: 'confirm', title: '测试' });
      await new Promise(r => setTimeout(r, 100));
      const confirm = document.querySelector('mac-confirm') as MacConfirm;
      expect(confirm).toBeTruthy();
      const container = confirm?.shadowRoot?.querySelector('[part="container"]');
      expect(container).toBeTruthy();
      confirm?.dispatchEvent(new CustomEvent('mac-confirm-cancel'));
      await p;
    }, 10000);

    it('drawer 有 ARIA', async () => {
      mountDrawer({ open: true, title: '抽屉' });
      await tick();
      const panel = document.querySelector('.panel') as HTMLElement;
      expect(panel?.getAttribute('role')).toBe('dialog');
      expect(panel?.getAttribute('aria-label')).toBe('抽屉');
    });
  });
});

import { MacConfirm, MacButton } from '@humuchen/mac-ui';
import { createRawSnippet } from 'svelte';

declare global {
  interface HTMLElementTagNameMap {
    'mac-confirm': MacConfirm;
    'mac-button': MacButton;
  }
}

/** ah-drawer 离场动画时长（ms），与组件内实现一致。 */
const LEAVE_MS = 220;

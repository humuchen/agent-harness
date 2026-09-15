/**
 * ah-user-menu 测试（重点覆盖「我的」Tab 的覆盖层与路由联动）。
 *
 * 回归背景（本用例的由来）：移动端在「我的 → 设置」整屏抽屉里侧滑返回时，
 * 只有 history 发生变化、Tab 被切走；面板容器 `.me-view` 只是被父级加上 hidden，
 * ah-user-menu 自身不会收到任何回调，内部 `settingsOpen` 会一直停留在 true。
 * 于是用户切到别的页面后再点「我的」，设置抽屉会「自己冒出来」。
 *
 * 因此约定：ah-app 在 Tab 切换 / 浏览器后退前进时广播 `ah:close-overlays`，
 * 本组件据此把内部覆盖层（设置抽屉 / 改密模态 / 头像下拉）全部归零。
 *
 * 网络层整体 mock：connectedCallback 不注入 username 时会拉 /api/account/me，
 * 此处统一 stub，避免单测真连服务端。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    fetchMe: vi.fn().mockResolvedValue(null),
    logout: vi.fn().mockResolvedValue(undefined)
  };
});

import './user-menu';
import type { AhUserMenu } from './user-menu';

type El = AhUserMenu & { updateComplete: Promise<unknown> };

/** 挂载 standalone（「我的」Tab）形态的组件。 */
async function mountStandalone(): Promise<El> {
  const el = document.createElement('ah-user-menu') as unknown as AhUserMenu;
  el.setAttribute('standalone', '');
  el.username = 'tester';
  el.role = 'admin';
  document.body.appendChild(el);
  await el.updateComplete;
  return el as El;
}

/** 按 .s-lbl 文案取 standalone 条目按钮。 */
function itemByLabel(el: El, label: string): HTMLButtonElement {
  const items = Array.from(
    el.shadowRoot?.querySelectorAll<HTMLButtonElement>('.s-item') ?? []
  );
  const found = items.find(
    (b) => b.querySelector('.s-lbl')?.textContent?.trim() === label
  );
  if (!found) throw new Error(`未找到条目：${label}`);
  return found;
}

/** 模拟 ah-app 的路由变化广播。 */
function signalRouteChange(): void {
  window.dispatchEvent(new CustomEvent('ah:close-overlays'));
}

describe('ah-user-menu（「我的」页覆盖层）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('standalone 默认不渲染设置抽屉与改密模态', async () => {
    const el = await mountStandalone();
    expect(el.shadowRoot?.querySelector('ah-drawer')).toBeFalsy();
    const pw = el.shadowRoot?.querySelector('ah-password-dialog') as
      | (HTMLElement & { open?: boolean })
      | null;
    expect(pw?.open ?? false).toBe(false);
  });

  it('点「设置」打开整屏抽屉，收到 ah:close-overlays 后关闭（回归：侧滑返回残留）', async () => {
    const el = await mountStandalone();

    itemByLabel(el, '设置').click();
    await el.updateComplete;

    const drawer = el.shadowRoot?.querySelector('ah-drawer') as
      | (HTMLElement & { open?: boolean })
      | null;
    expect(drawer).toBeTruthy();
    expect(drawer?.open).toBe(true);

    // 侧滑返回 / 切换 Tab：ah-app 广播全局关闭信号
    signalRouteChange();
    await el.updateComplete;

    expect(el.shadowRoot?.querySelector('ah-drawer')).toBeFalsy();
  });

  it('抽屉打开时再次收到信号幂等（不抛错、不残留）', async () => {
    const el = await mountStandalone();

    itemByLabel(el, '设置').click();
    await el.updateComplete;
    signalRouteChange();
    await el.updateComplete;
    signalRouteChange();
    await el.updateComplete;

    expect(el.shadowRoot?.querySelector('ah-drawer')).toBeFalsy();
  });

  it('改密模态同样受 ah:close-overlays 关闭', async () => {
    const el = await mountStandalone();

    itemByLabel(el, '修改密码').click();
    await el.updateComplete;

    const pw = el.shadowRoot?.querySelector('ah-password-dialog') as
      | (HTMLElement & { open?: boolean })
      | null;
    expect(pw?.open).toBe(true);

    signalRouteChange();
    await el.updateComplete;

    expect(pw?.open).toBe(false);
  });

  it('关闭信号不影响下次正常打开（状态已归零，非一次性锁死）', async () => {
    const el = await mountStandalone();

    itemByLabel(el, '设置').click();
    await el.updateComplete;
    signalRouteChange();
    await el.updateComplete;

    itemByLabel(el, '设置').click();
    await el.updateComplete;

    const drawer = el.shadowRoot?.querySelector('ah-drawer') as
      | (HTMLElement & { open?: boolean })
      | null;
    expect(drawer?.open).toBe(true);
  });
});

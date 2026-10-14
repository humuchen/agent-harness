/**
 * UserMenu 测试（重点覆盖「我的」Tab 的覆盖层与路由联动）—— Svelte 5 迁移版。
 *
 * 回归背景（本用例的由来）：移动端在「我的 → 设置」整屏抽屉里侧滑返回时，
 * 只有 history 发生变化、Tab 被切走；面板容器 `.me-view` 只是被父级加上 hidden，
 * UserMenu 自身不会收到任何回调，内部 `settingsOpen` 会一直停留在 true。
 * 于是用户切到别的页面后再点「我的」，设置抽屉会「自己冒出来」。
 *
 * 因此约定：应用壳在 Tab 切换 / 浏览器后退前进时广播 `ah:close-overlays`，
 * 本组件据此把内部覆盖层（设置抽屉 / 改密模态 / 头像下拉）全部归零。
 *
 * 网络层整体 mock：onMount 不注入 username 时会拉 /api/account/me，
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

import { mount, unmount, tick } from 'svelte';
import type { SvelteComponent } from 'svelte';
import UserMenu from './user-menu.svelte';

type Inst = SvelteComponent & { refreshMe?: () => Promise<void> };

/** 挂载 standalone（「我的」Tab）形态的组件。 */
async function mountStandalone(): Promise<Inst> {
  const inst = mount(UserMenu, {
    target: document.body,
    props: {
      standalone: true,
      username: 'tester',
      role: 'admin'
    }
  });
  await tick();
  return inst as Inst;
}

/** 按 .s-lbl 文案取 standalone 条目按钮。 */
function itemByLabel(label: string): HTMLButtonElement {
  const items = Array.from(
    document.body.querySelectorAll<HTMLButtonElement>('.s-item')
  );
  const found = items.find(
    (b) => b.querySelector('.s-lbl')?.textContent?.trim() === label
  );
  if (!found) throw new Error(`未找到条目：${label}`);
  return found;
}

/** 模拟应用壳的路由变化广播。 */
function signalRouteChange(): void {
  window.dispatchEvent(new CustomEvent('ah:close-overlays'));
}

describe('UserMenu（「我的」页覆盖层）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('standalone 默认不渲染设置抽屉与改密模态', async () => {
    const inst = await mountStandalone();
    expect(document.body.querySelector('.overlay')).toBeFalsy();
    // 改密模态（PasswordDialog）关闭时渲染为空（.pw-scrim 仅打开态存在）
    expect(document.body.querySelector('.pw-scrim')).toBeFalsy();
    unmount(inst);
  });

  it('点「设置」打开整屏抽屉，收到 ah:close-overlays 后关闭（回归：侧滑返回残留）', async () => {
    const inst = await mountStandalone();

    itemByLabel('设置').click();
    await tick();

    const drawer = document.body.querySelector('.overlay') as HTMLElement | null;
    expect(drawer).toBeTruthy();

    // 侧滑返回 / 切换 Tab：应用壳广播全局关闭信号
    signalRouteChange();
    await tick();

    expect(document.body.querySelector('.overlay')).toBeFalsy();
    unmount(inst);
  });

  it('抽屉打开时再次收到信号幂等（不抛错、不残留）', async () => {
    const inst = await mountStandalone();

    itemByLabel('设置').click();
    await tick();
    signalRouteChange();
    await tick();
    signalRouteChange();
    await tick();

    expect(document.body.querySelector('.overlay')).toBeFalsy();
    unmount(inst);
  });

  it('改密模态同样受 ah:close-overlays 关闭', async () => {
    const inst = await mountStandalone();

    itemByLabel('修改密码').click();
    await tick();

    // PasswordDialog 打开态渲染 .pw-scrim 遮罩
    expect(document.body.querySelector('.pw-scrim')).toBeTruthy();

    signalRouteChange();
    await tick();

    expect(document.body.querySelector('.pw-scrim')).toBeFalsy();
    unmount(inst);
  });

  it('关闭信号不影响下次正常打开（状态已归零，非一次性锁死）', async () => {
    const inst = await mountStandalone();

    itemByLabel('设置').click();
    await tick();
    signalRouteChange();
    await tick();

    itemByLabel('设置').click();
    await tick();

    const drawer = document.body.querySelector('.overlay') as HTMLElement | null;
    expect(drawer).toBeTruthy();
    unmount(inst);
  });
});

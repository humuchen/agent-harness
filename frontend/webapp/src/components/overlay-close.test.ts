/**
 * 路由联动：撰写区「常驻组件自持打开态」的浮层必须随路由变化收起 —— Svelte 5 迁移版。
 *
 * 回归背景：这些 picker 随应用壳一起挂载、切 Tab 只是被父级 hidden 而非销毁，
 * 内部 `open` 不会自己归零。移动端侧滑返回（只改 history、不产生点击）后
 * 再次进入对话页，会看到上次遗留的展开下拉。
 *
 * 统一机制见应用壳 closeAllOverlays：路由变化时向 window 广播
 * `ah:close-overlays`，各覆盖层组件订阅后自行关闭。
 * （「我的」宿主在 user-menu.test.ts。）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { mount, unmount, tick } from 'svelte';
import type { SvelteComponent } from 'svelte';
import ModePicker from './mode-picker.svelte';
import AgentPicker from './agent-picker.svelte';

/** 模拟应用壳的路由变化广播。 */
function signalRouteChange(): void {
  window.dispatchEvent(new CustomEvent('ah:close-overlays'));
}

/** 挂载组件并等到首次渲染完成。 */
async function mountC(
  C: typeof ModePicker | typeof AgentPicker,
  props: Record<string, unknown> = {}
): Promise<SvelteComponent> {
  const inst = mount(C, { target: document.body, props });
  await tick();
  return inst as SvelteComponent;
}

describe('路由联动：撰写区浮层随 ah:close-overlays 收起', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('mode-picker：展开态收到信号后收起', async () => {
    const inst = await mountC(ModePicker);
    expect(document.body.querySelector('.panel')).toBeFalsy();

    (document.body.querySelector('.trigger') as HTMLElement).click();
    await tick();
    expect(document.body.querySelector('.panel')).toBeTruthy();

    signalRouteChange();
    await tick();
    expect(document.body.querySelector('.panel')).toBeFalsy();
    unmount(inst);
  });

  it('mode-picker：收起态收到信号幂等（不抛错）', async () => {
    const inst = await mountC(ModePicker);

    signalRouteChange();
    signalRouteChange();
    await tick();

    expect(document.body.querySelector('.panel')).toBeFalsy();
    unmount(inst);
  });

  it('agent-picker：展开态收到信号后收起', async () => {
    const inst = await mountC(AgentPicker);
    expect(document.body.querySelector('.panel')).toBeFalsy();

    (document.body.querySelector('.trigger') as HTMLElement).click();
    await tick();
    expect(document.body.querySelector('.panel')).toBeTruthy();

    signalRouteChange();
    await tick();
    expect(document.body.querySelector('.panel')).toBeFalsy();
    unmount(inst);
  });

  it('agent-picker：收起后仍能再次展开（状态归零而非锁死）', async () => {
    const inst = await mountC(AgentPicker);

    (document.body.querySelector('.trigger') as HTMLElement).click();
    await tick();
    signalRouteChange();
    await tick();

    (document.body.querySelector('.trigger') as HTMLElement).click();
    await tick();
    expect(document.body.querySelector('.panel')).toBeTruthy();
    unmount(inst);
  });
});

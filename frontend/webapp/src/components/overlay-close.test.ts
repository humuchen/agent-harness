/**
 * 路由联动：撰写区「常驻组件自持打开态」的浮层必须随路由变化收起。
 *
 * 回归背景：这些 picker 随应用壳一起挂载、切 Tab 只是被父级 hidden 而非销毁，
 * 内部 `open` 不会自己归零。移动端侧滑返回（只改 history、不产生点击）后
 * 再次进入对话页，会看到上次遗留的展开下拉。
 *
 * 统一机制见 ah-app.closeAllOverlays：路由变化时向 window 广播
 * `ah:close-overlays`，各覆盖层组件订阅后自行关闭。
 * （弹框/抽屉类原语在 mac-ui-adapter.test.ts，「我的」宿主在 user-menu.test.ts。）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import './mode-picker';
import './agent-picker';
import type { AhModePicker } from './mode-picker';
import type { AhAgentPicker } from './agent-picker';

type El = HTMLElement & { updateComplete: Promise<unknown> };

/** 模拟 ah-app 的路由变化广播。 */
function signalRouteChange(): void {
  window.dispatchEvent(new CustomEvent('ah:close-overlays'));
}

/** 挂载组件并等到首次渲染完成。 */
async function mount<T extends HTMLElement>(tag: string): Promise<El & T> {
  const el = document.createElement(tag) as unknown as El & T;
  document.body.appendChild(el);
  await el.updateComplete;
  return el;
}

describe('路由联动：撰写区浮层随 ah:close-overlays 收起', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('ah-mode-picker：展开态收到信号后收起', async () => {
    const el = await mount<AhModePicker>('ah-mode-picker');
    expect(el.shadowRoot?.querySelector('.panel')).toBeFalsy();

    (el.shadowRoot?.querySelector('.trigger') as HTMLElement).click();
    await el.updateComplete;
    expect(el.shadowRoot?.querySelector('.panel')).toBeTruthy();

    signalRouteChange();
    await el.updateComplete;
    expect(el.shadowRoot?.querySelector('.panel')).toBeFalsy();
  });

  it('ah-mode-picker：收起态收到信号幂等（不抛错）', async () => {
    const el = await mount<AhModePicker>('ah-mode-picker');

    signalRouteChange();
    signalRouteChange();
    await el.updateComplete;

    expect(el.shadowRoot?.querySelector('.panel')).toBeFalsy();
  });

  it('ah-agent-picker：展开态收到信号后收起', async () => {
    const el = await mount<AhAgentPicker>('ah-agent-picker');
    expect(el.shadowRoot?.querySelector('.panel')).toBeFalsy();

    (el.shadowRoot?.querySelector('.trigger') as HTMLElement).click();
    await el.updateComplete;
    expect(el.shadowRoot?.querySelector('.panel')).toBeTruthy();

    signalRouteChange();
    await el.updateComplete;
    expect(el.shadowRoot?.querySelector('.panel')).toBeFalsy();
  });

  it('ah-agent-picker：收起后仍能再次展开（状态归零而非锁死）', async () => {
    const el = await mount<AhAgentPicker>('ah-agent-picker');

    (el.shadowRoot?.querySelector('.trigger') as HTMLElement).click();
    await el.updateComplete;
    signalRouteChange();
    await el.updateComplete;

    (el.shadowRoot?.querySelector('.trigger') as HTMLElement).click();
    await el.updateComplete;
    expect(el.shadowRoot?.querySelector('.panel')).toBeTruthy();
  });
});

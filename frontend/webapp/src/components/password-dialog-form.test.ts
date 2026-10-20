/**
 * ah-password-dialog 双形态（桌面模态 / 移动端抽屉）组件测试。
 *
 * 覆盖：
 *  - 形态分派依据的媒体查询与全站断点一致：'(max-width: 760px), (pointer: coarse)'。
 *  - 无 matchMedia 环境（旧浏览器 / jsdom 裸环境）回退桌面模态。
 *  - 匹配移动断点 → 全屏右侧抽屉（.overlay.right.fullscreen），含标题 / 字段 /
 *    底部按钮 / 关闭键；居中模态（.pw-scrim）不渲染。
 *  - 断点翻转（转屏 / 外接屏）实时切换形态，无需重开。
 *
 * jsdom 无 matchMedia、无布局：断点用可捕获回调的 stub 注入 globalThis；
 * 组件的 mobileMq 在每次挂载时求值，故 stub 先于 mount 注入。
 * 注意：本测试垫片的 querySelector 只可靠支持单类选择器，复合选择器
 * （后代/多类/属性组合）一律先取单类再手动过滤（与 ah-drawer-swipe 同规约）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount, unmount, tick } from 'svelte';
import PasswordDialog from './password-dialog.svelte';
import dialogSource from './password-dialog.svelte?raw';

type Inst = ReturnType<typeof mount<Record<string, any>, Record<string, any>>>;

const insts: Inst[] = [];

/** matchMedia stub：记录 query，支持用例中翻转 matches 并手动派发 change。 */
interface MqStub {
  queries: string[];
  setMatches(v: boolean): void;
  listeners: Array<() => void>;
}

function installMatchMedia(initialMatches: boolean): MqStub {
  const queries: string[] = [];
  const listeners: Array<() => void> = [];
  let matches = initialMatches;
  const stub = {
    queries,
    listeners,
    setMatches(v: boolean) {
      matches = v;
      for (const fn of listeners.slice()) fn();
    }
  };
  const mql = () =>
    ({
      get matches() {
        return matches;
      },
      media: queries[queries.length - 1] ?? '',
      addEventListener: (_t: string, fn: () => void) => listeners.push(fn),
      removeEventListener: (_t: string, fn: () => void) => {
        const i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      }
    }) as unknown as MediaQueryList;
  const impl = ((q: string) => {
    queries.push(q);
    return mql();
  }) as unknown as typeof matchMedia;
  (globalThis as Record<string, unknown>).matchMedia = impl;
  return stub;
}

function uninstallMatchMedia(): void {
  delete (globalThis as Record<string, unknown>).matchMedia;
}

function mountDialog(props: Record<string, unknown> = {}): void {
  const inst = mount(PasswordDialog, {
    target: document.body,
    props: { open: true, ...props } as never
  });
  insts.push(inst as never);
}

/** 垫片安全的类名读取（classList 未实现，直接取 class 属性串）。 */
const classOf = (el: Element | null): string =>
  el?.getAttribute('class') ?? '';

/** 密码输入框列表（先取全部 input 再按 type 过滤，避开复合选择器）。 */
function pwInputs(): HTMLElement[] {
  return Array.from(document.querySelectorAll('input')).filter(
    (i) => (i as HTMLInputElement).type === 'password'
  );
}

describe('ah-password-dialog 双形态分派', () => {
  // 注意：本垫片的 hook 作用域在注册时捕获，必须注册在 describe 内
  // （模块顶层注册的钩子不会作用于 describe 的用例——实例会跨用例泄漏）。
  beforeEach(() => {
    document.body.innerHTML = '';
    uninstallMatchMedia();
  });

  afterEach(() => {
    for (const inst of insts) unmount(inst as never);
    insts.length = 0;
    document.body.innerHTML = '';
    uninstallMatchMedia();
  });

  it('媒体查询与全站移动断点一致（max-width:760px / pointer:coarse）', () => {
    const stub = installMatchMedia(false);
    mountDialog();
    expect(stub.queries.length).toBeGreaterThan(0);
    expect(stub.queries[0]).toBe('(max-width: 760px), (pointer: coarse)');
  });

  it('无 matchMedia（旧环境）→ 回退桌面居中模态', async () => {
    mountDialog();
    await tick();
    expect(document.querySelector('.pw-scrim')).toBeTruthy();
    expect(document.querySelector('.panel')).toBeTruthy();
    // 模态不渲染抽屉 DOM
    expect(document.querySelector('.overlay')).toBeNull();
    // 三个密码输入框
    expect(pwInputs().length).toBe(3);
  });

  it('匹配移动断点 → 全屏右侧抽屉，模态不渲染', async () => {
    installMatchMedia(true);
    mountDialog();
    await tick();
    const overlay = document.querySelector('.overlay');
    expect(overlay).toBeTruthy();
    const cls = classOf(overlay);
    expect(cls).toContain('right');
    expect(cls).toContain('fullscreen');
    // 居中模态绝不同时出现
    expect(document.querySelector('.pw-scrim')).toBeNull();
    // 标题与关闭键（busy=false 时 showClose=true）
    expect(overlay?.querySelector('.title')?.textContent).toBe('修改密码');
    expect(overlay?.querySelector('.close')).toBeTruthy();
    // 字段与底部动作按钮（footer snippet：取消 / 修改）
    expect(overlay?.querySelectorAll('input').length).toBe(3);
    const foot = overlay?.querySelector('.foot');
    expect(foot?.textContent).toContain('取消');
    expect(foot?.textContent).toContain('修改');
  });

  it('断点翻转实时切换形态（抽屉 ↔ 模态），无需重开', async () => {
    const stub = installMatchMedia(true);
    mountDialog();
    await tick();
    expect(document.querySelector('.overlay')).toBeTruthy();

    stub.setMatches(false);
    await tick();
    expect(document.querySelector('.overlay')).toBeNull();
    expect(document.querySelector('.pw-scrim')).toBeTruthy();

    stub.setMatches(true);
    await tick();
    expect(document.querySelector('.overlay')).toBeTruthy();
    expect(document.querySelector('.pw-scrim')).toBeNull();
  });

  it('抽屉形态的关闭策略契约：busy 时四条关闭路径在 props 层禁用（源码契约）', () => {
    // busy 翻转需要 mock api 模块（本垫片对 runes store 模块的 mock 受限），
    // 这里退而断言源码契约：四个关闭类 props 均绑定 !busy，防止回归时悄悄丢掉。
    expect(dialogSource).toContain('maskClosable={!busy}');
    expect(dialogSource).toContain('escClosable={!busy}');
    expect(dialogSource).toContain('showClose={!busy}');
    expect(dialogSource).toContain('swipeToClose={!busy}');
  });
});

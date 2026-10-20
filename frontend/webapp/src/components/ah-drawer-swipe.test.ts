/**
 * ah-drawer 侧滑关闭（移动端手势）组件测试 —— Svelte 5 迁移版。
 *
 * 覆盖：跟手位移 / 过阈值关闭 / 未过阈值回弹 / 纵向滚动不误触 / 内缘带外忽略 /
 * 甩动（速度通道）关闭 / 垂直方位仅 chrome 区发起 / swipeToClose=false /
 * 路由中断清残留 / overlay 停止冒泡（防应用壳边缘手势）/ 收尾曲线与打开动画一致。
 *
 * jsdom 不做布局：面板几何（getBoundingClientRect / offsetWidth）由测试注入；
 * 触摸事件用带 touches 的普通 Event 模拟（jsdom 无 TouchEvent 构造器）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount, unmount, tick } from 'svelte';
import type { ComponentProps } from 'svelte';
import AhDrawer from './ah-drawer.svelte';
import drawerSource from './ah-drawer.svelte?raw';

type DrawerProps = ComponentProps<typeof AhDrawer>;

/** 离场动画时长（ms），与组件内 LEAVE_MS 一致。 */
const LEAVE_MS = 220;
/** 组件内打开动画曲线（与 @keyframes ahd-slide-in 同值，测试内复刻用于断言）。 */
const OPEN_EASE = 'cubic-bezier(0.2, 0.8, 0.3, 1)';

const insts: Record<string, unknown>[] = [];

function mountDrawer(props: Partial<DrawerProps> = {}): ReturnType<typeof mount<DrawerProps, Record<string, any>>> {
  const inst = mount(AhDrawer, {
    target: document.body,
    props: props as DrawerProps
  });
  insts.push(inst as unknown as Record<string, unknown>);
  return inst as never;
}

/** 构造带 touches 的触摸事件（jsdom 无 TouchEvent，defineProperty 注入）。 */
function touchEvent(type: string, x: number, y: number): Event {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'touches', {
    value: [{ clientX: x, clientY: y }],
    configurable: true
  });
  return e;
}

/** 注入面板几何（jsdom 无布局，offsetWidth/Height 恒 0、rect 恒零）。 */
function stubPanelGeometry(
  panel: HTMLElement,
  opts: { left?: number; top?: number; width: number; height?: number }
): void {
  const left = opts.left ?? 0;
  const top = opts.top ?? 0;
  const width = opts.width;
  const height = opts.height ?? 800;
  Object.defineProperty(panel, 'offsetWidth', { value: width, configurable: true });
  Object.defineProperty(panel, 'offsetHeight', { value: height, configurable: true });
  panel.getBoundingClientRect = () =>
    ({
      left,
      top,
      right: left + width,
      bottom: top + height,
      width,
      height,
      x: left,
      y: top,
      toJSON: () => ({})
    }) as DOMRect;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 一次完整的候选手势：起点 → 若干移动点 → 松手。 */
async function swipe(
  panel: HTMLElement,
  from: { x: number; y: number },
  moves: Array<{ x: number; y: number }>,
  opts: { startOn?: HTMLElement; gapsMs?: number } = {}
): Promise<void> {
  const startTarget = opts.startOn ?? panel;
  startTarget.dispatchEvent(touchEvent('touchstart', from.x, from.y));
  for (const m of moves) {
    if (opts.gapsMs) await sleep(opts.gapsMs);
    panel.dispatchEvent(touchEvent('touchmove', m.x, m.y));
  }
  panel.dispatchEvent(touchEvent('touchend', from.x, from.y));
  await tick();
}

describe('ah-drawer 侧滑关闭（移动端）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  afterEach(() => {
    for (const inst of insts) unmount(inst as never);
    insts.length = 0;
    document.body.innerHTML = '';
  });

  /** 挂载一个 320px 宽、停靠屏幕右缘（left=70）的 right 抽屉并注入几何。 */
  async function mountRightDrawer(
    props: Partial<DrawerProps> = {}
  ): Promise<{ panel: HTMLElement; reasons: string[] }> {
    const reasons: string[] = [];
    mountDrawer({ open: true, placement: 'right', title: '测试抽屉', ...props, onclose: (r) => reasons.push(r) });
    await tick();
    const panel = document.querySelector('.panel') as HTMLElement;
    stubPanelGeometry(panel, { left: 70, width: 320 });
    return { panel, reasons };
  }

  it('跟手：拖动过程中面板沿关闭轴平移、遮罩等比例衰减', async () => {
    const { panel } = await mountRightDrawer();
    const scrim = document.querySelector('.scrim') as HTMLElement;

    // 从内缘带（70+32=102 内）发起，拖到 160px
    panel.dispatchEvent(touchEvent('touchstart', 80, 400));
    panel.dispatchEvent(touchEvent('touchmove', 240, 405));

    expect(panel.style.transform).toBe('translateX(160px)');
    // 遮罩透明度 = 1 - 进度 = 1 - 160/320 = 0.5
    expect(scrim.style.opacity).toBe('0.5');
    // 跟手期无过渡（避免 0.22s 滞后）
    expect(panel.style.transition).toBe('none');
  });

  it('过阈值（>=35% 面板宽）松手 → 以 swipe 原因关闭，并推到全关位', async () => {
    const { panel, reasons } = await mountRightDrawer();
    await swipe(panel, { x: 80, y: 400 }, [{ x: 240, y: 405 }]); // 160 >= 320*0.35=112

    // 松手即沿打开动画同曲线滑向全关位
    expect(panel.style.transform).toBe('translateX(320px)');
    expect(panel.style.transition).toContain('220ms');
    expect(panel.style.transition).toContain(OPEN_EASE);

    await sleep(LEAVE_MS + 80);
    expect(reasons).toEqual(['swipe']);
  });

  it('未过阈值松手 → 回弹到全开（同曲线），不触发关闭', async () => {
    const { panel, reasons } = await mountRightDrawer();
    await swipe(panel, { x: 80, y: 400 }, [{ x: 140, y: 405 }]); // 60 < 112

    // 回弹：内联 transform 被清掉（过渡由内联 transition 承担）
    expect(panel.style.transform).toBe('');
    expect(panel.style.transition).toContain(OPEN_EASE);

    await sleep(LEAVE_MS + 120);
    expect(reasons).toEqual([]);
    // 回弹收尾后内联 transition 已清掉，不影响后续离场动画
    expect(panel.style.transition).toBe('');
  });

  it('纵向位移占优 → 不确认为拖拽，交回原生滚动，不关闭', async () => {
    const { panel, reasons } = await mountRightDrawer();
    await swipe(panel, { x: 80, y: 400 }, [
      { x: 85, y: 470 },
      { x: 82, y: 540 }
    ]);
    expect(panel.style.transform).toBe('');
    await sleep(LEAVE_MS + 80);
    expect(reasons).toEqual([]);
  });

  it('起点在内缘带之外 → 整体忽略（面板内容区不响应侧滑关闭）', async () => {
    const { panel, reasons } = await mountRightDrawer();
    // x=200 距内缘（70）130px，远超 32px 边缘带
    await swipe(panel, { x: 200, y: 400 }, [{ x: 400, y: 405 }]);
    expect(panel.style.transform).toBe('');
    await sleep(LEAVE_MS + 80);
    expect(reasons).toEqual([]);
  });

  it('未过距离阈值但甩动够快（速度通道）→ 关闭', async () => {
    const { panel, reasons } = await mountRightDrawer();
    // 两段移动：总距 90 < 112，但末段速度 = 30px/40ms = 0.75px/ms > 0.5
    await swipe(panel, { x: 80, y: 400 }, [{ x: 140, y: 400 }, { x: 170, y: 402 }], {
      gapsMs: 40
    });
    expect(panel.style.transform).toBe('translateX(320px)');
    await sleep(LEAVE_MS + 80);
    expect(reasons).toEqual(['swipe']);
  });

  it('拖动量过小的快抖（<24px）→ 仍回弹，不关闭', async () => {
    const { panel, reasons } = await mountRightDrawer();
    await swipe(panel, { x: 80, y: 400 }, [{ x: 100, y: 400 }, { x: 106, y: 401 }], {
      gapsMs: 20
    });
    await sleep(LEAVE_MS + 80);
    expect(reasons).toEqual([]);
  });

  it('left 抽屉：从面板右缘（内缘）向左滑关闭', async () => {
    const reasons: string[] = [];
    mountDrawer({
      open: true,
      placement: 'left',
      title: '测试抽屉',
      onclose: (r) => reasons.push(r)
    });
    await tick();
    const panel = document.querySelector('.panel') as HTMLElement;
    // 停靠屏幕左缘：面板 [0, 320]，内缘是 right=320 那侧
    stubPanelGeometry(panel, { left: 0, width: 320 });

    // 跟手：从右缘带（310）向左拖 160px，位移沿关闭轴取负
    panel.dispatchEvent(touchEvent('touchstart', 310, 400));
    panel.dispatchEvent(touchEvent('touchmove', 150, 405));
    expect(panel.style.transform).toBe('translateX(-160px)');

    // 松手过阈值 → 推到全关位（-320px）
    panel.dispatchEvent(touchEvent('touchend', 150, 405));
    await tick();
    expect(panel.style.transform).toBe('translateX(-320px)');
    await sleep(LEAVE_MS + 80);
    expect(reasons).toEqual(['swipe']);
  });

  it('bottom 抽屉：仅允许从头部 chrome 区发起，body 内（含缘带）不启用手势', async () => {
    const reasons: string[] = [];
    mountDrawer({
      open: true,
      placement: 'bottom',
      title: '测试抽屉',
      onclose: (r) => reasons.push(r)
    });
    await tick();
    const panel = document.querySelector('.panel') as HTMLElement;
    const head = panel.querySelector('.head') as HTMLElement;
    const body = panel.querySelector('.body') as HTMLElement;
    // 面板贴屏幕底：top=524, height=320，内缘是 top=524 那侧（头部所在）
    stubPanelGeometry(panel, { top: 524, width: 390, height: 320 });

    // 从 body 顶部缘带内发起（y=530，距 top 6px）：被「body 不启用手势」规则拒绝
    await swipe(panel, { x: 200, y: 530 }, [{ x: 200, y: 700 }], { startOn: body });
    expect(panel.style.transform).toBe('');
    await sleep(LEAVE_MS + 80);
    expect(reasons).toEqual([]);

    // 从头部发起：向下拖 170 >= 320*0.35=112 → 关闭
    await swipe(panel, { x: 200, y: 530 }, [{ x: 200, y: 700 }], { startOn: head });
    expect(panel.style.transform).toBe('translateY(320px)');
    await sleep(LEAVE_MS + 80);
    expect(reasons).toEqual(['swipe']);
  });

  it('起点在可横向滚动的代码块上 → 让位原生横向滚动，不关抽屉', async () => {
    const { panel, reasons } = await mountRightDrawer();
    const body = panel.querySelector('.body') as HTMLElement;
    // 造一个「有溢出的横向滚动容器」（代码块）：jsdom 无布局，尺寸与计算样式均注入
    const code = document.createElement('div');
    code.className = 'md-code-body';
    code.style.overflowX = 'auto';
    Object.defineProperty(code, 'scrollWidth', { value: 800, configurable: true });
    Object.defineProperty(code, 'clientWidth', { value: 320, configurable: true });
    // getComputedStyle 在 jsdom 只反射内联样式，overflow-x:auto 可被读到
    body.appendChild(code);

    // 从代码块内缘带处右滑：应滚动代码而非关抽屉
    await swipe(panel, { x: 80, y: 400 }, [{ x: 240, y: 405 }], { startOn: code });
    expect(panel.style.transform).toBe('');
    await sleep(LEAVE_MS + 80);
    expect(reasons).toEqual([]);

    // 对照：非溢出的普通元素上同手势仍可关闭
    const plain = document.createElement('div');
    body.appendChild(plain);
    await swipe(panel, { x: 80, y: 400 }, [{ x: 240, y: 405 }], { startOn: plain });
    expect(panel.style.transform).toBe('translateX(320px)');
    await sleep(LEAVE_MS + 80);
    expect(reasons).toEqual(['swipe']);
  });

  it('swipeToClose=false → 手势整体关闭', async () => {
    const { panel, reasons } = await mountRightDrawer({ swipeToClose: false });
    await swipe(panel, { x: 80, y: 400 }, [{ x: 240, y: 405 }]);
    expect(panel.style.transform).toBe('');
    await sleep(LEAVE_MS + 80);
    expect(reasons).toEqual([]);
  });

  it('手势进行中收到 ah:close-overlays（路由切换）→ 立即关闭并清掉跟手残留', async () => {
    const { panel, reasons } = await mountRightDrawer();
    panel.dispatchEvent(touchEvent('touchstart', 80, 400));
    panel.dispatchEvent(touchEvent('touchmove', 240, 405));
    expect(panel.style.transform).toBe('translateX(160px)');

    window.dispatchEvent(new CustomEvent('ah:close-overlays'));
    await tick();

    // 跳过离场动画立即回调，且半开位移被清掉（不留残留 transform）
    expect(reasons).toEqual(['button']);
    expect(panel.style.transform).toBe('');
  });

  it('overlay 根停止 touch 冒泡：抽屉上的触摸不误触发 app 壳的边缘手势', async () => {
    const { panel } = await mountRightDrawer();
    let shellSawTouch = false;
    const shellListener = () => {
      shellSawTouch = true;
    };
    window.addEventListener('touchmove', shellListener);

    // 对照组：抽屉外的触摸能到达 window（壳手势可正常工作）
    const outsider = document.createElement('div');
    document.body.appendChild(outsider);
    outsider.dispatchEvent(touchEvent('touchmove', 100, 100));
    expect(shellSawTouch).toBe(true);

    // 实验组：抽屉面板上的触摸被 overlay 根拦住
    shellSawTouch = false;
    panel.dispatchEvent(touchEvent('touchmove', 240, 405));
    expect(shellSawTouch).toBe(false);

    window.removeEventListener('touchmove', shellListener);
    outsider.remove();
  });

  it('拖拽松手落在按钮上 → 合成 click 被吞掉，不误触关闭', async () => {
    const { panel, reasons } = await mountRightDrawer();
    await swipe(panel, { x: 80, y: 400 }, [{ x: 140, y: 405 }]); // 回弹（未过阈值）
    const closeBtn = panel.querySelector('.close') as HTMLElement;
    closeBtn.click();
    await tick();
    expect(reasons).toEqual([]); // 回弹后的误触点击被吞
  });

  it('收尾曲线与打开动画一致（OPEN_EASE 与 ahd-slide-in 关键帧同值）', async () => {
    // 锁定「侧滑收尾复用打开曲线」这一契约：改任何一侧另一侧必须同步
    expect(drawerSource).toMatch(/ahd-slide-in 0\.22s cubic-bezier\(0\.2, 0\.8, 0\.3, 1\)/);
    expect(OPEN_EASE).toBe('cubic-bezier(0.2, 0.8, 0.3, 1)');
  });

  it('打开期间向原生壳申请系统返回手势排除，关闭后释放', async () => {
    const calls: boolean[] = [];
    (globalThis as unknown as { AhSystemGesture?: unknown }).AhSystemGesture = {
      setDrawerGestureExclusion: (enabled: boolean) => calls.push(enabled)
    };
    try {
      const { reasons } = await mountRightDrawer();
      expect(calls).toEqual([true]); // 打开即申请
      await swipe(
        document.querySelector('.panel') as HTMLElement,
        { x: 80, y: 400 },
        [{ x: 240, y: 405 }]
      );
      await sleep(LEAVE_MS + 80);
      expect(reasons).toEqual(['swipe']);
      // 父级把 open 置 false 的模拟由卸载完成：卸载后释放
      unmount(insts.pop() as never);
      expect(calls).toEqual([true, false]);
    } finally {
      delete (globalThis as unknown as { AhSystemGesture?: unknown }).AhSystemGesture;
    }
  });
});

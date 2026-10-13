/**
 * ModelPicker 回归测试：点击触发按钮后模型选择面板必须渲染。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../api', () => ({
  authedFetch: vi.fn().mockResolvedValue({ ok: true, json: async () => [] }),
  getToken: vi.fn().mockReturnValue('test-token')
}));

import { mount, unmount, tick } from 'svelte';
import type { SvelteComponent } from 'svelte';
import ModelPicker from './model-picker.svelte';

async function mountPicker(props?: Record<string, unknown>) {
  const inst = mount(ModelPicker, {
    target: document.body,
    props: { model: 'agnes-2.5-flash', ...(props ?? {}) }
  });
  await tick();
  return inst as SvelteComponent;
}

describe('ModelPicker（模型选择器）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [] })
    }) as unknown as typeof fetch;
  });
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('点击触发按钮后弹出选择面板', async () => {
    const inst = await mountPicker();
    const trigger = document.body.querySelector(
      '.model-picker-root .trigger'
    ) as HTMLButtonElement | null;
    expect(trigger).toBeTruthy();

    trigger!.click();
    await tick();
    await tick();

    const panel = document.body.querySelector('.model-picker-root .panel') as
      | HTMLElement
      | null;
    expect(panel).toBeTruthy();

    // 回归：面板为 position:fixed + JS 锚定（真机上 absolute 方案被真实
    // 应用壳的层叠/裁剪上下文吞掉绘制，表现为盒子在而画面全无）。
    // 打开后必须写入内联定位（right/bottom/max-height）；position:fixed
    // 来自组件 scoped 样式，jsdom 不做样式表计算，无法在此断言。
    expect(panel!.style.right).toContain('px');
    expect(panel!.style.bottom).toContain('px');
    expect(panel!.style.maxHeight).toContain('px');

    unmount(inst);
  });
});

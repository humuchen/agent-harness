/**
 * SettingsCenter 回归测试：
 * 1) 切换顶部 Tab 后，对应分组内容区必须渲染（mountedGroups 是响应式的）。
 * 2) 默认分组内容可见。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    client: {
      getState: vi.fn().mockResolvedValue({ openrouter: true })
    }
  };
});

vi.mock('../utils/storage-usage', () => ({
  clearCache: vi.fn().mockResolvedValue({ ran: false }),
  clearData: vi.fn().mockResolvedValue({ ran: true }),
  measureStorage: vi.fn().mockResolvedValue({
    total: 0,
    app: 0,
    data: 0,
    cache: 0,
    native: false
  })
}));

vi.mock('../plugin-notify', () => ({
  getReminderUnread: vi.fn().mockReturnValue({ count: 0 }),
  clearReminderUnread: vi.fn()
}));

import { mount, unmount, tick } from 'svelte';
import type { SvelteComponent } from 'svelte';
import SettingsCenter from './settings-center.svelte';

async function mountCenter(props?: Record<string, unknown>) {
  const inst = mount(SettingsCenter, {
    target: document.body,
    props: { visible: true, ...(props ?? {}) }
  });
  await tick();
  return inst as unknown as SvelteComponent;
}

function tabByLabel(label: string): HTMLButtonElement {
  const tabs = Array.from(
    document.body.querySelectorAll<HTMLButtonElement>('.ttab')
  );
  const found = tabs.find(
    (b) => b.querySelector('.tl')?.textContent?.trim() === label
  );
  if (!found) throw new Error(`未找到 Tab：${label}`);
  return found;
}

function section(group: string): HTMLElement | null {
  return document.body.querySelector(`section[data-group="${group}"]`);
}

describe('SettingsCenter（设置中心 Tab 切换）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('默认「系统与网络」分组内容可见', async () => {
    const inst = await mountCenter();
    const sys = section('system');
    expect(sys).toBeTruthy();
    expect(sys?.hasAttribute('hidden')).toBe(false);
    unmount(inst);
  });

  it('点击「模型与密钥」后该分组内容渲染且可见', async () => {
    const inst = await mountCenter();
    tabByLabel('模型与密钥').click();
    await tick();
    await tick();
    const keys = section('keys');
    expect(keys).toBeTruthy();
    expect(keys?.hasAttribute('hidden')).toBe(false);
    unmount(inst);
  });

  it('点击「外观」后该分组内容渲染且可见', async () => {
    const inst = await mountCenter();
    tabByLabel('外观').click();
    await tick();
    await tick();
    const appearance = section('appearance');
    expect(appearance).toBeTruthy();
    expect(appearance?.hasAttribute('hidden')).toBe(false);
    unmount(inst);
  });

  it('点击「关于」后该分组内容渲染且可见', async () => {
    const inst = await mountCenter();
    tabByLabel('关于').click();
    await tick();
    await tick();
    const about = section('about');
    expect(about).toBeTruthy();
    expect(about?.hasAttribute('hidden')).toBe(false);
    unmount(inst);
  });
});

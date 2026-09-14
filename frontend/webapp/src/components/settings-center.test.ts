/**
 * ah-settings-center 测试（方案 B · 顶部平铺 Tab）。
 *
 * 覆盖真正易回归的行为，而非样式：
 *  - 四个分组 Tab 齐全 + 默认落在「模型与密钥」（账户分组已下线，见组件头注释）；
 *  - 点击 Tab 切换内容区（惰性挂载：未访问过的分组不产生 section，避免无谓请求）；
 *  - 父级经 ah-goto 传 group + groupSeq 时能重新定位分组（同一分组重复请求也生效）；
 *  - 父级传入已下线的分组（account）时忽略之，保持当前分组，不出现空白内容区；
 *  - 「外观」主题分段真实写 localStorage(ah-theme) 与 <html data-theme>，
 *    并广播 ah:theme-changed 让顶层同步；
 *  - 侧边栏收起偏好向父级派发 ah-sidebar-collapsed。
 *
 * 网络层整体 mock：本组件（及其内嵌的密钥面板）访问的 /api/* 在单测中不应真连服务端。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// 只 stub 真正会出网的入口，其余导出保持原样（如 getUsername 等纯读 localStorage 的工具）。
// authedFetch 统一返回 401：密钥面板的 load() 对 401 静默返回，不会走通知分支。
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    client: { getState: vi.fn().mockResolvedValue({ openrouter: true }) },
    authedFetch: vi.fn().mockResolvedValue({ ok: false, status: 401 })
  };
});

import './settings-center';
import type { AhSettingsCenter } from './settings-center';

type El = AhSettingsCenter & { updateComplete: Promise<unknown> };

/** 挂载组件并等到首次渲染完成。 */
async function mount(): Promise<El> {
  const el = document.createElement(
    'ah-settings-center'
  ) as unknown as AhSettingsCenter;
  document.body.appendChild(el);
  await el.updateComplete;
  return el as El;
}

/** 取 shadow root 内匹配元素；找不到直接抛错，避免断言静默通过。 */
function q<T extends Element>(el: El, sel: string): T {
  const found = el.shadowRoot?.querySelector(sel);
  if (!found) throw new Error(`未找到元素：${sel}`);
  return found as T;
}

/** 当前激活的顶部分组 Tab 文案（取全名 span）。 */
function activeTab(el: El): string {
  return q<HTMLElement>(el, '.ttab.on .tl.full').textContent?.trim() ?? '';
}

/** 当前可见（未 hidden）的分组 section。 */
function visibleSections(el: El): Element[] {
  return Array.from(el.shadowRoot?.querySelectorAll('section') ?? []).filter(
    (s) => !(s as HTMLElement).hidden
  );
}

/** 已挂载（存在于 DOM）的分组 id 列表。 */
function mountedGroups(el: El): Array<string | null> {
  return Array.from(el.shadowRoot?.querySelectorAll('section') ?? []).map((s) =>
    s.getAttribute('data-group')
  );
}

describe('ah-settings-center（方案 B 顶部平铺 Tab）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    document.documentElement.setAttribute('data-theme', 'dark');
    localStorage.removeItem('ah-theme');
  });

  afterEach(() => {
    document.body.innerHTML = '';
    localStorage.removeItem('ah-theme');
  });

  it('渲染四个分组 Tab，且默认停在「模型与密钥」', async () => {
    const el = await mount();
    const labels = Array.from(el.shadowRoot!.querySelectorAll('.ttab .tl.full'))
      .map((n) => n.textContent?.trim())
      .filter(Boolean);
    expect(labels).toEqual(['模型与密钥', '系统与网络', '外观', '关于']);
    expect(activeTab(el)).toBe('模型与密钥');
    expect(visibleSections(el)).toHaveLength(1);
  });

  it('不再提供「账户」分组（账户资料 / 改密 / 退出归「我的」页）', async () => {
    const el = await mount();
    const labels = Array.from(el.shadowRoot!.querySelectorAll('.ttab .tl.full'))
      .map((n) => n.textContent?.trim())
      .filter(Boolean);
    expect(labels).not.toContain('账户');
    expect(el.shadowRoot!.querySelector('[data-group="account"]')).toBeNull();
    // 改密模态不再由本组件渲染
    expect(el.shadowRoot!.querySelector('ah-password-dialog')).toBeNull();
  });

  it('惰性挂载：未访问过的分组不产生 section', async () => {
    const el = await mount();
    // 初始只有密钥分组被挂载（其余分组要等首次访问）
    expect(mountedGroups(el)).toEqual(['keys']);
  });

  it('点击 Tab 切换内容区，并保留已挂载分组的状态', async () => {
    const el = await mount();
    const tabs = el.shadowRoot!.querySelectorAll<HTMLElement>('.ttab');

    tabs[2]!.click(); // 外观
    await el.updateComplete;
    expect(activeTab(el)).toBe('外观');
    const visible = visibleSections(el);
    expect(visible).toHaveLength(1);
    expect(visible[0]!.getAttribute('data-group')).toBe('appearance');

    tabs[0]!.click(); // 回到模型与密钥
    await el.updateComplete;
    expect(activeTab(el)).toBe('模型与密钥');
    // 两个分组都已挂载（外观保留在 DOM，仅 hidden）
    expect(el.shadowRoot!.querySelectorAll('section')).toHaveLength(2);
  });

  it('父级传 group + groupSeq 时重新定位；同一分组重复请求也生效', async () => {
    const el = await mount();

    el.group = 'about';
    el.groupSeq = 1;
    await el.updateComplete;
    expect(activeTab(el)).toBe('关于');

    // 用户手动切回模型与密钥
    el.shadowRoot!.querySelectorAll<HTMLElement>('.ttab')[0]!.click();
    await el.updateComplete;
    expect(activeTab(el)).toBe('模型与密钥');

    // 父级再次请求同一分组 → groupSeq 自增，必须重新定位
    el.groupSeq = 2;
    await el.updateComplete;
    expect(activeTab(el)).toBe('关于');
  });

  it('父级传入已下线的分组（account）时忽略之，保持当前分组且内容区不空白', async () => {
    const el = await mount();

    // 历史上「我的 → 设置」默认带 account；该分组下线后不应把内容区切空
    (el as unknown as { group: string }).group = 'account';
    el.groupSeq = 1;
    await el.updateComplete;

    expect(activeTab(el)).toBe('模型与密钥');
    const visible = visibleSections(el);
    expect(visible).toHaveLength(1);
    expect(visible[0]!.getAttribute('data-group')).toBe('keys');
  });

  it('外观：切换浅色会写盘并广播 ah:theme-changed', async () => {
    const el = await mount();
    const events: string[] = [];
    const onTheme = () => events.push(document.documentElement.dataset.theme ?? '');
    window.addEventListener('ah:theme-changed', onTheme);

    // 进入「外观」分组
    el.shadowRoot!.querySelectorAll<HTMLElement>('.ttab')[2]!.click();
    await el.updateComplete;

    const segBtns = el.shadowRoot!.querySelectorAll<HTMLElement>('.seg button');
    expect(segBtns).toHaveLength(3);
    segBtns[1]!.click(); // 浅色
    await el.updateComplete;

    expect(localStorage.getItem('ah-theme')).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(events).toEqual(['light']);

    // 「跟随系统」清除显式偏好
    segBtns[2]!.click();
    await el.updateComplete;
    expect(localStorage.getItem('ah-theme')).toBeNull();

    window.removeEventListener('ah:theme-changed', onTheme);
  });

  it('侧边栏偏好变更向父级派发 ah-sidebar-collapsed', async () => {
    const el = await mount();
    const seen: boolean[] = [];
    el.addEventListener('ah-sidebar-collapsed', (e) => {
      seen.push((e as CustomEvent<{ collapsed: boolean }>).detail.collapsed);
    });
    el.shadowRoot!.querySelectorAll<HTMLElement>('.ttab')[2]!.click();
    await el.updateComplete;

    q<HTMLElement>(el, '.toggle').click();
    await el.updateComplete;
    expect(seen).toEqual([false]); // 默认收起 true → 切换为 false
  });
});

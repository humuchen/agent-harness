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
 *  - 侧边栏收起偏好向父级派发 ah-sidebar-collapsed；
 *  - 移动端滑动指示条的下标（--tab-i）跟随当前分组；
 *  - 「系统与网络 → 存储空间」两行齐全，且「清理」只清视图缓存，
 *    必须保留登录凭据（ah_token）与用户偏好（ah-theme）。
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

/** 取「系统与网络」分组内指定行（按 .rl 文案匹配）的详述 .rd 文本。 */
function systemRowDetail(el: El, label: string): string {
  const sec = el.shadowRoot?.querySelector('section[data-group="system"]');
  if (!sec) return '';
  for (const row of Array.from(sec.querySelectorAll('.row'))) {
    if (row.querySelector('.rl')?.textContent?.trim() === label) {
      return row.querySelector('.rd')?.textContent?.trim() ?? '';
    }
  }
  return '';
}

/** 轮询等待断言通过：清缓存与存储测量是异步的，轮询比猜固定 tick 数更稳。 */
async function until(fn: () => void, ms = 800): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    try {
      fn();
      return;
    } catch (e) {
      if (Date.now() - t0 > ms) throw e;
      await new Promise((r) => setTimeout(r, 10));
    }
  }
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

  it('移动端滑动指示条：--tab-i 跟随当前分组，且标记为装饰性', async () => {
    const el = await mount();
    /** 读取 tabs 容器上的 --tab-i（直接断言 style 属性文本，避免依赖 computedStyle）。 */
    const tabIndex = () =>
      q<HTMLElement>(el, '.tabs').getAttribute('style') ?? '';

    expect(tabIndex()).toMatch(/--tab-i:\s*0/);
    // 指示条存在、且对辅助技术隐藏（纯装饰）
    expect(q<HTMLElement>(el, '.tab-ink').getAttribute('aria-hidden')).toBe(
      'true'
    );

    el.shadowRoot!.querySelectorAll<HTMLElement>('.ttab')[2]!.click();
    await el.updateComplete;
    expect(tabIndex()).toMatch(/--tab-i:\s*2/);

    el.shadowRoot!.querySelectorAll<HTMLElement>('.ttab')[0]!.click();
    await el.updateComplete;
    expect(tabIndex()).toMatch(/--tab-i:\s*0/);
  });

  it('系统与网络：存储空间两行齐全，且清理只清视图缓存、保留登录与偏好', async () => {
    // 预置：两个可清理键（视图 / 会话态）+ 两个受保护键（凭据 / 偏好）
    localStorage.setItem('ah_model', 'gpt-4o');
    localStorage.setItem('ah_active_id', 'sess-1');
    localStorage.setItem('ah_token', 'secret-token');
    localStorage.setItem('ah-theme', 'dark');

    const el = await mount();
    el.shadowRoot!.querySelectorAll<HTMLElement>('.ttab')[1]!.click(); // 系统与网络
    await el.updateComplete;
    // 存储占用是异步测量，等它落地
    await until(() => {
      expect(systemRowDetail(el, '缓存占用')).toBeTruthy();
    });

    const sec = q<HTMLElement>(el, 'section[data-group="system"]');
    const labels = Array.from(sec.querySelectorAll('.rl')).map((n) =>
      n.textContent?.trim()
    );
    expect(labels).toEqual(
      expect.arrayContaining(['缓存占用', '清理缓存'])
    );
    // 「清理缓存」详述如实说明清什么、不清什么
    expect(systemRowDetail(el, '清理缓存')).toContain('不影响登录状态');
    // 系统分组共三个操作：检测 / 清空 / 清理
    const btns = Array.from(sec.querySelectorAll<HTMLElement>('.btn'));
    expect(btns).toHaveLength(3);

    btns[2]!.click(); // 清理
    await until(() => {
      expect(localStorage.getItem('ah_model')).toBeNull();
    });

    // 可清理键已清掉
    expect(localStorage.getItem('ah_active_id')).toBeNull();
    // 受保护键必须原样保留 —— 这是「清理缓存」的安全边界
    expect(localStorage.getItem('ah_token')).toBe('secret-token');
    expect(localStorage.getItem('ah-theme')).toBe('dark');

    // 清完刷新计数（不再残留已清的项）
    await until(() => {
      expect(systemRowDetail(el, '清理缓存')).toContain('0 项');
    });

    for (const k of ['ah_model', 'ah_active_id', 'ah_token', 'ah_theme']) {
      localStorage.removeItem(k);
    }
  });
});

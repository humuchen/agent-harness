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
 *  - 「存储空间」六行齐全（总计 / 应用 / 数据 / 清除数据 / 缓存 / 清除缓存）：
 *    「清除缓存」无需确认且完全不动本地数据，「清除数据」必须经二次确认后连登录凭据一起清；
 *  - 原生壳（Capacitor）下四行改按目录口径取数（用假的 window.Capacitor.Plugins.Filesystem 覆盖）。
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

// 「清除数据」的二次确认弹框：这里只验证「是否调用 + 是否尊重返回值」，
// 弹框自身由 mac-ui-adapter 测试覆盖，故 mock 掉，避免依赖其内部 DOM 结构。
const { confirmMock } = vi.hoisted(() => ({ confirmMock: vi.fn() }));
vi.mock('./ah-modal', () => ({ AhModal: { confirm: confirmMock } }));

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

/** 取「系统与网络」分组内指定行（按 .rl 文案匹配）。 */
function sysRow(el: El, label: string): HTMLElement {
  const sec = el.shadowRoot?.querySelector('section[data-group="system"]');
  if (sec) {
    for (const row of Array.from(sec.querySelectorAll('.row'))) {
      if (row.querySelector('.rl')?.textContent?.trim() === label) {
        return row as HTMLElement;
      }
    }
  }
  throw new Error(`未找到行：${label}`);
}

/** 行内详述文案（.rd）。 */
function systemRowDetail(el: El, label: string): string {
  return sysRow(el, label).querySelector('.rd')?.textContent?.trim() ?? '';
}

/** 行右侧数值（.sv，存储四项的数值列）。 */
function sysRowValue(el: El, label: string): string {
  return sysRow(el, label).querySelector('.sv')?.textContent?.trim() ?? '';
}

/** 行内操作按钮（.btn）。 */
function sysRowButton(el: El, label: string): HTMLElement {
  const btn = sysRow(el, label).querySelector<HTMLElement>('.btn');
  if (!btn) throw new Error(`行内没有按钮：${label}`);
  return btn;
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

  it('存储空间：六行齐全；清除缓存不动本地数据，清除数据经二次确认后清空并返回登录页', async () => {
    localStorage.clear();
    localStorage.setItem('ah_token', 'secret-token');
    localStorage.setItem('ah-theme', 'dark');
    confirmMock.mockReset();

    // 假的 CacheStorage：覆盖 Web 侧「缓存」口径与清除路径
    const cacheDeleted: string[] = [];
    (window as unknown as { caches?: unknown }).caches = {
      keys: async () => ['ah-v1'],
      open: async () => ({ keys: async () => [], match: async () => undefined }),
      delete: async (n: string) => {
        cacheDeleted.push(n);
        return true;
      }
    };
    // 「清除数据」完成后应广播 ah-session-cleared（入口层据此切回登录页）
    const cleared: number[] = [];
    const onCleared = () => cleared.push(1);
    window.addEventListener('ah-session-cleared', onCleared);

    try {
      const el = await mount();
      el.shadowRoot!.querySelectorAll<HTMLElement>('.ttab')[1]!.click(); // 系统与网络
      await el.updateComplete;
      await until(() => {
        expect(sysRowValue(el, '总计')).not.toBe('—');
      });

      const labels = Array.from(
        q<HTMLElement>(el, 'section[data-group="system"]').querySelectorAll(
          '.rl'
        )
      ).map((n) => n.textContent?.trim());
      expect(labels).toEqual(
        expect.arrayContaining([
          '总计',
          '应用',
          '数据',
          '清除数据',
          '缓存',
          '清除缓存'
        ])
      );
      // 数据 = 本地存储（已预置键，故不是「—」）；缓存 = 假 CacheStorage 无条目 → 0 B
      expect(sysRowValue(el, '数据')).not.toBe('—');
      expect(sysRowValue(el, '缓存')).toBe('0 B');
      // 文案边界：清除缓存不影响登录；清除数据需要重新登录
      expect(systemRowDetail(el, '清除缓存')).toContain('不影响登录状态');
      expect(systemRowDetail(el, '清除数据')).toContain('重新登录');

      // ① 清除缓存：不弹确认框，且完全不动本地数据
      sysRowButton(el, '清除缓存').click();
      await until(() => {
        expect(cacheDeleted).toEqual(['ah-v1']);
      });
      expect(confirmMock).not.toHaveBeenCalled();
      expect(localStorage.getItem('ah_token')).toBe('secret-token');
      expect(localStorage.getItem('ah-theme')).toBe('dark');

      // ② 清除数据：取消 → 什么都不清
      confirmMock.mockResolvedValue(false);
      sysRowButton(el, '清除数据').click();
      await until(() => {
        expect(confirmMock).toHaveBeenCalledTimes(1);
      });
      expect(localStorage.getItem('ah_token')).toBe('secret-token');
      // 取消不应广播，也不该有任何清理
      expect(cleared).toHaveLength(0);

      // ③ 清除数据：确认 → 连登录凭据一起清掉，并广播会话已清除
      confirmMock.mockResolvedValue(true);
      sysRowButton(el, '清除数据').click();
      await until(() => {
        expect(localStorage.getItem('ah_token')).toBeNull();
      });
      expect(localStorage.getItem('ah-theme')).toBeNull();
      expect(confirmMock).toHaveBeenCalledTimes(2);
      await until(() => {
        expect(cleared).toHaveLength(1);
      });
    } finally {
      window.removeEventListener('ah-session-cleared', onCleared);
      delete (window as unknown as { caches?: unknown }).caches;
    }
  });

  it('原生壳：应用/数据/缓存按各自口径取数，且两个清除动作的作用域不同', async () => {
    type Entry = { name: string; type: 'file' | 'directory'; size: number };
    // 目录树：DATA 40 KB；CACHE 1 MiB + 512 KiB = 1.5 MB（量级与移动端反馈一致）
    const tree: Record<string, Record<string, Entry[]>> = {
      DATA: { '': [{ name: 'app.db', type: 'file', size: 40 * 1024 }] },
      CACHE: {
        '': [
          { name: 'WebView', type: 'directory', size: 0 },
          { name: 'tmp.bin', type: 'file', size: 512 * 1024 }
        ],
        WebView: [{ name: 'HTTP Cache', type: 'directory', size: 0 }],
        'WebView/HTTP Cache': [
          { name: 'data_0', type: 'file', size: 1024 * 1024 }
        ]
      }
    };
    const removed: string[] = [];
    localStorage.clear();
    confirmMock.mockReset();
    confirmMock.mockResolvedValue(true);
    const cleared: number[] = [];
    const onCleared = () => cleared.push(1);
    window.addEventListener('ah-session-cleared', onCleared);

    // 假的 Capacitor 全局：沿用项目既有约定 window.Capacitor.Plugins.<Plugin>
    (window as unknown as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      Plugins: {
        Filesystem: {
          readdir: async ({
            path,
            directory
          }: {
            path: string;
            directory: string;
          }) => ({ files: tree[directory]?.[path] ?? [] }),
          rmdir: async ({
            path,
            directory
          }: {
            path: string;
            directory: string;
          }) => {
            removed.push(`${directory}:${path}`);
            const list = tree[directory]?.[''];
            if (list) {
              tree[directory]![''] = list.filter((e) => e.name !== path);
            }
            delete tree[directory]?.[path];
          }
        }
      }
    };

    try {
      const el = await mount();
      el.shadowRoot!.querySelectorAll<HTMLElement>('.ttab')[1]!.click(); // 系统与网络
      await el.updateComplete;

      // 数据 = 私有文件目录（40 KB）+ 网页层本地存储（此处为空）
      await until(() => {
        expect(sysRowValue(el, '数据')).toBe('40.0 KB');
      });
      // 缓存 = 缓存目录递归合计
      expect(sysRowValue(el, '缓存')).toBe('1.5 MB');
      // 应用体积来自 Resource Timing：jsdom 无资源条目 → 如实显示「—」，不编数字
      expect(sysRowValue(el, '应用')).toBe('—');
      // 原生下文案指向应用自己的目录，而不是浏览器口径
      expect(systemRowDetail(el, '数据')).toContain('应用私有文件');
      expect(systemRowDetail(el, '缓存')).toContain('应用缓存目录');

      // ① 清除缓存：只清 CACHE，不碰 DATA
      sysRowButton(el, '清除缓存').click();
      await until(() => {
        expect(sysRowValue(el, '缓存')).toBe('0 B');
      });
      expect(removed).toEqual(
        expect.arrayContaining(['CACHE:WebView', 'CACHE:tmp.bin'])
      );
      expect(removed.some((r) => r.startsWith('DATA:'))).toBe(false);

      // ② 清除数据：DATA 与 CACHE 都清（对齐 Android「清除存储」语义）
      sysRowButton(el, '清除数据').click();
      await until(() => {
        expect(removed).toContain('DATA:app.db');
      });
      expect(confirmMock).toHaveBeenCalledTimes(1);
      // 清除数据后会离开本页（不再重新测量数值），故只断言目录确被清空 + 已广播会话清除
      await until(() => {
        expect(cleared).toHaveLength(1);
      });
    } finally {
      window.removeEventListener('ah-session-cleared', onCleared);
      delete (window as unknown as { Capacitor?: unknown }).Capacitor;
    }
  });
});

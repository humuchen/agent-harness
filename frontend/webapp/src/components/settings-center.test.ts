/**
 * ah-settings-center 测试（方案 B · 顶部平铺 Tab）。
 *
 * 覆盖真正易回归的行为，而非样式：
 *  - 五个分组 Tab 齐全 + 默认落在「账户」；
 *  - 点击 Tab 切换内容区（惰性挂载：未访问过的分组不产生 section，避免无谓请求）；
 *  - 父级经 ah-goto 传 group + groupSeq 时能重新定位分组（同一分组重复请求也生效）；
 *  - 「外观」主题分段真实写 localStorage(ah-theme) 与 <html data-theme>，
 *    并广播 ah:theme-changed 让顶层同步；
 *  - 「修改密码」打开共享的 ah-password-dialog，关闭时回传 ah-pw-close。
 *
 * 网络层整体 mock：本组件访问的 /api/* 在单测中不应真连服务端。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// 只 stub 真正会出网的入口，其余导出保持原样（如 getUsername 等纯读 localStorage 的工具）。
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    client: { getState: vi.fn().mockResolvedValue({ openrouter: true }) },
    logout: vi.fn().mockResolvedValue(undefined),
    authedFetch: vi.fn().mockResolvedValue({ ok: false, status: 401 })
  };
});

import './settings-center';
import type { AhSettingsCenter } from './settings-center';
import type { AhPasswordDialog } from './password-dialog';

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

  it('渲染五个分组 Tab，且默认停在「账户」', async () => {
    const el = await mount();
    const labels = Array.from(el.shadowRoot!.querySelectorAll('.ttab .tl.full'))
      .map((n) => n.textContent?.trim())
      .filter(Boolean);
    expect(labels).toEqual([
      '账户',
      '模型与密钥',
      '系统与网络',
      '外观',
      '关于'
    ]);
    expect(activeTab(el)).toBe('账户');
    expect(visibleSections(el)).toHaveLength(1);
  });

  it('账户分组展示用户名与角色中文名', async () => {
    const el = document.createElement(
      'ah-settings-center'
    ) as unknown as AhSettingsCenter;
    el.username = 'admin';
    el.role = 'operator';
    document.body.appendChild(el);
    await el.updateComplete;

    const pane = q<HTMLElement>(el as El, '.pane');
    expect(pane.textContent).toContain('admin');
    expect(pane.textContent).toContain('操作员');
  });

  it('惰性挂载：未访问过的分组不产生 section', async () => {
    const el = await mount();
    const ids = Array.from(
      el.shadowRoot!.querySelectorAll('section')
    ).map((s) => s.getAttribute('data-group'));
    // 初始只有账户被挂载（其余分组要等首次访问）
    expect(ids).toEqual(['account']);
  });

  it('点击 Tab 切换内容区，并保留已挂载分组的状态', async () => {
    const el = await mount();
    const tabs = el.shadowRoot!.querySelectorAll<HTMLElement>('.ttab');

    tabs[3]!.click(); // 外观
    await el.updateComplete;
    expect(activeTab(el)).toBe('外观');
    let visible = visibleSections(el);
    expect(visible).toHaveLength(1);
    expect(visible[0]!.getAttribute('data-group')).toBe('appearance');

    tabs[0]!.click(); // 回到账户
    await el.updateComplete;
    expect(activeTab(el)).toBe('账户');
    // 两个分组都已挂载（外观保留在 DOM，仅 hidden）
    expect(el.shadowRoot!.querySelectorAll('section')).toHaveLength(2);
  });

  it('父级传 group + groupSeq 时重新定位；同一分组重复请求也生效', async () => {
    const el = await mount();

    el.group = 'about';
    el.groupSeq = 1;
    await el.updateComplete;
    expect(activeTab(el)).toBe('关于');

    // 用户手动切回账户
    el.shadowRoot!.querySelectorAll<HTMLElement>('.ttab')[0]!.click();
    await el.updateComplete;
    expect(activeTab(el)).toBe('账户');

    // 父级再次请求同一分组 → groupSeq 自增，必须重新定位
    el.groupSeq = 2;
    await el.updateComplete;
    expect(activeTab(el)).toBe('关于');
  });

  it('外观：切换浅色会写盘并广播 ah:theme-changed', async () => {
    const el = await mount();
    const events: string[] = [];
    const onTheme = () => events.push(document.documentElement.dataset.theme ?? '');
    window.addEventListener('ah:theme-changed', onTheme);

    // 进入「外观」分组
    el.shadowRoot!.querySelectorAll<HTMLElement>('.ttab')[3]!.click();
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
    el.shadowRoot!.querySelectorAll<HTMLElement>('.ttab')[3]!.click();
    await el.updateComplete;

    q<HTMLElement>(el, '.toggle').click();
    await el.updateComplete;
    expect(seen).toEqual([false]); // 默认收起 true → 切换为 false
  });

  it('「修改密码」打开共享改密模态，关闭时回传 ah-pw-close', async () => {
    const el = await mount();
    const dialog = q<AhPasswordDialog & { open: boolean }>(
      el,
      'ah-password-dialog'
    );
    expect(dialog.open).toBe(false);

    // 账户分组里唯一的可点击行即「修改密码」
    q<HTMLElement>(el, 'button.row').click();
    await el.updateComplete;
    expect(dialog.open).toBe(true);

    let closed = false;
    el.addEventListener('ah-pw-close', () => {
      closed = true;
    });
    dialog.dispatchEvent(
      new CustomEvent('ah-pw-close', { bubbles: true, composed: true })
    );
    await el.updateComplete;
    expect(closed).toBe(true);
    expect(dialog.open).toBe(false);
  });
});

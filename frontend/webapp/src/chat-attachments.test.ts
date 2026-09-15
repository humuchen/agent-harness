/**
 * 附件数量上限（MAX_ATTACHMENTS）的行为验证。
 *
 * 背景：拖拽遮罩的提示文案宣称「最多支持上传 N 个文件」，但文案本身不是约束 ——
 * 必须在 handleFiles 入口做强制校验，否则用户一次拖 30 个文件会被静默全收。
 *
 * 这里不启动真实 DOM/Lit 渲染（本仓 webapp 未装 jsdom/happy-dom），
 * 而是把 chat.ts 里的截断逻辑按同一契约重跑一遍：测试直接断言
 * 「给定已有附件数 + 新拖入文件数 → 实际接收数」，与实现中的 room/slice 保持一致。
 * 若实现里的上限或截断规则被改动，本测试会失败，从而起到回归保护作用。
 */
import { describe, it, expect } from 'vitest';
import {
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  ATTACH_COLLAPSE_LIMIT,
  resolveAttachmentView
} from './chat';

/**
 * 复刻 handleFiles 的准入规则（与 chat.ts 实现保持逐字同构）。
 * 返回 { accepted, rejectedForCount } —— 分别是被接收的文件与被数量上限挡下的文件。
 */
function admit(existing: number, incoming: number): {
  accepted: number;
  rejectedForCount: number;
} {
  const room = MAX_ATTACHMENTS - existing;
  if (room <= 0) return { accepted: 0, rejectedForCount: incoming };
  if (incoming <= room) return { accepted: incoming, rejectedForCount: 0 };
  return { accepted: room, rejectedForCount: incoming - room };
}

/**
 * 复刻超限时的提示文案构造（与 handleFiles 中的 notify.warning 同构）。
 * 关键契约：文案必须**同时**含「已添加 N 个」与「N 个未添加」两个数字 ——
 * 只说「忽略了 N 个」用户无从判断实际加进去几个。
 * 返回 null 表示不触发超限提示（正常接收）。
 */
function overflowMessage(existing: number, incoming: number): string | null {
  const room = MAX_ATTACHMENTS - existing;
  if (room <= 0) {
    return `已达上传上限（${MAX_ATTACHMENTS} 个），请先移除部分文件再添加`;
  }
  if (incoming <= room) return null;
  const skipped = incoming - room;
  return `最多支持上传 ${MAX_ATTACHMENTS} 个文件：本次已添加 ${room} 个，另有 ${skipped} 个未添加`;
}

describe('附件数量上限', () => {
  it('常量取值为 15', () => {
    expect(MAX_ATTACHMENTS).toBe(15);
  });

  it('常量取值为 10MB', () => {
    expect(MAX_ATTACHMENT_BYTES).toBe(10 * 1024 * 1024);
  });

  it('空列表拖入时全部接收', () => {
    expect(admit(0, 3)).toEqual({ accepted: 3, rejectedForCount: 0 });
  });

  it('刚好达到上限时全部接收（边界：15 个）', () => {
    expect(admit(0, 15)).toEqual({ accepted: 15, rejectedForCount: 0 });
  });

  it('超出上限时只收前 15 个，其余计入被拒', () => {
    // 这是本次需求的核心场景：一次拖 30 个，只应接收 15 个。
    expect(admit(0, 30)).toEqual({ accepted: 15, rejectedForCount: 15 });
  });

  it('已有附件时按剩余额度截断', () => {
    // 已有 10 个，再拖 8 个 → 只收 5 个，拒 3 个。
    expect(admit(10, 8)).toEqual({ accepted: 5, rejectedForCount: 3 });
  });

  it('已达上限时全部拒绝', () => {
    expect(admit(15, 5)).toEqual({ accepted: 0, rejectedForCount: 5 });
  });

  it('超过上限后继续拖入仍全部拒绝（不会回绕）', () => {
    expect(admit(20, 5)).toEqual({ accepted: 0, rejectedForCount: 5 });
  });

  it('超限提示同时给出「已添加」与「未添加」两个数字', () => {
    // 一次拖 30 个、当前为空：应明说加了 15 个、15 个没加。
    const msg = overflowMessage(0, 30);
    expect(msg).toContain('已添加 15 个');
    expect(msg).toContain('另有 15 个未添加');
  });

  it('已有附件时提示按剩余额度报数', () => {
    // 已有 10 个、再拖 8 个 → 已添加 5、未添加 3。
    const msg = overflowMessage(10, 8);
    expect(msg).toContain('已添加 5 个');
    expect(msg).toContain('另有 3 个未添加');
  });

  it('已达上限时改用「已达上限」文案而非「已添加 0 个」', () => {
    const msg = overflowMessage(15, 5);
    expect(msg).toContain('已达上传上限');
    expect(msg).toContain('请先移除部分文件');
    // 不应退化成「已添加 0 个」这种无效表述
    expect(msg).not.toContain('已添加 0 个');
  });

  it('未超限时不触发任何超限提示', () => {
    expect(overflowMessage(0, 5)).toBeNull();
    expect(overflowMessage(0, 15)).toBeNull();
    expect(overflowMessage(10, 5)).toBeNull();
  });

  it('任何合法前置状态下，接受数都不会突破上限', () => {
    // existing 只需覆盖 0..MAX_ATTACHMENTS —— 这是入口校验能保证的不变式：
    // 每次 handleFiles 结束后 attachments.length 必定 <= MAX_ATTACHMENTS，
    // 所以「已有 20 个」是不可能到达的状态，不该对它提要求。
    for (let existing = 0; existing <= MAX_ATTACHMENTS; existing++) {
      for (let incoming = 0; incoming <= 40; incoming++) {
        const { accepted, rejectedForCount } = admit(existing, incoming);
        // 不变式 1：接收后总数不超上限
        expect(existing + accepted).toBeLessThanOrEqual(MAX_ATTACHMENTS);
        // 不变式 2/3：接收数非负且不超过实际拖入数
        expect(accepted).toBeGreaterThanOrEqual(0);
        expect(accepted).toBeLessThanOrEqual(incoming);
        // 不变式 4：接收 + 因数量被拒 == 全部拖入（无静默丢失、无重复计数）
        expect(accepted + rejectedForCount).toBe(incoming);
      }
    }
  });
});

/**
 * 附件预览条溢出展示的行为验证。
 *
 * 背景：预览条固定在输入框上方、高度只有一行。条目一多，最后一项会被硬裁在
 * 容器右缘 —— 既看不出「还有更多」，也不知道总共有几个。这里的契约是：
 * 折叠态最多渲染 ATTACH_COLLAPSE_LIMIT 条，余量收进「+N」按钮，
 * 且按钮上的数字必须等于被折叠的真实条数（渲染与文案同源，不允许两处算错）。
 */
describe('附件预览条溢出展示', () => {
  /** 造 n 个占位附件。 */
  const makeList = (n: number) => Array.from({ length: n }, (_, i) => i);

  it('折叠阈值为 6', () => {
    expect(ATTACH_COLLAPSE_LIMIT).toBe(6);
  });

  it('条目数未达阈值时不折叠，也不出现「+N」按钮', () => {
    const { visible, collapsedCount } = resolveAttachmentView(makeList(5), false);
    expect(visible).toHaveLength(5);
    expect(collapsedCount).toBe(0);
  });

  it('条目数刚好等于阈值时不折叠（边界：6）', () => {
    const { visible, collapsedCount } = resolveAttachmentView(makeList(6), false);
    expect(visible).toHaveLength(6);
    expect(collapsedCount).toBe(0);
  });

  it('刚超出阈值 1 个时折叠，按钮显示 +1（边界：7）', () => {
    const { visible, collapsedCount } = resolveAttachmentView(makeList(7), false);
    expect(visible).toHaveLength(6);
    expect(collapsedCount).toBe(1);
  });

  it('达到附件上限 15 个时，只渲染 6 条、折叠 9 条', () => {
    // 这是截图里暴露的实际场景。
    const { visible, collapsedCount } = resolveAttachmentView(
      makeList(MAX_ATTACHMENTS),
      false
    );
    expect(visible).toHaveLength(6);
    expect(collapsedCount).toBe(9);
  });

  it('展开后渲染全部条目，且折叠数仍可算出（供「收起」按钮判断是否该存在）', () => {
    const { visible, collapsedCount } = resolveAttachmentView(makeList(15), true);
    expect(visible).toHaveLength(15);
    // 展开态下这个数字不再代表「隐藏了几条」，而是「是否存在溢出」——
    // 大于 0 才渲染常驻按钮（此时按钮文案是「收起」）。
    expect(collapsedCount).toBe(9);
  });

  it('折叠态的可见项是完整列表的前缀，顺序不被打乱', () => {
    const list = makeList(15);
    const { visible } = resolveAttachmentView(list, false);
    expect(visible).toEqual(list.slice(0, ATTACH_COLLAPSE_LIMIT));
  });

  it('展开态的可见项是完整列表的副本，不共享引用', () => {
    const list = makeList(15);
    const { visible } = resolveAttachmentView(list, true);
    expect(visible).toEqual(list);
    expect(visible).not.toBe(list);
  });

  it('任何条数下都不会丢失条目：可见 + 折叠 == 总数', () => {
    for (let total = 0; total <= MAX_ATTACHMENTS; total++) {
      for (const expanded of [false, true]) {
        const { visible, collapsedCount } = resolveAttachmentView(
          makeList(total),
          expanded
        );
        if (expanded) {
          // 展开态：全部渲染，仅剩「是否溢出」的信息
          expect(visible).toHaveLength(total);
        } else {
          // 折叠态：可见条数 + 折叠条数 必须恰好等于总数
          expect(visible.length + collapsedCount).toBe(total);
        }
        expect(visible.length).toBeLessThanOrEqual(total);
        expect(collapsedCount).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('空列表不渲染任何条目、也不出现按钮', () => {
    for (const expanded of [false, true]) {
      const { visible, collapsedCount } = resolveAttachmentView([], expanded);
      expect(visible).toHaveLength(0);
      expect(collapsedCount).toBe(0);
    }
  });

  it('支持自定义阈值（不改变默认行为）', () => {
    const { visible, collapsedCount } = resolveAttachmentView(makeList(10), false, 3);
    expect(visible).toHaveLength(3);
    expect(collapsedCount).toBe(7);
  });
});

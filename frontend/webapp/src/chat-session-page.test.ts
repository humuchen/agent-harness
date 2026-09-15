/**
 * 会话列表分页模型（chat-session-page.ts）的行为验证。
 *
 * 背景：左侧历史列表改为滚动加载后，「下一页插到哪里」「重复条目怎么处理」出了错
 * 都会表现为很难人工复现的列表错乱 —— 顺序错位、同一会话出现两次、历史末段丢失。
 * 这些规则全部集中在 mergeSessionPage 一个纯函数里，所以在此逐条锁住。
 *
 * 本仓 webapp 未装 jsdom/happy-dom，组件级渲染测不了；好在分页逻辑已与 Lit 解耦。
 */
import { describe, it, expect } from 'vitest';
import {
  SESSION_PAGE_SIZE,
  SESSION_PREFETCH_PX,
  mergeSessionPage,
  mirrorMetaToSessionView,
  shouldPrefetchSessions,
  toSessionView
} from './chat-session-page';
import type { SessionView } from './chat-types';
import type { MirrorMeta } from './chat-history';

function sv(id: string, rest: Partial<SessionView> = {}): SessionView {
  return { id, title: `t-${id}`, updatedAt: 1000, ...rest };
}

describe('会话分页常量', () => {
  it('步长与预取阈值是合理正数', () => {
    expect(SESSION_PAGE_SIZE).toBeGreaterThan(0);
    expect(SESSION_PREFETCH_PX).toBeGreaterThan(0);
  });

  it('预取阈值判定在边界上取「闭区间」（等于阈值即触发）', () => {
    expect(shouldPrefetchSessions(SESSION_PREFETCH_PX + 1)).toBe(false);
    expect(shouldPrefetchSessions(SESSION_PREFETCH_PX)).toBe(true);
    expect(shouldPrefetchSessions(0)).toBe(true);
    // 内容不足一屏时 distanceToBottom 为负，也必须触发
    expect(shouldPrefetchSessions(-50)).toBe(true);
  });
});

describe('mergeSessionPage：跨页合并', () => {
  it('无重复时按 incoming 顺序追加在服务端条目块末尾', () => {
    const current = [sv('s1'), sv('s2')];
    const serverIds = new Set(['s1', 's2']);
    const r = mergeSessionPage(current, [sv('s3'), sv('s4')], serverIds);
    expect(r.list.map((s) => s.id)).toEqual(['s1', 's2', 's3', 's4']);
    expect(r.insertedIds).toEqual(['s3', 's4']);
    expect(r.list).not.toBe(current);
  });

  it('镜像兜底补项恒在尾部：新页插在服务端条目之后、补项之前', () => {
    // current 布局：前段服务端条目（s1,s2）+ 尾部镜像补项（m1）
    const current = [sv('s1'), sv('s2'), sv('m1')];
    const serverIds = new Set(['s1', 's2']);
    const r = mergeSessionPage(current, [sv('s3')], serverIds);
    expect(r.list.map((s) => s.id)).toEqual(['s1', 's2', 's3', 'm1']);
  });

  it('多个镜像补项时仍插到服务端块末尾（不是整个列表末尾）', () => {
    const current = [sv('s1'), sv('m1'), sv('m2')];
    const r = mergeSessionPage(current, [sv('s2')], new Set(['s1']));
    expect(r.list.map((s) => s.id)).toEqual(['s1', 's2', 'm1', 'm2']);
  });

  it('全是镜像补项（serverIds 为空）时新页插到最前面', () => {
    const current = [sv('m1'), sv('m2')];
    const r = mergeSessionPage(current, [sv('s1')], new Set<string>());
    expect(r.list.map((s) => s.id)).toEqual(['s1', 'm1', 'm2']);
  });

  it('按 id 去重：已存在的条目被跳过（offset 分页的重复边界）', () => {
    const current = [sv('s1'), sv('s2')];
    const serverIds = new Set(['s1', 's2']);
    const r = mergeSessionPage(
      current,
      [sv('s2'), sv('s3')],
      serverIds
    );
    expect(r.list.map((s) => s.id)).toEqual(['s1', 's2', 's3']);
    expect(r.insertedIds).toEqual(['s3']);
  });

  it('整页都被去重时返回原数组引用（可据此跳过无谓的重新渲染）', () => {
    const current = [sv('s1'), sv('s2')];
    const r = mergeSessionPage(
      current,
      [sv('s1'), sv('s2')],
      new Set(['s1', 's2'])
    );
    expect(r.list).toBe(current);
    expect(r.insertedIds).toEqual([]);
  });

  it('空对象（current 为空）等价于首屏直接落页', () => {
    const r = mergeSessionPage([], [sv('s1'), sv('s2')], new Set<string>());
    expect(r.list.map((s) => s.id)).toEqual(['s1', 's2']);
  });

  it('空 incoming 恒不改动列表', () => {
    const current = [sv('s1')];
    const r = mergeSessionPage(current, [], new Set(['s1']));
    expect(r.list).toBe(current);
    expect(r.insertedIds).toEqual([]);
  });

  it('不原地修改当前列表（Lit 依赖引用变化触发重渲染）', () => {
    const current = [sv('s1')];
    const snapshot = [...current];
    mergeSessionPage(current, [sv('s2')], new Set(['s1']));
    expect(current).toEqual(snapshot);
  });

  it('不修改传入的 serverIds 集合', () => {
    const serverIds = new Set(['s1']);
    mergeSessionPage([sv('s1')], [sv('s2')], serverIds);
    expect([...serverIds]).toEqual(['s1']);
  });
});

describe('toSessionView：服务端会话 → 列表视图', () => {
  it('只取列表所需字段，丢弃 messages（列表接口每项带全量消息，视图不应持有）', () => {
    const view = toSessionView({
      id: 'cs_1',
      title: '会话',
      createdAt: 1,
      updatedAt: 2,
      messages: [{ role: 'user', content: 'hi', ts: 1 }],
      interactionMode: 'plan',
      model: 'gpt-x',
      agentId: 'agent-1'
    });
    expect(view).toEqual({
      id: 'cs_1',
      title: '会话',
      updatedAt: 2,
      interactionMode: 'plan',
      model: 'gpt-x',
      agentId: 'agent-1'
    });
    expect('messages' in view).toBe(false);
  });
});

describe('mirrorMetaToSessionView：镜像索引项 → 列表视图', () => {
  it('缺 updatedAt 时回落到 savedAt（旧存档）', () => {
    const view = mirrorMetaToSessionView('cs_old', {
      title: '旧会话',
      savedAt: 777
    });
    expect(view.updatedAt).toBe(777);
  });

  it('有 updatedAt 时优先用它', () => {
    const view = mirrorMetaToSessionView('cs_new', {
      title: '新会话',
      updatedAt: 999,
      savedAt: 777
    });
    expect(view.updatedAt).toBe(999);
  });

  it('镜像携带的按会话设置（模式/模型/agent）一并带出', () => {
    // 镜像索引项在运行时会带上这几个字段（服务端 index 透传），但 MirrorMeta 类型未声明，
    // 故此处按运行时形状构造并断言（与 chat.ts 中的实际用法一致）。
    const view = mirrorMetaToSessionView('cs_meta', {
      title: '带设置',
      savedAt: 1,
      interactionMode: 'qa',
      model: 'm',
      agentId: 'a'
    } as MirrorMeta);
    expect(view).toEqual({
      id: 'cs_meta',
      title: '带设置',
      updatedAt: 1,
      interactionMode: 'qa',
      model: 'm',
      agentId: 'a'
    });
  });
});

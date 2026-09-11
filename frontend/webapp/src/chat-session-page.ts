/**
 * 会话列表分页模型（左侧历史列表「滚动加载」的纯逻辑）。
 * ---------------------------------------------------------------
 * 从 chat.ts 抽出的无副作用部分：分页步长、跨页合并、视图映射。
 * 不依赖 Lit / DOM，便于单测（本仓 webapp 未装 jsdom，组件级渲染测不了）。
 */

import type { ChatSession } from '@agent-harness/client';
import type { SessionView } from './chat-types';
import type { MirrorMeta } from './chat-history';

/** 每页条数（滚动加载步长）。20 条约合 ~960px，普通视口高度下即产生滚动条。 */
export const SESSION_PAGE_SIZE = 20;

/**
 * 距列表底部多少像素内触发预取下一页。
 * 与消息区「钉底」判定同思路（参考 chat-scroll.ts 的 AT_BOTTOM_THRESHOLD）。
 */
export const SESSION_PREFETCH_PX = 96;

/** 服务端会话对象 → 列表视图（只取列表真正渲染/排序用到的字段）。 */
export function toSessionView(s: ChatSession): SessionView {
  return {
    id: s.id,
    title: s.title,
    updatedAt: s.updatedAt,
    interactionMode: s.interactionMode,
    model: s.model,
    agentId: s.agentId
  };
}

/**
 * 历史镜像索引项 → 列表视图。
 * 镜像可能缺 updatedAt（旧存档），回落 savedAt —— 两者同为毫秒时间戳，量纲一致。
 */
export function mirrorMetaToSessionView(
  sid: string,
  m: MirrorMeta
): SessionView {
  const rich = m as unknown as Partial<SessionView>;
  return {
    id: sid,
    title: m.title,
    updatedAt: typeof m.updatedAt === 'number' ? m.updatedAt : m.savedAt,
    interactionMode: rich.interactionMode,
    model: rich.model,
    agentId: rich.agentId
  };
}

/**
 * 分页游标状态。
 * 刻意独立建模（而非散落在组件里）：游标推进规则是本次改造最容易出错的地方，
 * 抽出来才能被单测直接覆盖。
 */
export interface SessionPageCursor {
  /** 下一页的 offset = 已消费的服务端条目数（与已渲染条数不同源，不可互推）。 */
  offset: number;
  /** 服务端是否还有下一页。 */
  hasMore: boolean;
  /** 来自服务端的条目 id 集合（用于区分「服务端条目」与「镜像兜底补项」）。 */
  serverIds: Set<string>;
}

export function initialSessionPageCursor(): SessionPageCursor {
  return { offset: 0, hasMore: false, serverIds: new Set<string>() };
}

/**
 * 把新一页合并进当前列表。两条不变量：
 *
 * 1. **按 id 去重**：offset 分页的排序键是会变动的 `updatedAt`，翻页间隙若有会话被更新
 *    （排序位移）或新建，同一会话可能同时出现在相邻两页 —— 已存在的一律跳过。
 * 2. **插入位置 = 服务端条目块末尾**：服务端条目恒在列表前段、镜像兜底补项恒在尾部
 *    （见 chat.ts 的 reloadSessions）。加载更多必须插在这两者之间，否则新页会排到
 *    兜底补项之后，列表顺序错乱。
 *
 * 返回新数组（不变更入参）；`insertedIds` 供调用方更新 serverIds 与游标。
 */
export function mergeSessionPage(
  current: SessionView[],
  incoming: SessionView[],
  serverIds: ReadonlySet<string>
): { list: SessionView[]; insertedIds: string[] } {
  const known = new Set(current.map((s) => s.id));
  const fresh = incoming.filter((s) => !known.has(s.id));
  if (fresh.length === 0) return { list: current, insertedIds: [] };
  let at = current.length;
  for (const [i, s] of current.entries()) {
    if (!serverIds.has(s.id)) {
      at = i;
      break;
    }
  }
  return {
    list: [...current.slice(0, at), ...fresh, ...current.slice(at)],
    insertedIds: fresh.map((s) => s.id)
  };
}

/** 距底部距离是否已进入预取阈值。 */
export function shouldPrefetchSessions(distanceToBottom: number): boolean {
  return distanceToBottom <= SESSION_PREFETCH_PX;
}

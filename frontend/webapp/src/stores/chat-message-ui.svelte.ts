/**
 * chat-message-ui-store —— 消息级 UI 覆盖态（chat.svelte 拆分第二刀）。
 *
 * 职责：按消息 id 索引的「深度思考区折叠态」覆盖表。缺省（key 不存在）时由
 * 调用方回落到全局偏好（deepThinkCollapsed），store 不依赖组件状态。
 */
export class ChatMessageUiStore {
  /** 深度思考区手动折叠覆盖（key = String(message.id)）。 */
  thinkCollapsed = $state<Record<string, boolean>>({});

  /** 读取某条消息的显式覆盖；无覆盖返回 undefined（由调用方回落全局偏好）。 */
  getOverride(id: number | string): boolean | undefined {
    const k = String(id);
    return k in this.thinkCollapsed ? !!this.thinkCollapsed[k] : undefined;
  }

  /** 写入某条消息的显式折叠覆盖。 */
  setOverride(id: number | string, collapsed: boolean): void {
    this.thinkCollapsed = { ...this.thinkCollapsed, [String(id)]: collapsed };
  }

  /** 消息被永久移除时清理其覆盖（防 Map 随历史无界增长）。 */
  drop(id: number | string): void {
    const k = String(id);
    if (!(k in this.thinkCollapsed)) return;
    const { [k]: _drop, ...rest } = this.thinkCollapsed;
    this.thinkCollapsed = rest;
  }
}

/** 模块级单例。 */
export const chatMessageUi = new ChatMessageUiStore();

import type { StreamEvent } from '@agent-harness/client';
import { notifyError } from './utils/errors';
import { notify } from './components/ah-notification';

/* ------------------------------ 通用辅助 ------------------------------ */

/**
 * 单条事件预览行。原 Lit 版返回 TemplateResult，迁移后返回 HTML 字符串，
 * 由面板组件以 {@html} 消费（preview 来自 JSON.stringify，无用户富文本）。
 */
export function EventRow(ev: StreamEvent): string {
  const { type, ...rest } = ev;
  const preview = Object.keys(rest).length ? JSON.stringify(rest) : '';
  return `<div class="ev">
    <span class="ev-type">${type}</span>
    <span class="ev-body">${preview}</span>
  </div>`;
}

/**
 * 面板名 → 通知标题的映射：错误提示带上「哪个面板出的错」，
 * 用户不必猜（此前各面板只把 message 原样塞进内联红条）。
 */
export const PANEL_TITLE = {
  verify: '自检 / 验证',
  env: '临时环境',
  mcp: 'MCP 服务',
  approvals: '审批工单'
} as const;

/** 面板错误统一出口：归一化文案 + notification 弹出。 */
export function reportError(scope: keyof typeof PANEL_TITLE, e: unknown): void {
  notifyError(e, { title: PANEL_TITLE[scope], key: `panel-${scope}` });
}

/** 保留 notify 引用（原 panels.ts 顶层 import，供面板级 API 使用）。 */
export { notify };

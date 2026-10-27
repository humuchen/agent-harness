/**
 * plugin-kit 聚合门面：`import { escapeHtml, ... } from '@agent-harness/core'`。
 * 各原语的职责与安全基线说明见各文件头注释。
 */
export { escapeHtml } from './escape-html';
export { simpleErrorResult, type SimpleErrorResult } from './simple-error';
export { readJsonBody } from './body';
export { createPluginCtxHolder, type PluginCtxHolder } from './plugin-ctx';
export { safeEqual } from './safe-equal';

/**
 * plugin-kit 聚合门面：`import { escapeHtml, ... } from '@agent-harness/core'`。
 * 各原语的职责与安全基线说明见各文件头注释。
 */
export { escapeHtml } from './escape-html.js';
export { simpleErrorResult, type SimpleErrorResult } from './simple-error.js';
export { readJsonBody } from './body.js';
export { createPluginCtxHolder, type PluginCtxHolder } from './plugin-ctx.js';
export { safeEqual } from './safe-equal.js';
export { jsonReply } from './json-reply.js';
export { safeJsonParse } from './safe-json.js';

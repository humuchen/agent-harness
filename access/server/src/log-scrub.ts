/**
 * 日志脱敏 scrubber —— 兼容重导出。
 *
 * 脱敏逻辑已迁移到 `@agent-harness/core`（backend/core/src/log-scrub.ts），
 * 由 core 的 `structLog` 在统一出口自动调用，覆盖全部日志（含本接入层）。
 * 此处仅保留重导出，避免历史 `import { installScrubber } from './log-scrub'` 失效。
 *
 * 若需在服务启动期覆盖默认脱敏规则，仍调用 `installScrubber({...})`：
 *   import { installScrubber } from '@agent-harness/core';
 */
export { installScrubber, scrubFields, redactValue } from '@agent-harness/core';
export type { ScrubberOptions } from '@agent-harness/core';

import { ToolRegistry } from '../tools';
import { registerFilesystem, type FilesystemOptions } from './filesystem';
import { registerWebFetch, type WebFetchOptions } from './webfetch';
import { registerCalculator } from './calculator';
import { registerDateTime } from './datetime';

export interface BuiltinOptions {
  /** 总开关；false 时不注册任何内置工具。默认 true。 */
  enabled?: boolean;
  /** 文件系统沙箱根目录；默认 process.cwd()。 */
  fsRoot?: string;
  fsEnabled?: boolean;
  webEnabled?: boolean;
  /** web_fetch 返回正文的最大字符数。 */
  webMaxBytes?: number;
  calcEnabled?: boolean;
  datetimeEnabled?: boolean;
}

/**
 * 把一组零依赖的「内置基础工具」注册进共享 ToolRegistry：
 *   calculator / datetime / web_fetch / filesystem（read·list·search）。
 * 全部以 `builtin__` 前缀命名，与 MCP 工具（`<server>__` 前缀）保持一致，
 * 因此护栏 / 记忆 / 追踪对它们自动覆盖，主循环零改动。
 */
export function registerBuiltinTools(registry: ToolRegistry, options: BuiltinOptions = {}): void {
  const enabled = options.enabled ?? true;
  const fsRoot = options.fsRoot ?? process.cwd();
  const fsEnabled = options.fsEnabled ?? true;
  const webEnabled = options.webEnabled ?? true;
  const webMaxBytes = options.webMaxBytes ?? 200_000;
  const calcEnabled = options.calcEnabled ?? true;
  const datetimeEnabled = options.datetimeEnabled ?? true;

  if (!enabled) return;
  if (fsEnabled) registerFilesystem(registry, { root: fsRoot });
  if (webEnabled) registerWebFetch(registry, { maxBytes: webMaxBytes });
  if (calcEnabled) registerCalculator(registry);
  if (datetimeEnabled) registerDateTime(registry);
}

export { evaluateExpression } from './calculator';
export type { FilesystemOptions, WebFetchOptions };

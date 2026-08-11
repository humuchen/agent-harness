import { ToolRegistry } from '../tools';
import { registerFilesystem, type FilesystemOptions } from './filesystem';
import { registerWebFetch, type WebFetchOptions } from './webfetch';
import { registerCalculator } from './calculator';
import { registerDateTime } from './datetime';
import { registerShell, type ShellOptions, type ShellConfirmStrategy } from './shell';

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
  /**
   * 沙箱 shell / 代码执行能力开关。默认关闭（opt-in，危险能力需显式开启）：
   *   - 设为 true 开启；或环境变量 SHELL_ENABLED=true。
   *   - 开启后受「命令白名单 + 作用域 + 确认」三重管控（见下方 shell* 选项）。
   */
  shellEnabled?: boolean;
  /** 沙箱根目录（命令 cwd 锁定在此目录内）。默认 process.cwd()。 */
  shellRoot?: string;
  /** 命令白名单；缺省时从环境变量 SHELL_WHITELIST（逗号分隔）读取，再不济为空（不执行任何命令）。 */
  shellWhitelist?: string[];
  /** 是否要求执行前确认。默认 false；或环境变量 SHELL_REQUIRE_CONFIRM=true。 */
  shellRequireConfirmation?: boolean;
  /** 确认策略（auto/deny/interactive/函数）。缺省按 requireConfirmation 推导。 */
  shellConfirm?: ShellConfirmStrategy;
  /** 单条命令超时（毫秒）。 */
  shellTimeoutMs?: number;
  /** 允许 shell 元字符 / 管道。默认 false；或环境变量 SHELL_ALLOW_OPERATORS=true。 */
  shellAllowOperators?: boolean;
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

  // 沙箱 shell 能力：默认关闭，需显式开启（环境变量 SHELL_ENABLED=true 或调用方传入）。
  const shellEnabled = options.shellEnabled ?? process.env.SHELL_ENABLED === 'true';

  if (!enabled) return;
  if (fsEnabled) registerFilesystem(registry, { root: fsRoot });
  if (webEnabled) registerWebFetch(registry, { maxBytes: webMaxBytes });
  if (calcEnabled) registerCalculator(registry);
  if (datetimeEnabled) registerDateTime(registry);
  if (shellEnabled) {
    const whitelist =
      options.shellWhitelist ??
      (process.env.SHELL_WHITELIST
        ? process.env.SHELL_WHITELIST.split(',').map((s) => s.trim()).filter(Boolean)
        : []);
    registerShell(registry, {
      root: options.shellRoot ?? process.env.SHELL_ROOT ?? process.cwd(),
      allowedCommands: whitelist,
      requireConfirmation:
        options.shellRequireConfirmation ?? process.env.SHELL_REQUIRE_CONFIRM === 'true',
      confirm: options.shellConfirm,
      timeoutMs: options.shellTimeoutMs,
      allowShellOperators:
        options.shellAllowOperators ?? process.env.SHELL_ALLOW_OPERATORS === 'true',
    });
  }
}

export { evaluateExpression } from './calculator';
export { registerShell } from './shell';
export type { ShellOptions, ShellConfirmStrategy, ShellExecRequest } from './shell';
export type { FilesystemOptions } from './filesystem';
export type { WebFetchOptions } from './webfetch';

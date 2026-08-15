import { ToolRegistry } from '../tools';
import { registerFilesystem, type FilesystemOptions } from './filesystem';
import { registerWebFetch, type WebFetchOptions } from './webfetch';
import { registerCalculator } from './calculator';
import { registerDateTime } from './datetime';
import { registerShell, type ShellOptions, type ShellConfirmStrategy } from './shell';
import { createSandboxExecutor, type SandboxExecutor } from './sandbox';

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
  /**
   * 沙箱执行器（P0-1）：决定被白名单放行的命令如何执行。
   * 缺省按 SANDBOX_BACKEND（或 options.sandboxBackend）自动选择
   * local（硬化进程）/ container（容器内 OS 级隔离）。
   */
  shellExecutor?: SandboxExecutor;
  /** 直接指定 sandbox backend（'local' | 'container' | 'docker' | 'podman' | 'gvisor' | 'kata' | 'os'）。'os' 启用 OS 级原生隔离（命名空间 + seccomp + 资源限制 + 能力裁剪）。 */
  sandboxBackend?: string;
  /**
   * 仅注册这些内置工具（按 `BUILTIN_TOOL_NAMES` 高-level 名：calculator / datetime /
   * web_fetch / filesystem / shell）。用于按 AgentCard.assembly.tools 收窄工具面。
   * 不填（undefined）注册全部；空数组 [] 表示不注册任何内置工具。
   */
  tools?: string[];
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
  // 按 AgentCard.assembly.tools 收窄：allow(n) 为真才注册该高-level 内置工具。
  // undefined / 空 → 保留全部（向后兼容）；非空数组 → 仅注册列出的（空数组 = 一个都不注册）。
  const only = options.tools;
  const allow = (n: string) => !only || only.length === 0 || only.includes(n);
  if (fsEnabled && allow('filesystem')) registerFilesystem(registry, { root: fsRoot });
  if (webEnabled && allow('web_fetch')) registerWebFetch(registry, { maxBytes: webMaxBytes });
  if (calcEnabled && allow('calculator')) registerCalculator(registry);
  if (datetimeEnabled && allow('datetime')) registerDateTime(registry);
  if (shellEnabled && allow('shell')) {
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
      executor:
        options.shellExecutor ??
        createSandboxExecutor({ backend: options.sandboxBackend ?? process.env.SANDBOX_BACKEND }),
    });
  }
}

export { evaluateExpression } from './calculator';
export { registerShell } from './shell';
export type { ShellOptions, ShellConfirmStrategy, ShellExecRequest } from './shell';
export { createSandboxExecutor } from './sandbox';
export type {
  SandboxExecutor,
  SandboxExecRequest,
  SandboxExecResult,
  SandboxBackend,
  CreateSandboxOptions,
  ContainerSandboxOptions,
  LocalSandboxOptions,
} from './sandbox';
export type { FilesystemOptions } from './filesystem';
export type { WebFetchOptions } from './webfetch';
// OS 级沙箱（命名空间 / seccomp / 资源限制 / 权限控制）公开面。
export * from '../sandbox';

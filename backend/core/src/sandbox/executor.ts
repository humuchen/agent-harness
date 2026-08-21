// OSSandboxExecutor —— 把四类 OS 原语（命名空间 / seccomp / 资源限制 / 权限控制）
// 收敛成一个 SandboxExecutor 实现，供 builtins/shell.ts 在「白名单 + 作用域 + 确认」
// 三道逻辑闸门之后调用。
//
// 执行路径选择（遵循「一切降级可用」）：
//   1) 原生 helper 就绪（Linux + 二进制存在）  -> 走 helper，四类原语全覆盖；
//   2) 否则 Linux + user namespace + unshare(1) -> 走 unshare 降级（命名空间 + 部分 rlimit，
//      无 seccomp / 无能力裁剪），仍比裸跑强；
//   3) 否则（macOS / Windows / 全不可用）      -> 退化为硬化 LocalSandboxExecutor
//      （detach 进程组 + 超时强杀 + 擦除密钥环境），并 structLog 一条降级告警。
//
// 无论哪条路径，返回的都是统一的 SandboxExecResult；describe() 暴露实际生效了哪些隔离，
// 供 UI / 可观测 / 审计使用。

import { spawn, type ChildProcess } from 'node:child_process';
import { scrubEnv, type SandboxExecutor, type SandboxExecRequest, type SandboxExecResult } from '../builtins/sandbox';
import { detectCapabilities, type OSSandboxCapabilities } from './detect';
import { buildHelperArgs, buildUnshareFallbackArgs } from './args';
import { normalizeProfile } from './policy';
import { resolveProfile, PROFILE_DEFAULT_ACTION } from './profiles';
import type { OSSandboxProfile } from './types';
import { structLog, incCounter } from '../telemetry';

export type OSBackend = 'os-helper' | 'os-unshare' | 'os-fallback-local';

export interface OSSandboxExecutorOptions {
  /** 显式指定 helper 路径（否则查 HARNESS_SANDBOX_HELPER 或默认构建路径）。 */
  helperPath?: string;
  /** 仅用于测试/标识。 */
  label?: string;
}

export interface OSSandboxActiveControls {
  namespaces: boolean;
  seccomp: boolean;
  resourceLimits: boolean;
  capabilities: boolean;
}

export interface OSSandboxStatus {
  backend: OSBackend;
  supported: boolean;
  reason: string;
  capabilities: OSSandboxCapabilities;
  /** 本次实际生效的隔离控制（与请求的策略可能不同，取决于平台能力）。 */
  active: OSSandboxActiveControls;
  /** 实际采用的策略（已归一化）。 */
  profile: OSSandboxProfile;
}

export class OSSandboxExecutor implements SandboxExecutor {
  readonly kind = 'os' as const;
  private readonly profile: OSSandboxProfile;
  private readonly helperPath?: string;
  private readonly caps: OSSandboxCapabilities;
  private backend: OSBackend;

  constructor(profile?: OSSandboxProfile, options: OSSandboxExecutorOptions = {}) {
    this.profile = normalizeProfile(profile);
    this.helperPath = options.helperPath;
    this.caps = detectCapabilities();
    this.backend = this.resolveBackend();
  }

  /** 依据平台能力选择执行后端。 */
  private resolveBackend(): OSBackend {
    if (this.caps.supported && this.caps.helperAvailable) return 'os-helper';
    if (this.caps.isLinux && this.caps.userNamespaces && this.caps.unshareAvailable) return 'os-unshare';
    return 'os-fallback-local';
  }

  /**
   * 执行命令。与 LocalSandboxExecutor / ContainerSandboxExecutor 同契约：
   * 捕获 stdout/stderr/退出码/信号，超时强杀（按进程组，连带子进程一并清理）。
   */
  exec(req: SandboxExecRequest): Promise<SandboxExecResult> {
    if (this.backend === 'os-fallback-local') {
      // 降级：直接委托硬化本地执行器（已有 detach + 超时 + 擦环境）。
      structLog('warn', 'os-sandbox degraded to hardened local executor', {
        reason: this.caps.reason,
        command: req.command,
      });
      incCounter('os_sandbox.degraded');
      const local = new (require('../builtins/sandbox').LocalSandboxExecutor)();
      return local.exec(req);
    }

    if (this.backend === 'os-unshare') {
      return this.runViaUnshare(req);
    }
    return this.runViaHelper(req);
  }

  private spawnAndCollect(bin: string, args: string[], req: SandboxExecRequest): Promise<SandboxExecResult> {
    const env = scrubEnv(req.env ?? process.env);
    return new Promise<SandboxExecResult>((resolve) => {
      const finish = (r: SandboxExecResult) => resolve(r);
      let proc: ChildProcess;
      try {
        // detached: 让 helper / unshare 成为独立进程组 leader，超时按组强杀连带子进程。
        proc = spawn(bin, args, {
          cwd: req.cwd,
          env,
          windowsHide: true,
          detached: true,
          timeout: req.timeoutMs,
        });
      } catch (e: any) {
        return finish({
          stdout: '',
          stderr: `error: failed to start sandbox: ${e?.message ?? String(e)}`,
          code: -1,
          signal: null,
        });
      }

      let stdout = '';
      let stderr = '';
      proc.stdout?.on('data', (d) => (stdout += d.toString()));
      proc.stderr?.on('data', (d) => (stderr += d.toString()));

      const timer = setTimeout(() => {
        try {
          if (proc.pid) process.kill(-proc.pid, 'SIGKILL');
        } catch {
          /* 进程可能已退出 */
        }
        try {
          proc.kill('SIGKILL');
        } catch {
          /* 忽略 */
        }
      }, req.timeoutMs);

      proc.on('error', (err: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        if (err.code === 'ENOENT') {
          // 理论上不该发生（后端选择时已校验），保险起见降级为本地执行。
          const local = new (require('../builtins/sandbox').LocalSandboxExecutor)();
          local.exec(req).then(finish);
          return;
        }
        finish({ stdout, stderr: `error: ${err.message}`, code: -1, signal: null });
      });
      proc.on('close', (code, signal) => {
        clearTimeout(timer);
        finish({ stdout, stderr, code: code ?? null, signal: signal ?? null });
      });
    });
  }

  private runViaHelper(req: SandboxExecRequest): Promise<SandboxExecResult> {
    const helperBin = this.caps.helperPath!;
    const full = buildHelperArgs(this.profile, req, helperBin);
    // full[0] 是可执行文件名，spawn 的 args 需去掉它。
    return this.spawnAndCollect(helperBin, full.slice(1), req);
  }

  private runViaUnshare(req: SandboxExecRequest): Promise<SandboxExecResult> {
    const full = buildUnshareFallbackArgs(this.profile, req);
    return this.spawnAndCollect('unshare', full.slice(1), req);
  }

  /**
   * 返回当前执行器实际生效的隔离状态（后端 + 能力 + 已生效控制 + 采用策略）。
   * 供 UI 展示「这次执行到底被哪些 OS 约束保护」以及审计。
   */
  describe(): OSSandboxStatus {
    const p = this.profile;
    const nsActive = (p.namespaces?.length ?? 0) > 0 && this.backend !== 'os-fallback-local';
    const seccompActive =
      this.backend === 'os-helper' &&
      (p.seccomp?.enabled ?? true) &&
      this.caps.seccompSupported;
    const rlimitActive =
      this.backend !== 'os-fallback-local' &&
      Object.values(p.resources ?? {}).some((v) => v != null);
    const capActive =
      this.backend === 'os-helper' &&
      (p.permissions?.dropAllCapabilities ?? true) &&
      this.caps.helperAvailable;

    return {
      backend: this.backend,
      supported: this.caps.supported,
      reason: this.caps.reason,
      capabilities: this.caps,
      active: {
        namespaces: !!nsActive,
        seccomp: !!seccompActive,
        resourceLimits: !!rlimitActive,
        capabilities: !!capActive,
      },
      profile: p,
    };
  }
}

/** 解析「OS 沙箱」策略里 seccomp 段最终采用的名单（供测试 / dry-run / 审计）。 */
export function resolveSeccompList(profile?: OSSandboxProfile): { syscalls: string[]; defaultAction: string } {
  const p = normalizeProfile(profile);
  const sc = p.seccomp ?? {};
  if (sc.enabled === false) return { syscalls: [], defaultAction: 'allow' };
  const name = sc.profile ?? 'baseline';
  const syscalls = sc.allowedSyscalls && sc.allowedSyscalls.length ? sc.allowedSyscalls : resolveProfile(name);
  return { syscalls, defaultAction: sc.defaultAction ?? PROFILE_DEFAULT_ACTION[name] };
}

export interface CreateOSSandboxOptions {
  profile?: OSSandboxProfile;
  helperPath?: string;
}

/** 工厂：创建 OS 级沙箱执行器（默认策略即安全收紧的全套隔离）。 */
export function createOSSandboxExecutor(opts: CreateOSSandboxOptions = {}): OSSandboxExecutor {
  return new OSSandboxExecutor(opts.profile, { helperPath: opts.helperPath });
}

// 运行时能力探测：判断当前平台能否真正施加 OS 级隔离。
//
// 设计要点：
//   - 纯函数 + 仅在构造 OSSandboxExecutor 时调用一次，不在模块加载期执行副作用；
//   - 非 Linux（macOS / Windows）直接判定 unsupported，并给出人类可读的 reason；
//   - Linux 下探测 user namespace 是否开启（/proc/sys/user/max_user_namespaces）、
//     unshare(1) 是否可用（CLI 降级路径）、以及原生 helper 二进制是否存在；
//   - seccomp 能力以「helper 存在且未被 HARNESS_SANDBOX_NO_SECCOMP 关闭」作为代理判断
//     （helper 内部若缺少 libseccomp 会自行静默降级，TS 侧不再深究）。

import { existsSync, accessSync, constants } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

export interface OSSandboxCapabilities {
  /** 当前平台（process.platform）。 */
  platform: NodeJS.Platform;
  /** 是否为 Linux（OS 沙箱的硬前置条件）。 */
  isLinux: boolean;
  /** 解析到的原生 helper 路径（不存在则为 null）。 */
  helperPath: string | null;
  /** helper 二进制是否就绪（存在且可执行）。 */
  helperAvailable: boolean;
  /** 内核是否允许创建 user namespace。 */
  userNamespaces: boolean;
  /** unshare(1) 是否可用（CLI 降级路径）。 */
  unshareAvailable: boolean;
  /** seccomp 机制是否可能可用（helper 存在且未被显式关闭）。 */
  seccompSupported: boolean;
  /** 整体能否施加 OS 级隔离。 */
  supported: boolean;
  /** 不支持时的原因（支持时为空串）。 */
  reason: string;
}

let cached: OSSandboxCapabilities | null = null;

/** 解析原生 helper 的默认路径：backend/core/native/sandbox-exec/build/sandbox-exec。 */
export function resolveHelperPath(explicit?: string): string {
  if (explicit && explicit.trim()) return explicit.trim();
  const fromEnv = process.env.HARNESS_SANDBOX_HELPER;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  // 编译产物位于 dist/sandbox/executor.js -> ../../native/...
  return resolve(__dirname, '../../native/sandbox-exec/build/sandbox-exec');
}

function fileExecutable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function probeUserNamespaces(): boolean {
  try {
    const p = '/proc/sys/user/max_user_namespaces';
    if (!existsSync(p)) return false;
    const raw = execFileSync('cat', [p], { encoding: 'utf8', timeout: 2000 }).trim();
    const n = Number(raw);
    return Number.isFinite(n) && n > 0;
  } catch {
    return false;
  }
}

function probeUnshare(): boolean {
  try {
    execFileSync('unshare', ['--version'], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] });
    return true;
  } catch {
    // ENOENT 或退出非 0 都视为不可用
    return false;
  }
}

/** 探测当前平台施加 OS 级沙箱的能力。结果会被缓存（平台/环境在单次运行中基本不变）。 */
export function detectCapabilities(): OSSandboxCapabilities {
  if (cached) return cached;

  const platform = process.platform;
  const isLinux = platform === 'linux';
  const helperPath = resolveHelperPath();
  const helperAvailable = isLinux && fileExecutable(helperPath);

  if (!isLinux) {
    cached = {
      platform,
      isLinux: false,
      helperPath: null,
      helperAvailable: false,
      userNamespaces: false,
      unshareAvailable: false,
      seccompSupported: false,
      supported: false,
      reason: `OS 级沙箱需要 Linux 内核（当前 ${platform}）；已降级为「硬化本地进程」执行器（detach + 超时强杀 + 擦除密钥环境）。`,
    };
    return cached;
  }

  const userNamespaces = probeUserNamespaces();
  const unshareAvailable = probeUnshare();
  const seccompDisabled = process.env.HARNESS_SANDBOX_NO_SECCOMP === '1';
  const seccompSupported = helperAvailable && !seccompDisabled;

  const supported = helperAvailable || (userNamespaces && unshareAvailable);
  let reason = '';
  if (!supported) {
    if (!helperAvailable && !(userNamespaces && unshareAvailable)) {
      reason =
        '未找到原生 sandbox-exec helper，且 unshare(1) 不可用或 user namespace 未开启；' +
        '请于 Linux 上构建 helper（scripts/build-native.sh）或安装 util-linux。已降级为硬化本地进程。';
    }
  }

  cached = {
    platform,
    isLinux: true,
    helperPath,
    helperAvailable,
    userNamespaces,
    unshareAvailable,
    seccompSupported,
    supported,
    reason,
  };
  return cached;
}

/** 仅供测试使用：清除能力探测缓存，使下一次 detectCapabilities() 重新探测。 */
export function _resetCapabilityCache(): void {
  cached = null;
}

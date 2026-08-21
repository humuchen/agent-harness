// OS 沙箱策略的默认值与归一化。
//
// 把调用方传入的（可能缺失字段的）OSSandboxProfile 合并成「全字段、可被 argv 构造器
// 与 helper 直接消费」的完整策略。所有字段都有安全默认值（与项目「危险能力 opt-in、
// 默认收紧」的约定一致）。

import type { OSSandboxProfile, NamespaceKind, ResourceLimits, PermissionControls, SeccompConfig } from './types';

export const ALL_NAMESPACES: NamespaceKind[] = ['user', 'mount', 'pid', 'network', 'ipc', 'uts'];

export const DEFAULT_WRITABLE_MOUNT = '/work';

export function defaultResourceLimits(): ResourceLimits {
  return {
    // 256 MiB 虚拟地址空间、512 MiB 数据段，防内存耗尽。
    addressSpaceBytes: 256 * 1024 * 1024,
    dataBytes: 512 * 1024 * 1024,
    // 10 秒 CPU 时间上限。
    cpuSeconds: 10,
    // 最多 64 个文件描述符。
    fds: 64,
    // 最多 128 个进程/线程（防 fork 炸弹）。
    processes: 128,
    // 单文件最大 32 MiB。
    fileSizeBytes: 32 * 1024 * 1024,
    // 栈 8 MiB。
    stackBytes: 8 * 1024 * 1024,
  };
}

export function defaultPermissions(): PermissionControls {
  return {
    dropAllCapabilities: true,
    retainCapabilities: [],
    noNewPrivileges: true,
    uid: null,
    gid: null,
  };
}

export function defaultSeccomp(): SeccompConfig {
  return {
    enabled: true,
    defaultAction: 'errno',
    allowedSyscalls: undefined,
    profile: 'baseline',
  };
}

/** 合并出完整策略；传入 undefined 返回全默认（仍开启 OS 隔离）的安全配置。 */
export function normalizeProfile(input?: OSSandboxProfile): OSSandboxProfile {
  const enabled = input?.enabled ?? true;
  // namespaces 字段语义：
  //   - 未提供（undefined）             -> 全开（默认收紧）
  //   - 显式 null / 空数组 []           -> 不创建任何命名空间
  //   - 显式数组 ['pid','network',...]  -> 仅创建所列
  let namespaces: NamespaceKind[];
  if (input && 'namespaces' in input && (input.namespaces === null || (input.namespaces as NamespaceKind[]).length === 0)) {
    namespaces = [];
  } else if (input?.namespaces && input.namespaces.length > 0) {
    namespaces = input.namespaces.slice();
  } else {
    namespaces = ALL_NAMESPACES.slice();
  }
  const networkIsolated = input?.networkIsolated ?? true;
  const readOnlyRoot = input?.readOnlyRoot ?? true;
  const writableMount = input?.writableMount ?? DEFAULT_WRITABLE_MOUNT;
  const resources = { ...defaultResourceLimits(), ...(input?.resources ?? {}) };
  const permissions = { ...defaultPermissions(), ...(input?.permissions ?? {}) };
  const seccomp = { ...defaultSeccomp(), ...(input?.seccomp ?? {}) };
  const path = input?.path ?? '/usr/bin:/bin';
  return {
    enabled,
    namespaces,
    networkIsolated,
    readOnlyRoot,
    writableMount,
    resources,
    permissions,
    seccomp,
    path,
  };
}

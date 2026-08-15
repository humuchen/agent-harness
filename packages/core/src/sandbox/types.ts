// OS 级沙箱策略类型。
//
// 这一层补齐「逻辑沙箱」（白名单 + 作用域 + 确认，见 builtins/sandbox.ts）所缺失的
// 底层操作系统隔离能力，对应四类原语：
//   1) 命名空间隔离 (namespaces)        —— user / mount / pid / network / ipc / uts
//   2) 系统调用过滤 (seccomp)           —— 未授权 syscall 默认 kill / errno
//   3) 资源限制 (rlimit)                —— 地址空间 / CPU / 文件描述符 / 进程数 / 文件大小
//   4) 权限控制 (capabilities)          —— 丢弃全部能力 / 保留子集 / 禁提权 / 降权 uid·gid
//
// 这些类型只是「声明」。真正的生效依赖 Linux 内核 + 可选的原生 helper
// （packages/core/native/sandbox-exec）——在非 Linux 或 helper 缺失时，OSSandboxExecutor
// 会优雅降级到硬化的 LocalSandboxExecutor（detach 进程组 + 超时强杀 + 擦除密钥环境），
// 符合项目「一切降级可用」的约定。

import type { SandboxExecRequest, SandboxExecResult } from '../builtins/sandbox';

/** 可被隔离的 Linux 命名空间种类。 */
export type NamespaceKind = 'user' | 'mount' | 'pid' | 'network' | 'ipc' | 'uts';

/**
 * 资源限制（rlimit）。值为字节 / 数值；`null` 表示显式不限制（继承宿主）；
 * 省略（undefined）表示沿用 OSSandboxExecutor 内部默认值（见 executor.ts）。
 */
export interface ResourceLimits {
  /** RLIMIT_AS：进程虚拟地址空间上限（字节）。防内存耗尽 / OOM 扩散。 */
  addressSpaceBytes?: number | null;
  /** RLIMIT_DATA：数据段（堆）上限（字节）。 */
  dataBytes?: number | null;
  /** RLIMIT_CPU：CPU 时间上限（秒）。超限后内核发送 SIGXCPU。 */
  cpuSeconds?: number | null;
  /** RLIMIT_NOFILE：可打开文件描述符数上限。 */
  fds?: number | null;
  /** RLIMIT_NPROC：该用户可建进程/线程数上限（防 fork 炸弹）。 */
  processes?: number | null;
  /** RLIMIT_FSIZE：可创建文件大小上限（字节）。 */
  fileSizeBytes?: number | null;
  /** RLIMIT_STACK：栈大小（字节）。 */
  stackBytes?: number | null;
}

/** 权限控制：能力裁剪、禁提权、降权。 */
export interface PermissionControls {
  /** 丢弃全部 Linux capabilities（默认 true）。 */
  dropAllCapabilities?: boolean;
  /** 在 dropAll 之后显式保留的能力名，如 'CAP_NET_BIND_SERVICE' / 'CAP_SYS_ADMIN'。 */
  retainCapabilities?: string[];
  /** 设置 PR_SET_NO_NEW_PRIVS，禁止子进程通过 setuid 提权（默认 true）。 */
  noNewPrivileges?: boolean;
  /** 目标 uid（在新 user namespace 内通常映射为 0）。null 表示不降权。 */
  uid?: number | null;
  /** 目标 gid。null 表示不降权。 */
  gid?: number | null;
}

/** 系统调用过滤（seccomp）配置。 */
export interface SeccompConfig {
  /** 是否启用 seccomp BPF 过滤（默认 true，需 helper + libseccomp）。 */
  enabled?: boolean;
  /** 未命中白名单 syscall 的默认动作。 */
  defaultAction?: 'kill' | 'errno' | 'allow' | 'log';
  /**
   * 显式放行的 syscall 名列表（如 'read','write','exit_group'）。
   * 与 `profile` 二选一；`profile` 优先级更高。
   */
  allowedSyscalls?: string[];
  /** 直接套用预置 profile（syscall 名单见 profiles.ts），优先级高于 allowedSyscalls。 */
  profile?: 'baseline' | 'strict' | 'dev' | 'none';
}

/** OS 沙箱整体策略 —— 四类原语的集合。 */
export interface OSSandboxProfile {
  /** 总开关。false => 完全不施加 OS 隔离（纯逻辑沙箱）。默认 true。 */
  enabled?: boolean;
  /** 要创建的命名空间集合；显式 null 或空数组 => 不创建任何命名空间；缺省 => 全开（默认收紧）。 */
  namespaces?: NamespaceKind[] | null;
  /** 网络隔离：即使建了 network 命名空间，也确保无外部接口（默认 true）。 */
  networkIsolated?: boolean;
  /** 只读 rootfs：把根文件系统重新挂载为只读，仅 writableMount 点可写（默认 true）。 */
  readOnlyRoot?: boolean;
  /** 新 mount 命名空间内的可写挂载点（绝对路径，如 /work）。命令的 cwd 会落在那里。 */
  writableMount?: string;
  /** 资源限制。 */
  resources?: ResourceLimits;
  /** 权限控制。 */
  permissions?: PermissionControls;
  /** 系统调用过滤。 */
  seccomp?: SeccompConfig;
  /** 给隔离环境的精简 PATH（默认 '/usr/bin:/bin'）。 */
  path?: string;
}

export type { SandboxExecRequest, SandboxExecResult };

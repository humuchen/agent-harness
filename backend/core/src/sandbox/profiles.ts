// 系统调用过滤（seccomp）预置名单。
//
// 这些名单以「syscall 名」声明，由原生 helper（sandbox-exec.c）借助 libseccomp 的
// seccomp_syscall_resolve_name() 解析为各架构的实际编号，再编译成 BPF 过滤器。
// TS 侧只负责「声明 + 校验」，不参与 BPF 生成（那部分必须贴近内核，放 C 里最稳）。
//
// 设计权衡：
//   - baseline / dev 的 defaultAction 取 'errno'（未知 syscall 返回 EPERM）——命令遇到
//     未列入的 syscall 会报错而非被杀，便于排查、也不易误伤正常命令；
//   - strict 的 defaultAction 取 'kill'（命中未授权 syscall 直接杀进程）——安全性最高，
//     仅对 syscall 面极窄的负载（如纯计算、受限解释器）使用。
// 名单是「经验集」，需按目标命令与架构微调；这里覆盖 x86_64 glibc 下常见命令（含 node /
// python / shell 工具）所需的最小可用集合，并显式排除 ptrace / mount / kexec / 模块类等
// 高危 syscall。

export type SeccompProfileName = 'baseline' | 'strict' | 'dev' | 'none';

/** 默认动作映射：profile -> 未命中 syscall 的处理。 */
export const PROFILE_DEFAULT_ACTION: Record<SeccompProfileName, 'kill' | 'errno' | 'allow' | 'log'> = {
  baseline: 'errno',
  dev: 'errno',
  strict: 'kill',
  none: 'allow',
};

/**
 * 基础 syscall 名单：绝大多数「只读 / 计算 / 文本处理」命令所需。
 * 显式排除：ptrace, mount, umount2, kexec_load, init_module, finit_module,
 * bpf, perf_event_open, fanotify_init, swapon, swapoff, reboot, settimeofday,
 * adjtimex, clock_adjtime, lookup_dcookie, process_vm_readv, process_vm_writev,
 * personality(可用于绕过某些限制), userfaultfd, acct, nfsservctl, _sysctl, uselib。
 */
export const BASELINE_SYSCALLS: string[] = [
  // 内存 / 基础
  'brk', 'mmap', 'munmap', 'mprotect', 'madvise', 'mremap', 'mincore', 'mlock', 'munlock',
  // 文件 / IO
  'read', 'write', 'open', 'openat', 'close', 'close_range', 'lseek', 'pread64', 'pwrite64',
  'readv', 'writev', 'fcntl', 'ioctl', 'fstat', 'fstatfs', 'newfstatat', 'statx',
  'access', 'faccessat', 'faccessat2', 'getdents64', 'getcwd', 'dup', 'dup2', 'dup3',
  'pipe', 'pipe2', 'poll', 'ppoll', 'select', 'pselect6', 'fsync', 'fdatasync', 'ftruncate',
  'truncate', 'link', 'linkat', 'unlink', 'unlinkat', 'symlink', 'symlinkat', 'readlink',
  'readlinkat', 'rename', 'renameat', 'renameat2', 'mkdir', 'mkdirat', 'rmdir', 'chdir',
  'fchdir', 'chmod', 'fchmod', 'fchmodat', 'utimensat', 'umask', 'sync', 'syncfs',
  // 进程 / 线程
  'clone', 'clone3', 'fork', 'vfork', 'execve', 'execveat', 'wait4', 'waitid', 'exit',
  'exit_group', 'prctl', 'arch_prctl', 'set_tid_address', 'set_robust_list',
  'get_robust_list', 'futex', 'sched_yield', 'sched_getaffinity', 'sched_setaffinity',
  'rt_sigaction', 'rt_sigprocmask', 'rt_sigreturn', 'sigaltstack', 'kill', 'tkill', 'tgkill',
  'getpid', 'getppid', 'gettid', 'getpgrp', 'setsid', 'prlimit64', 'getrlimit', 'setrlimit',
  // 时间与计时
  'nanosleep', 'clock_nanosleep', 'clock_gettime', 'clock_getres', 'gettimeofday', 'time',
  // 用户 / 组
  'getuid', 'geteuid', 'getgid', 'getegid', 'getgroups', 'setgroups', 'getresuid',
  'getresgid', 'setresuid', 'setresgid', 'caps', 'capget', 'capset',
  // 网络（仅 loopback / 本地 unix socket；外部联网由 network 命名空间彻底断掉）
  'socket', 'socketpair', 'bind', 'listen', 'accept', 'accept4', 'connect', 'getsockname',
  'getpeername', 'setsockopt', 'getsockopt', 'recvfrom', 'recvmsg', 'sendto', 'sendmsg',
  'shutdown', 'sendfile', 'recv', 'send',
  // 杂项
  'getrandom', 'epoll_create1', 'epoll_create', 'epoll_ctl', 'epoll_wait', 'epoll_pwait',
  'eventfd2', 'eventfd', 'signalfd4', 'signalfd', 'memfd_create', 'timerfd_create',
  'timerfd_settime', 'timerfd_gettime', 'statfs', 'fadvise64', 'readahead', 'ioprio_get',
  'ioprio_set', 'getcpu', 'sched_getparam', 'sched_get_priority_max',
  'sched_get_priority_min', 'restart_syscall', 'rseq', 'membarrier',
];

/**
 * dev 名单：在 baseline 基础上放开「包管理 / 编译 / 联网调试」所需的能力，
 * 用于「需要临时联网安装依赖」的可信开发场景。注意：仍需配合 network 命名空间
 * 关闭才能真正断网；open 网络命名空间时 dev 名单允许外部 socket。
 */
export const DEV_SYSCALLS: string[] = [
  ...BASELINE_SYSCALLS,
  // 允许更多联网原语（仅当未隔离 network 时才有意义）
  'connect', 'sendmmsg', 'recvmmsg', 'name_to_handle_at', 'open_by_handle_at',
];

/**
 * strict 名单：最窄集合，仅保留「运行一个解释器/二进制 + 基本文件读写」所需。
 * 默认动作 kill——任何越界 syscall 立即终止进程。仅用于 syscall 面可严格枚举的负载。
 */
export const STRICT_SYSCALLS: string[] = [
  'brk', 'mmap', 'munmap', 'mprotect', 'read', 'write', 'open', 'openat', 'close',
  'close_range', 'lseek', 'pread64', 'pwrite64', 'readv', 'writev', 'fcntl', 'fstat',
  'newfstatat', 'access', 'faccessat', 'getdents64', 'getcwd', 'dup', 'dup2', 'dup3',
  'pipe2', 'poll', 'ppoll', 'clone', 'clone3', 'execve', 'execveat', 'wait4', 'exit',
  'exit_group', 'prctl', 'arch_prctl', 'set_tid_address', 'set_robust_list', 'futex',
  'rt_sigaction', 'rt_sigprocmask', 'rt_sigreturn', 'sigaltstack', 'getpid', 'getppid',
  'gettid', 'getrlimit', 'prlimit64', 'nanosleep', 'clock_gettime', 'getrandom',
  'epoll_create1', 'epoll_ctl', 'epoll_wait', 'epoll_pwait', 'getuid', 'geteuid',
  'getgid', 'getegid', 'fstatfs', 'statx', 'gettimeofday',
];

/** 解析预置 profile 名 -> 放行的 syscall 名单；'none' 返回空（配合 defaultAction=allow）。 */
export function resolveProfile(name: SeccompProfileName): string[] {
  switch (name) {
    case 'baseline':
      return [...BASELINE_SYSCALLS];
    case 'dev':
      return [...DEV_SYSCALLS];
    case 'strict':
      return [...STRICT_SYSCALLS];
    case 'none':
      return [];
  }
}

/** 校验一组 syscall 名是否为常见合法 syscall（宽松：仅做非空/重复检查，真正的解析在 helper）。 */
export function validateSyscallNames(names: string[]): { valid: string[]; invalid: string[] } {
  const seen = new Set<string>();
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const n of names) {
    const t = String(n).trim();
    if (!t || !/^[a-z0-9_]+$/i.test(t)) {
      invalid.push(n);
      continue;
    }
    if (seen.has(t)) continue;
    seen.add(t);
    valid.push(t);
  }
  return { valid, invalid };
}

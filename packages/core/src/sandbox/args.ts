// 纯函数：把 OSSandboxProfile + 执行请求拼成「原生 helper」或「unshare 降级」的 argv。
//
// 抽成纯函数的好处：
//   - 与现有 buildContainerArgs 一样可在任意平台（含 macOS）做单元测试，无需真的起进程；
//   - server 端可据 argv 做审计 / dry-run；
//   - helper 的 CLI 契约集中在此，C 侧照此解析即可。
//
// 两套路径：
//   A) buildHelperArgs —— 走 packages/core/native/sandbox-exec（真正的四类原语全覆盖）。
//   B) buildUnshareFallbackArgs —— 走 unshare(1) + bash ulimit 包装（仅命名空间 + 部分
//      rlimit；无 seccomp / 无能力裁剪），作为「非 Linux helper 缺失」时的降级。

import type { OSSandboxProfile, SandboxExecRequest } from './types';
import { normalizeProfile, ALL_NAMESPACES } from './policy';
import { resolveProfile, PROFILE_DEFAULT_ACTION } from './profiles';

const NS_FLAG: Record<string, string> = {
  user: 'user',
  mount: 'mount',
  pid: 'pid',
  network: 'net',
  ipc: 'ipc',
  uts: 'uts',
};

/**
 * 构造原生 helper 的 argv（含可执行文件名）。
 * helper 契约：sandbox-exec [options] -- command [args...]
 */
export function buildHelperArgs(profile: OSSandboxProfile, req: SandboxExecRequest, helperBin: string): string[] {
  const p = normalizeProfile(profile);
  const args: string[] = [helperBin];

  // 1) 命名空间
  const nsList = (p.namespaces ?? []).filter((n) => ALL_NAMESPACES.includes(n));
  if (nsList.length > 0) {
    args.push('--ns', nsList.map((n) => NS_FLAG[n]).join(','));
  }
  // 2) 网络隔离
  if (p.networkIsolated && nsList.includes('network')) {
    args.push('--no-net');
  } else if (nsList.includes('network')) {
    args.push('--net-up');
  }
  // 3) 只读 root + 可写挂载
  if (p.readOnlyRoot && nsList.includes('mount')) {
    args.push('--root-ro');
  }
  if (nsList.includes('mount') && req.cwd) {
    // 把宿主 cwd 绑定到命名空间内的可写点（如 /work），并作为工作目录。
    args.push('--bind-rw', `${req.cwd}:${p.writableMount ?? '/work'}`);
    args.push('--cwd', p.writableMount ?? '/work');
  } else if (req.cwd) {
    args.push('--cwd', req.cwd);
  }

  // 4) 资源限制
  const r = p.resources ?? {};
  if (r.addressSpaceBytes != null) args.push('--rlimit-as', String(r.addressSpaceBytes));
  if (r.dataBytes != null) args.push('--rlimit-data', String(r.dataBytes));
  if (r.cpuSeconds != null) args.push('--rlimit-cpu', String(r.cpuSeconds));
  if (r.fds != null) args.push('--rlimit-nofile', String(r.fds));
  if (r.processes != null) args.push('--rlimit-nproc', String(r.processes));
  if (r.fileSizeBytes != null) args.push('--rlimit-fsize', String(r.fileSizeBytes));
  if (r.stackBytes != null) args.push('--rlimit-stack', String(r.stackBytes));

  // 5) 权限控制
  const perm = p.permissions ?? {};
  if (perm.dropAllCapabilities) args.push('--drop-caps');
  if (perm.retainCapabilities && perm.retainCapabilities.length > 0) {
    args.push('--keep-caps', perm.retainCapabilities.join(','));
  }
  if (perm.noNewPrivileges) args.push('--no-new-privs');
  else args.push('--allow-new-privs');
  if (perm.uid != null) args.push('--uid', String(perm.uid));
  if (perm.gid != null) args.push('--gid', String(perm.gid));

  // 6) seccomp（名单由 TS 侧解析后通过 --seccomp-allow 下发，C 侧不再内嵌名单表）
  const sc = p.seccomp ?? {};
  if (sc.enabled === false) {
    args.push('--no-seccomp');
  } else {
    const name = sc.profile ?? 'baseline';
    const list = sc.allowedSyscalls && sc.allowedSyscalls.length ? sc.allowedSyscalls : resolveProfile(name);
    if (list.length > 0) args.push('--seccomp-allow', list.join(','));
    const def = sc.defaultAction ?? PROFILE_DEFAULT_ACTION[name];
    args.push('--seccomp-default', def);
  }

  // 7) PATH
  if (p.path) args.push('--path', p.path);

  // 8) 目标命令（必须紧跟在 -- 之后）
  args.push('--');
  args.push(req.command, ...req.args);
  return args;
}

/** ulimit 单位换算辅助（bash ulimit 用 KiB / 512B 块）。 */
function toKib(bytes: number): string {
  return String(Math.max(1, Math.ceil(bytes / 1024)));
}
function toBlocks(bytes: number): string {
  return String(Math.max(1, Math.ceil(bytes / 512)));
}

/**
 * 构造 unshare(1) + bash ulimit 包装的 argv（降级路径，仅命名空间 + 部分 rlimit）。
 * 注意：此路径无 seccomp、无能力裁剪；仅用于 helper 缺失且 util-linux 可用的 Linux。
 */
export function buildUnshareFallbackArgs(profile: OSSandboxProfile, req: SandboxExecRequest): string[] {
  const p = normalizeProfile(profile);
  const nsList = (p.namespaces ?? []).filter((n) => ALL_NAMESPACES.includes(n));
  const r = p.resources ?? {};

  const unshareArgs = ['unshare'];
  // user + mount + pid 是「隔离」的核心；fork 让 pid ns 在新进程树里生效。
  if (nsList.includes('user')) unshareArgs.push('--user', '--map-root-user');
  if (nsList.includes('mount')) unshareArgs.push('--mount', '--mount-proc');
  if (nsList.includes('pid')) unshareArgs.push('--pid', '--fork');
  if (nsList.includes('network')) unshareArgs.push('--net');
  if (nsList.includes('ipc')) unshareArgs.push('--ipc');
  if (nsList.includes('uts')) unshareArgs.push('--uts');

  // bash ulimit 包装：先设上限，再 cd 到 cwd，最后 exec 目标命令。
  const ul: string[] = [];
  if (r.addressSpaceBytes != null) ul.push(`ulimit -v ${toKib(r.addressSpaceBytes)}`);
  if (r.dataBytes != null) ul.push(`ulimit -d ${toKib(r.dataBytes)}`);
  if (r.stackBytes != null) ul.push(`ulimit -s ${toKib(r.stackBytes)}`);
  if (r.cpuSeconds != null) ul.push(`ulimit -t ${r.cpuSeconds}`);
  if (r.fds != null) ul.push(`ulimit -n ${r.fds}`);
  if (r.processes != null) ul.push(`ulimit -u ${r.processes}`);
  if (r.fileSizeBytes != null) ul.push(`ulimit -f ${toBlocks(r.fileSizeBytes)}`);
  const script = [...ul, `cd ${JSON.stringify(req.cwd)}`, 'exec "$@"'].join('; ');

  // 末尾的 bash 作为 -c 脚本的 $0，"$@" = command + args
  unshareArgs.push('bash', '-c', script, 'bash', req.command, ...req.args);
  return unshareArgs;
}

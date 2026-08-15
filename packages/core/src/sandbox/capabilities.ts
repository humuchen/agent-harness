// Linux capabilities 清单与校验。
//
// 这里给出一份完整的、约定俗成的 capability 名称表，主要用途：
//   - 校验 OSSandboxProfile.permissions.retainCapabilities 里写的能力名是否合法；
//   - 给原生 helper（sandbox-exec.c）做白名单提示（helper 内部用 libcap 的
//     cap_from_name 解析，这里只是 TS 侧的可读性与校验层）。
//
// 完整列表依据 Linux 的 <linux/capability.h>（cap 0..CAP_LAST_CAP）。名称后缀统一去
// 掉 "CAP_" 前缀以与常见写法一致（如 'NET_BIND_SERVICE' 等价于 'CAP_NET_BIND_SERVICE'）。

/** 全部 Linux capability 名（不含 'CAP_' 前缀），按编号升序。 */
export const LINUX_CAPABILITIES: string[] = [
  'CHOWN',
  'DAC_OVERRIDE',
  'DAC_READ_SEARCH',
  'FOWNER',
  'FSETID',
  'KILL',
  'SETGID',
  'SETUID',
  'SETPCAP',
  'LINUX_IMMUTABLE',
  'NET_BIND_SERVICE',
  'NET_BROADCAST',
  'NET_ADMIN',
  'NET_RAW',
  'IPC_LOCK',
  'IPC_OWNER',
  'SYS_MODULE',
  'SYS_RAWIO',
  'SYS_CHROOT',
  'SYS_PTRACE',
  'SYS_PACCT',
  'SYS_ADMIN',
  'SYS_BOOT',
  'SYS_NICE',
  'SYS_RESOURCE',
  'SYS_TIME',
  'SYS_TTY_CONFIG',
  'MKNOD',
  'LEASE',
  'AUDIT_WRITE',
  'AUDIT_CONTROL',
  'SETFCAP',
  'MAC_OVERRIDE',
  'MAC_ADMIN',
  'SYSLOG',
  'WAKE_ALARM',
  'BLOCK_SUSPEND',
  'AUDIT_READ',
  'PERFMON',
  'BPF',
  'CHECKPOINT_RESTORE',
];

const CAP_SET = new Set(LINUX_CAPABILITIES);
const CAP_SET_WITH_PREFIX = new Set(LINUX_CAPABILITIES.map((c) => `CAP_${c}`));

/** 接受 'NET_BIND_SERVICE' 与 'CAP_NET_BIND_SERVICE' 两种写法，统一归一到 'CAP_' 前缀。 */
export function normalizeCapabilityName(name: string): string {
  const n = name.trim().toUpperCase();
  return CAP_SET.has(n) ? `CAP_${n}` : n;
}

/** 是否为合法的 Linux capability 名（两种前缀均可）。 */
export function isCapabilityName(name: string): boolean {
  const n = name.trim().toUpperCase();
  return CAP_SET.has(n) || CAP_SET_WITH_PREFIX.has(n);
}

/** 校验一组能力名，返回 { valid: 合法子集, invalid: 非法子集 }，便于调用方告警而不直接抛错。 */
export function validateCapabilities(names: string[]): { valid: string[]; invalid: string[] } {
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const n of names) {
    if (isCapabilityName(n)) valid.push(normalizeCapabilityName(n));
    else invalid.push(n);
  }
  return { valid, invalid };
}

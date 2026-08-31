// 零依赖测试（node:test + node:assert）：覆盖 OS 级沙箱的四类原语构造与降级。
// 直接 require 编译后的叶子模块，避免引入额外运行时依赖。
// 注意：原生 helper 仅在 Linux 构建后存在；macOS / Windows 下测试聚焦：
//   1) 能力探测正确判定 unsupported（并给出可读原因）；
//   2) buildHelperArgs / buildUnshareFallbackArgs 这类纯函数产出的 argv 正确；
//   3) profiles / capabilities / policy 归一化正确；
//   4) 在非 Linux 上 OSSandboxExecutor 优雅降级为硬化本地执行器且仍能正常跑命令。

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');

const sandbox = require('../dist/sandbox/index.js');
const {
  detectCapabilities,
  resolveHelperPath,
  _resetCapabilityCache,
  buildHelperArgs,
  buildUnshareFallbackArgs,
  normalizeProfile,
  resolveProfile,
  resolveSeccompList,
  validateSyscallNames,
  LINUX_CAPABILITIES,
  isCapabilityName,
  normalizeCapabilityName,
  createOSSandboxExecutor,
} = sandbox;
const { createSandboxExecutor } = require('../dist/builtins/sandbox.js');

const FAKE_HELPER = '/opt/harness/sandbox-exec';
const REQ = { command: 'node', args: ['-e', '1+1'], cwd: '/srv/sandbox/work', timeoutMs: 5000 };

test('detectCapabilities：非 Linux 判定 unsupported 并给出原因', () => {
  _resetCapabilityCache();
  const cap = detectCapabilities();
  assert.strictEqual(cap.isLinux, process.platform === 'linux');
  if (process.platform !== 'linux') {
    assert.strictEqual(cap.supported, false);
    assert.strictEqual(cap.helperAvailable, false);
    assert.match(cap.reason, /Linux/);
  }
});

test('resolveHelperPath：默认路径指向 native 构建产物，env 可覆盖', () => {
  const def = resolveHelperPath();
  // 跨平台归一化：resolve() 在 Windows 上返回反斜杠路径，正则用正斜杠匹配需先归一化。
  assert.match(def.split(path.sep).join('/'), /native\/sandbox-exec\/build\/sandbox-exec$/);
  const prev = process.env.HARNESS_SANDBOX_HELPER;
  process.env.HARNESS_SANDBOX_HELPER = '/custom/bin/sandbox-exec';
  assert.strictEqual(resolveHelperPath(), '/custom/bin/sandbox-exec');
  if (prev === undefined) delete process.env.HARNESS_SANDBOX_HELPER;
  else process.env.HARNESS_SANDBOX_HELPER = prev;
});

test('buildHelperArgs：完整策略生成正确的 helper argv', () => {
  const profile = {
    namespaces: ['user', 'mount', 'pid', 'network', 'ipc', 'uts'],
    networkIsolated: true,
    readOnlyRoot: true,
    writableMount: '/work',
    resources: { addressSpaceBytes: 268435456, cpuSeconds: 10, fds: 64, processes: 128, fileSizeBytes: 33554432 },
    permissions: { dropAllCapabilities: true, noNewPrivileges: true, retainCapabilities: ['CAP_NET_BIND_SERVICE'] },
    seccomp: { enabled: true, profile: 'baseline', defaultAction: 'errno' },
  };
  const argv = buildHelperArgs(profile, REQ, FAKE_HELPER);
  assert.strictEqual(argv[0], FAKE_HELPER);
  assert.ok(argv.includes('--ns'), '应包含 --ns');
  assert.strictEqual(argv[argv.indexOf('--ns') + 1], 'user,mount,pid,net,ipc,uts');
  assert.ok(argv.includes('--no-net'));
  assert.ok(argv.includes('--root-ro'));
  // bind-rw 把宿主 cwd 绑到 /work
  const bi = argv.indexOf('--bind-rw');
  assert.strictEqual(argv[bi + 1], '/srv/sandbox/work:/work');
  assert.strictEqual(argv[argv.indexOf('--cwd') + 1], '/work');
  // 资源限制
  assert.strictEqual(argv[argv.indexOf('--rlimit-as') + 1], '268435456');
  assert.strictEqual(argv[argv.indexOf('--rlimit-cpu') + 1], '10');
  assert.strictEqual(argv[argv.indexOf('--rlimit-nofile') + 1], '64');
  assert.strictEqual(argv[argv.indexOf('--rlimit-nproc') + 1], '128');
  assert.strictEqual(argv[argv.indexOf('--rlimit-fsize') + 1], '33554432');
  // 权限
  assert.ok(argv.includes('--drop-caps'));
  assert.strictEqual(argv[argv.indexOf('--keep-caps') + 1], 'CAP_NET_BIND_SERVICE');
  assert.ok(argv.includes('--no-new-privs'));
  // seccomp（名单由 baseline 解析后下发）
  const sa = argv.indexOf('--seccomp-allow');
  assert.ok(sa > 0);
  assert.ok(argv[sa + 1].split(',').includes('read'));
  assert.ok(argv[sa + 1].split(',').includes('execve'));
  assert.strictEqual(argv[argv.indexOf('--seccomp-default') + 1], 'errno');
  // 目标命令在 -- 之后
  const sep = argv.indexOf('--');
  assert.ok(sep > 0);
  assert.strictEqual(argv[sep + 1], 'node');
  assert.deepStrictEqual(argv.slice(sep + 2), ['-e', '1+1']);
});

test('buildHelperArgs：未建命名空间 + 关闭 seccomp 时不产出 --ns / --seccomp-*', () => {
  const profile = { namespaces: null, seccomp: { enabled: false } };
  const argv = buildHelperArgs(profile, REQ, FAKE_HELPER);
  assert.ok(!argv.includes('--ns'), '不应包含 --ns');
  assert.ok(argv.includes('--no-seccomp'));
  assert.ok(!argv.includes('--seccomp-allow'));
});

test('buildUnshareFallbackArgs：生成 unshare + bash ulimit 包装', () => {
  const profile = {
    namespaces: ['user', 'mount', 'pid', 'network', 'ipc', 'uts'],
    resources: { addressSpaceBytes: 268435456, cpuSeconds: 10, fds: 64, processes: 128, fileSizeBytes: 33554432 },
  };
  const argv = buildUnshareFallbackArgs(profile, REQ);
  assert.strictEqual(argv[0], 'unshare');
  assert.ok(argv.includes('--user') && argv.includes('--map-root-user'), '应包含 user + map-root-user');
  assert.ok(argv.includes('--mount') && argv.includes('--mount-proc'));
  assert.ok(argv.includes('--pid') && argv.includes('--fork'));
  assert.ok(argv.includes('--net'));
  // bash -c 脚本里应有 ulimit 与 exec "$@"
  const ci = argv.indexOf('bash');
  assert.ok(ci > 0 && argv[ci + 1] === '-c');
  const script = argv[ci + 2];
  assert.match(script, /ulimit -v/);
  assert.match(script, /ulimit -t 10/);
  assert.match(script, /ulimit -n 64/);
  assert.match(script, /ulimit -u 128/);
  assert.match(script, /exec "\$@"/);
  // 末尾 'bash' 是 $0，其后为命令与参数
  const tail = argv.slice(argv.indexOf('bash', ci + 1) + 1);
  assert.strictEqual(tail[0], 'node');
  assert.deepStrictEqual(tail.slice(1), ['-e', '1+1']);
});

test('profiles / capabilities：名单与校验正确', () => {
  const base = resolveProfile('baseline');
  assert.ok(base.includes('read') && base.includes('write') && base.includes('execve'));
  const strict = resolveProfile('strict');
  assert.ok(strict.length < base.length, 'strict 应比 baseline 更窄');
  assert.ok(LINUX_CAPABILITIES.includes('NET_BIND_SERVICE'));
  assert.ok(isCapabilityName('CAP_SYS_ADMIN'));
  assert.ok(isCapabilityName('sys_admin'));
  assert.strictEqual(normalizeCapabilityName('sys_admin'), 'CAP_SYS_ADMIN');
  const v = validateSyscallNames(['read', 'write', '', 'bad name', 'openat']);
  assert.deepStrictEqual(v.valid.sort(), ['openat', 'read', 'write']);
  assert.strictEqual(v.invalid.length, 2);
});

test('normalizeProfile：默认策略安全收紧（全开隔离 + 默认资源上限）', () => {
  const p = normalizeProfile();
  assert.strictEqual(p.enabled, true);
  assert.strictEqual(p.namespaces.length, 6);
  assert.strictEqual(p.readOnlyRoot, true);
  assert.strictEqual(p.networkIsolated, true);
  assert.ok(p.resources.addressSpaceBytes > 0);
  assert.strictEqual(p.seccomp.enabled, true);
  assert.strictEqual(p.seccomp.profile, 'baseline');
});

test('resolveSeccompList：解析出名单与默认动作', () => {
  const r = resolveSeccompList({ seccomp: { enabled: true, profile: 'baseline', defaultAction: 'errno' } });
  assert.ok(r.syscalls.includes('read'));
  assert.strictEqual(r.defaultAction, 'errno');
  const off = resolveSeccompList({ seccomp: { enabled: false } });
  assert.deepStrictEqual(off.syscalls, []);
  assert.strictEqual(off.defaultAction, 'allow');
});

test('OSSandboxExecutor：非 Linux 优雅降级为硬化本地执行器且仍可运行', async () => {
  const exec = createOSSandboxExecutor();
  const status = exec.describe();
  if (process.platform !== 'linux') {
    assert.strictEqual(status.backend, 'os-fallback-local');
    assert.strictEqual(status.active.namespaces, false);
    assert.strictEqual(status.active.seccomp, false);
  }
  // 降级路径下仍能正常执行命令（验证了「一切降级可用」）。
  const res = await exec.exec({ command: 'echo', args: ['hi-os-sandbox'], cwd: os.tmpdir(), timeoutMs: 5000 });
  assert.strictEqual(res.code, 0);
  assert.match(res.stdout, /hi-os-sandbox/);
});

test('createSandboxExecutor(backend=os)：返回 kind=os 的执行器并能运行', async () => {
  const exec = createSandboxExecutor({ backend: 'os' });
  assert.strictEqual(exec.kind, 'os');
  const res = await exec.exec({ command: 'echo', args: ['os-backend-ok'], cwd: os.tmpdir(), timeoutMs: 5000 });
  assert.strictEqual(res.code, 0);
  assert.match(res.stdout, /os-backend-ok/);
});

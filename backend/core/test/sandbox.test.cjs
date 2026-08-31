// 零依赖测试（node:test + node:assert）：覆盖 P0-1 沙箱执行器。
// 直接 require 编译后的叶子模块，避免引入其它运行时依赖。
// 说明：本测试默认在 macOS/Linux 上运行，依赖 echo / sleep 系统命令存在。
const test = require('node:test');
const assert = require('node:assert');

const {
  buildContainerArgs,
  scrubEnv,
  createSandboxExecutor,
  LocalSandboxExecutor,
  ContainerSandboxExecutor,
} = require('../dist/builtins/sandbox.js');

// ---------------------------------------------------------------------------
// buildContainerArgs（纯函数，可序列化 argv）
// ---------------------------------------------------------------------------

test('buildContainerArgs 默认断网/只读/去权/禁提权（网络与去权默认值）', () => {
  const args = buildContainerArgs(
    {},
    { command: 'echo', args: ['hi'], cwd: '/work', timeoutMs: 1000 }
  );
  assert.strictEqual(args[0], 'docker', '默认 runtime 为 docker');
  const ni = args.indexOf('--network');
  assert.ok(ni >= 0, '含 --network');
  assert.strictEqual(args[ni + 1], 'none', '默认网络 none（完全断网）');
  assert.ok(args.includes('--read-only'), '默认只读 rootfs');
  assert.ok(args.includes('--cap-drop'), '去权参数');
  assert.ok(args.includes('ALL'), '去全部 capabilities');
  assert.ok(args.includes('--security-opt'), '禁提权参数');
  assert.ok(args.includes('no-new-privileges'), '禁止提权');
  // 资源上限（--memory/--cpus/--pids-limit）由 ContainerSandboxExecutor 构造时填充默认值，
  // buildContainerArgs 仅按传入 opts 拼装，故空 opts 下不出现；见下方「自定义资源上限」测试。
  // 仅挂载已锁定的工作目录为可写，并设为工作目录。
  const vi = args.indexOf('-v');
  assert.strictEqual(args[vi + 1], '/work:/work:rw');
  const wi = args.indexOf('-w');
  assert.strictEqual(args[wi + 1], '/work');
  // 命令与参数位于镜像之后。
  const ci = args.indexOf('alpine:latest');
  assert.strictEqual(args[ci + 1], 'echo');
  assert.strictEqual(args[ci + 2], 'hi');
});

test('buildContainerArgs 自定义网络模式 bridge', () => {
  const args = buildContainerArgs(
    { network: 'bridge' },
    { command: 'ls', args: ['-la'], cwd: '/work', timeoutMs: 1000 }
  );
  const ni = args.indexOf('--network');
  assert.strictEqual(args[ni + 1], 'bridge');
});

test('buildContainerArgs podman 后端切换可执行文件', () => {
  const args = buildContainerArgs(
    { backend: 'podman' },
    { command: 'echo', args: ['x'], cwd: '/tmp', timeoutMs: 100 }
  );
  assert.strictEqual(args[0], 'podman');
});

test('buildContainerArgs 自定义资源上限生效', () => {
  const args = buildContainerArgs(
    { memoryMb: 512, cpus: 2, pidsLimit: 256 },
    { command: 'true', args: [], cwd: '/work', timeoutMs: 100 }
  );
  const mi = args.indexOf('--memory');
  assert.strictEqual(args[mi + 1], '512m');
  const ci = args.indexOf('--cpus');
  assert.strictEqual(args[ci + 1], '2');
  const pi = args.indexOf('--pids-limit');
  assert.strictEqual(args[pi + 1], '256');
});

test('buildContainerArgs 自定义 bin 覆盖运行时可执行文件名', () => {
  // bin 选项应覆盖默认的 docker/podman 推导（自定义 runtime 如 nerdctl 场景）。
  const args = buildContainerArgs(
    { bin: 'nerdctl', image: 'busybox' },
    { command: 'echo', args: ['hi'], cwd: '/work', timeoutMs: 1000 }
  );
  assert.strictEqual(args[0], 'nerdctl', 'bin 选项应覆盖默认 docker/podman');
  // bin 显式指定时，即使 backend 为 podman 也以 bin 为准。
  const args2 = buildContainerArgs(
    { backend: 'podman', bin: 'docker' },
    { command: 'echo', args: ['x'], cwd: '/tmp', timeoutMs: 100 }
  );
  assert.strictEqual(args2[0], 'docker', 'bin 应优先于 backend 推导');
});

// ---------------------------------------------------------------------------
// scrubEnv（密钥擦除）
// ---------------------------------------------------------------------------

test('scrubEnv 剔除密钥类变量、保留正常变量', () => {
  const env = {
    PATH: '/usr/bin',
    HOME: '/home/me',
    LANG: 'en_US.UTF-8',
    MY_API_KEY: 'secret123',
    DB_PASSWORD: 'p@ss',
    GITHUB_TOKEN: 'ghp_xxx',
    AWS_SECRET_ACCESS_KEY: 'akia-xxx',
    NORMAL_VAR: 'keep',
  };
  const out = scrubEnv(env);
  assert.strictEqual(out.PATH, '/usr/bin');
  assert.strictEqual(out.HOME, '/home/me');
  assert.strictEqual(out.LANG, 'en_US.UTF-8');
  assert.strictEqual(out.NORMAL_VAR, 'keep');
  assert.strictEqual(out.MY_API_KEY, undefined, 'API Key 应被剔除');
  assert.strictEqual(out.DB_PASSWORD, undefined, 'PASSWORD 应被剔除');
  assert.strictEqual(out.GITHUB_TOKEN, undefined, 'TOKEN 应被剔除');
  assert.strictEqual(out.AWS_SECRET_ACCESS_KEY, undefined, 'SECRET 应被剔除');
});

// ---------------------------------------------------------------------------
// LocalSandboxExecutor（硬化本地进程）
// ---------------------------------------------------------------------------

test('LocalSandboxExecutor 正常执行并捕获 stdout/退出码', async () => {
  const ex = new LocalSandboxExecutor();
  const res = await ex.exec({
    command: 'echo',
    args: ['hello-sandbox'],
    cwd: process.cwd(),
    timeoutMs: 5000,
  });
  assert.strictEqual(res.code, 0, '退出码应为 0');
  assert.ok(res.stdout.includes('hello-sandbox'), 'stdout 应包含命令输出');
  assert.strictEqual(res.signal, null);
});

test('LocalSandboxExecutor 超时强杀（sleep 超时被杀）', async () => {
  const ex = new LocalSandboxExecutor();
  const t0 = Date.now();
  const res = await ex.exec({
    command: 'sleep',
    args: ['5'],
    cwd: process.cwd(),
    timeoutMs: 400,
  });
  const dt = Date.now() - t0;
  assert.ok(dt < 3000, `应在超时附近返回，实际耗时 ${dt}ms`);
  assert.ok(res.code !== 0 || res.signal != null, '超时返回非 0 退出码或带信号');
});

test('LocalSandboxExecutor 不存在的命令返回错误结果（不抛异常）', async () => {
  const ex = new LocalSandboxExecutor();
  const res = await ex.exec({
    command: 'this-command-does-not-exist-xyz',
    args: [],
    cwd: process.cwd(),
    timeoutMs: 2000,
  });
  assert.ok(res.stderr.includes('error'), 'stderr 应含错误信息');
  assert.strictEqual(res.code, -2, 'ENOENT 对应 code -2');
});

// ---------------------------------------------------------------------------
// createSandboxExecutor 工厂
// ---------------------------------------------------------------------------

test('createSandboxExecutor 默认/显式 local 返回本地执行器', () => {
  assert.strictEqual(createSandboxExecutor({ backend: 'local' }).kind, 'local');
  assert.strictEqual(createSandboxExecutor().kind, 'local');
});

test('createSandboxExecutor 容器类后端返回容器执行器', () => {
  for (const b of ['container', 'docker', 'podman', 'gvisor', 'kata']) {
    assert.strictEqual(createSandboxExecutor({ backend: b }).kind, 'container', `backend=${b}`);
  }
});

test('ContainerSandboxExecutor 在容器运行时缺失时优雅降级到本地', async () => {
  // 用必然 ENOENT 的二进制名强制触发「容器运行时缺失 → 降级本地执行器」路径，
  // 不受宿主是否装了 docker/podman 影响（CI/本机均可确定性通过）。
  const ex = new ContainerSandboxExecutor({ backend: 'docker', bin: 'harness-nonexistent-runtime-xyz' });
  const res = await ex.exec({
    command: 'node',
    args: ['-e', 'process.stdout.write("fallback-ok")'],
    cwd: process.cwd(),
    timeoutMs: 5000,
  });
  assert.strictEqual(res.code, 0, '降级到本地执行器应正常执行命令');
  assert.ok(res.stdout.includes('fallback-ok'), '降级到本地执行器仍应正常运行');
});

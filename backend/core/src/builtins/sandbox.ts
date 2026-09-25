import { spawn, type ChildProcess } from 'node:child_process';

/**
 * 沙箱执行器抽象（P0-1：OS 级执行隔离）。
 *
 * 背景：原 `builtins/shell.ts` 的 `runCommand` 直接用 `child_process.spawn` 在「与 Node
 * 进程同等权限」下跑命令——这属于「逻辑沙箱」（白名单 + 作用域），但放行后的命令仍能
 * 读写沙箱外文件、任意联网、吃满 CPU/内存。为承载不可信代码，这里把「命令如何被执行」
 * 抽象为 `SandboxExecutor`：
 *   - LocalSandboxExecutor：硬化的本地进程（默认），detach 独立进程组、超时强杀、
 *     擦除敏感环境变量、可选降权（POSIX uid/gid）。
 *   - ContainerSandboxExecutor：把命令放进 OCI 容器（docker/podman）跑，--network none
 *     --read-only --cap-drop ALL --security-opt no-new-privileges，并限制 --memory/--cpus/
 *     --pids-limit，只在挂载进来的工作目录内可写。这是真正的 OS 级隔离。
 * 二者都满足同一个契约，shell 工具在「白名单/作用域/确认」三道闸门之后，把执行委托给
 * 注入的 executor；换 backend 只需改一个环境变量（SANDBOX_BACKEND），shell 逻辑零改动。
 * 容器内二进制缺失时 ContainerSandboxExecutor 优雅降级到本地执行器（保持「一切降级可用」）。
 */

export interface SandboxExecRequest {
  /** 已取 basename 的命令（白名单已校验）。 */
  command: string;
  /** 参数列表（已通过 shell 元字符检查）。 */
  args: string[];
  /** 已锁定在沙箱 root 内的绝对工作目录。 */
  cwd: string;
  /** 额外环境变量（会被自动擦除其中的密钥类键）。默认继承（擦除后）process.env。 */
  env?: Record<string, string>;
  /** 单条命令超时（毫秒）。超时强杀。 */
  timeoutMs: number;
  /** 运行级中止信号。一旦中止立即强杀子进程（含进程组），避免取消/超时后命令仍后台空跑。 */
  signal?: AbortSignal;
  /**
   * 容器执行器专用：本次 exec 的容器名（--name）。提供后，超时/中止路径可用
   * `docker rm -f` 兜底清理孤儿容器（SIGKILL docker CLI 后 --rm 容器仍可能存活）。
   */
  containerName?: string;
}

export interface SandboxExecResult {
  stdout: string;
  stderr: string;
  /** 退出码；异常/超时未拿到退出码时为 null。 */
  code: number | null;
  /** 被信号杀死时的信号名；否则 null。 */
  signal: string | null;
}

/**
 * 子进程输出字节上限（SANDBOX_OUTPUT_MAX_BYTES，默认 1MB；0 / 负数 = 不限，恢复旧行为）。
 * 防止单条 verbose 命令（yes / find /）把 Node 进程内存打穿直至 OOM。
 */
export const SANDBOX_OUTPUT_MAX_BYTES = (() => {
  const n = Number(process.env.SANDBOX_OUTPUT_MAX_BYTES);
  return Number.isFinite(n) ? Math.floor(n) : 1_048_576;
})();

/**
 * 受字节上限约束的输出累积器：超限后停止拼接并追加截断标记。
 * 截断标记会进入 LLM 上下文——模型需要知道「输出不完整」才能改道。
 *
 * UTF-8 安全：
 *  - Uint8Array chunk 经 TextDecoder(stream 模式) 解码，跨 chunk 拆开的多字节字符不会变成 U+FFFD；
 *  - 超限截断按「字符边界回退」切分，避免把半个多字节字符解码成 U+FFFD。
 */
export function createCappedAccumulator(label: string, maxBytes: number = SANDBOX_OUTPUT_MAX_BYTES) {
  let buf = '';
  let bytes = 0;
  let truncated = false;
  let flushed = false;
  const decoder = new TextDecoder('utf-8');
  const limit = Math.max(0, Math.floor(maxBytes));
  // 结束时 flush 解码器残留（补齐最后半个多字节字符）；惰性执行，未截断路径零开销。
  const flushDecoder = () => {
    if (!flushed) {
      flushed = true;
      buf += decoder.decode();
    }
  };
  return {
    push(chunk: unknown): void {
      let str: string;
      if (typeof chunk === 'string') str = chunk;
      else if (chunk instanceof Uint8Array) str = decoder.decode(chunk, { stream: true });
      else str = String(chunk);
      if (limit <= 0) {
        buf += str; // 不限模式：与旧行为一致
        return;
      }
      if (truncated) return;
      const add = Buffer.byteLength(str, 'utf8');
      if (bytes + add <= limit) {
        buf += str;
        bytes += add;
        return;
      }
      const remainBytes = limit - bytes;
      if (remainBytes > 0) {
        const b = Buffer.from(str, 'utf8');
        let cut = Math.min(remainBytes, b.length);
        // 回退到完整字符边界：b[cut] 为 continuation byte（0b10xxxxxx）说明切在字符中间
        while (cut > 0) {
          const byte = b[cut];
          if (byte === undefined || (byte & 0xc0) !== 0x80) break;
          cut--;
        }
        buf += b.subarray(0, cut).toString('utf8');
      }
      truncated = true;
      buf += `\n…[${label} truncated at ${limit} bytes（后续输出已丢弃）]`;
    },
    toString(): string {
      flushDecoder();
      return buf;
    },
    get truncated(): boolean {
      return truncated;
    },
  };
}

export interface SandboxExecutor {
  /** 执行器种类：本地硬化进程 / OCI 容器 / OS 级原生隔离。 */
  readonly kind: 'local' | 'container' | 'os';
  exec(req: SandboxExecRequest): Promise<SandboxExecResult>;
  /**
   * 可选：返回执行器当前的隔离/状态信息（如 OS 沙箱实际生效了哪些原语）。
   * 未实现时返回 undefined；调用方应以可选链访问。
   */
  describe?(): unknown;
}

/**
 * 命中即视为密钥、从子进程环境剔除的变量名片段（不区分大小写）。
 * 用「非字母」作为分隔边界（^ 或 [^A-Za-z]）包裹，使 MY_API_KEY / DB_PASSWORD /
 * GITHUB_TOKEN / AWS_SECRET_ACCESS_KEY 等带下划线分隔的密钥一定命中；同时避免误伤
 * PATH（PAT 后紧跟 H，非分隔边界）、LANG 等正常运行必需变量。
 */
const SECRET_ENV_RE = /(?:^|[^A-Za-z])(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PAT|PRIVATE|API)(?:[^A-Za-z]|$)/i;

/**
 * 擦除敏感环境变量后返回一份干净副本，避免把宿主的 API Key / 令牌泄露给被执行的命令。
 * 保留 PATH、HOME、LANG、TERM 等正常运行所需变量；只丢密钥类键。
 */
export function scrubEnv(env: Record<string, string> | NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v == null) continue;
    if (SECRET_ENV_RE.test(k)) continue;
    out[k] = String(v);
  }
  return out;
}

/**
 * 中止信号接线：当 req.signal 触发 abort 时，立即按进程组（detach）+ 直杀子进程，
 * 并以 SIGKILL 作为结果回传，确保「运行取消 / 超时」后能及时释放资源，而不是傻等到
 * timeoutMs 才强杀（P1 修复：取消 run 后命令仍后台空跑的孤儿进程问题）。
 * finish 自带幂等保护，close 事件触发时移除监听，避免泄漏。
 */
export function wireAbort(
  req: SandboxExecRequest,
  proc: ChildProcess,
  timer: NodeJS.Timeout,
  finish: (r: SandboxExecResult) => void,
  readBuffers: () => { stdout: string; stderr: string }
): void {
  const sig = req.signal;
  if (!sig) return;
  const killChild = () => {
    clearTimeout(timer);
    try {
      if (proc.pid) process.kill(-proc.pid, 'SIGKILL');
    } catch {
      /* 进程组可能已退出 */
    }
    try {
      proc.kill('SIGKILL');
    } catch {
      /* 忽略 */
    }
    const { stdout, stderr } = readBuffers();
    finish({ stdout, stderr, code: null, signal: 'SIGKILL' });
  };
  if (sig.aborted) {
    killChild();
    return;
  }
  const onAbort = () => killChild();
  sig.addEventListener('abort', onAbort, { once: true });
  proc.on('close', () => sig.removeEventListener('abort', onAbort));
}

// ---------------------------------------------------------------------------
// 本地硬化执行器（默认）
// ---------------------------------------------------------------------------

export interface LocalSandboxOptions {
  /** POSIX 降权：以指定 uid 运行子进程（需进程本身有 CAP_SETUID 或以 root 启动）。 */
  dropUid?: number;
  /** POSIX 降权：以指定 gid 运行子进程。 */
  dropGid?: number;
  /** 是否 detach 为独立进程组（默认 true，便于超时按组强杀）。 */
  detached?: boolean;
}

export class LocalSandboxExecutor implements SandboxExecutor {
  readonly kind = 'local' as const;
  constructor(private opts: LocalSandboxOptions = {}) {}

  exec(req: SandboxExecRequest): Promise<SandboxExecResult> {
    return new Promise<SandboxExecResult>((resolve) => {
      let done = false;
      const finish = (r: SandboxExecResult) => {
        if (done) return;
        done = true;
        resolve(r);
      };

      const env = scrubEnv(req.env ?? process.env);
      let proc: ChildProcess;
      try {
        proc = spawn(req.command, req.args, {
          cwd: req.cwd,
          env,
          windowsHide: true,
          detached: this.opts.detached ?? true,
          ...(this.opts.dropUid != null ? { uid: this.opts.dropUid } : {}),
          ...(this.opts.dropGid != null ? { gid: this.opts.dropGid } : {}),
        });
      } catch (e: any) {
        return finish({ stdout: '', stderr: `error: failed to start command: ${e?.message ?? String(e)}`, code: -1, signal: null });
      }

      const out = createCappedAccumulator('stdout');
      const errOut = createCappedAccumulator('stderr');
      proc.stdout?.on('data', (d) => out.push(d));
      proc.stderr?.on('data', (d) => errOut.push(d));

      const timer = setTimeout(() => {
        try {
          if (proc.pid && this.opts.detached !== false) process.kill(-proc.pid, 'SIGKILL');
        } catch {
          /* 进程可能已退出 */
        }
        try {
          proc.kill('SIGKILL');
        } catch {
          /* 忽略 */
        }
      }, req.timeoutMs);

      wireAbort(req, proc, timer, finish, () => ({ stdout: out.toString(), stderr: errOut.toString() }));

      proc.on('error', (err: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        finish({ stdout: out.toString(), stderr: `error: ${err.message}`, code: err.code === 'ENOENT' ? -2 : -1, signal: null });
      });
      proc.on('close', (code, signal) => {
        clearTimeout(timer);
        finish({ stdout: out.toString(), stderr: errOut.toString(), code: code ?? null, signal: signal ?? null });
      });
    });
  }
}

// ---------------------------------------------------------------------------
// 容器执行器（OS 级隔离）
// ---------------------------------------------------------------------------

export interface ContainerSandboxOptions {
  /** 容器运行时：docker 或 podman（默认 docker）。 */
  backend?: 'docker' | 'podman';
  /** 显式指定运行时可执行文件名，覆盖 backend 推导（常用于测试或自定义 runtime）。缺失时按 backend 推导。 */
  bin?: string;
  /** 镜像（默认 alpine:latest）。应预先 docker pull 或配置 always-pull 策略。 */
  image?: string;
  /** 内存上限（MB），--memory。默认 256。 */
  memoryMb?: number;
  /** CPU 限额（核数），--cpus。默认 1。 */
  cpus?: number;
  /** 进程数上限，--pids-limit。默认 128，防 fork 炸弹。 */
  pidsLimit?: number;
  /** 网络模式，默认 none（完全断网）。 */
  network?: 'none' | 'bridge';
  /** 容器 rootfs 只读（默认 true）。工作目录通过挂载可写。 */
  readOnly?: boolean;
  /** 丢弃全部 Linux capabilities（默认 true）。 */
  dropAllCaps?: boolean;
  /** 禁止提权（--security-opt no-new-privileges，默认 true）。 */
  noNewPrivileges?: boolean;
  /** 额外透传给 `run` 的参数。 */
  extraArgs?: string[];
}

/**
 * 纯函数：根据选项与请求拼出容器运行时的完整 argv（含可执行文件名）。
 * 单独抽出便于单测，且 server 端可据此做 dry-run / 审计。
 * 隔离要点：--network none（断网）、--read-only（只读 rootfs）、--cap-drop ALL
 * （去全部能力）、--security-opt no-new-privileges（禁止提权）、--memory/--cpus/
 * --pids-limit（资源封顶）；仅把已锁定的工作目录挂载进 /work 并设为工作目录。
 */
export function buildContainerArgs(o: ContainerSandboxOptions, req: SandboxExecRequest): string[] {
  const bin = o.bin ?? (o.backend === 'podman' ? 'podman' : 'docker');
  const args: string[] = [bin, 'run', '--rm', '-i'];
  const network = o.network ?? 'none';
  if (network === 'none') args.push('--network', 'none');
  else args.push('--network', network);
  if (o.readOnly ?? true) args.push('--read-only');
  if (o.dropAllCaps ?? true) args.push('--cap-drop', 'ALL');
  if (o.noNewPrivileges ?? true) args.push('--security-opt', 'no-new-privileges');
  if (o.memoryMb && o.memoryMb > 0) args.push('--memory', `${o.memoryMb}m`);
  if (o.cpus && o.cpus > 0) args.push('--cpus', String(o.cpus));
  if (o.pidsLimit && o.pidsLimit > 0) args.push('--pids-limit', String(o.pidsLimit));
  // 容器名：提供时（容器执行器会生成唯一名）可在超时/中止后用 rm -f 兜底清理孤儿容器。
  if (req.containerName) args.push('--name', req.containerName);
  if (o.extraArgs && o.extraArgs.length) args.push(...o.extraArgs);
  // 仅挂载已锁定的工作目录（cwd 在 shell 层已被 scope 约束），并设为可写工作目录。
  args.push('-v', `${req.cwd}:/work:rw`);
  args.push('-w', '/work');
  args.push(o.image ?? 'alpine:latest');
  args.push(req.command, ...req.args);
  return args;
}

export class ContainerSandboxExecutor implements SandboxExecutor {
  readonly kind = 'container' as const;
  private fallback = new LocalSandboxExecutor();
  constructor(private opts: ContainerSandboxOptions = {}) {}

  exec(req: SandboxExecRequest): Promise<SandboxExecResult> {
    // 每次 exec 生成唯一容器名：超时/中止只 SIGKILL 了 docker CLI 进程，--rm 容器
    // 可能仍在宿主上空跑成孤儿（持续吃资源）；rm -f 按名兜底清理（修复孤儿容器问题）。
    const containerName = `ah-sb-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const reqWithContainer: SandboxExecRequest = { ...req, containerName };
    const args = buildContainerArgs(this.opts, reqWithContainer);
    const bin = this.opts.bin ?? (this.opts.backend === 'podman' ? 'podman' : 'docker');
    return new Promise<SandboxExecResult>((resolve) => {
      // 与 LocalSandboxExecutor 一致：finish 幂等，避免 ENOENT 时「error 事件触发降级」与
      // 紧随的「close 事件（code -2）」双重 resolve —— 否则会抢先以空结果结束 Promise，
      // 丢掉降级后本地执行器的真实输出。
      let done = false;
      const finish = (r: SandboxExecResult) => {
        if (done) return;
        done = true;
        resolve(r);
      };
      // 异常终止（被杀 / 无退出码）时兜底清理容器：正常退出的容器已被 --rm 移除，
      // rm -f 对不存在的容器报错被忽略（fire-and-forget + unref，不阻塞主流程）。
      const cleanupContainer = () => {
        try {
          const cleanup = spawn(bin, ['rm', '-f', containerName], {
            windowsHide: true,
            detached: true,
            stdio: 'ignore',
          });
          cleanup.unref?.();
        } catch {
          /* 忽略：清理失败不影响结果返回 */
        }
      };
      const finishWithCleanup = (r: SandboxExecResult) => {
        if (r.code === null || r.signal != null) cleanupContainer();
        finish(r);
      };
      // ENOENT 降级期间由 fallback 负责 resolve；标记后 close 事件不再抢答。
      let delegated = false;
      let proc: ChildProcess;
      try {
        proc = spawn(bin, args.slice(1), {
          cwd: req.cwd,
          env: scrubEnv(req.env ?? process.env),
          windowsHide: true,
          timeout: req.timeoutMs,
        });
      } catch (e: any) {
        // 运行时二进制缺失（ENOENT）→ 降级本地执行，保持「一切降级可用」。
        if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') {
          return this.fallback.exec(req).then(finish);
        }
        return finish({ stdout: '', stderr: `error: failed to start sandbox: ${e?.message ?? String(e)}`, code: -1, signal: null });
      }

      const out = createCappedAccumulator('stdout');
      const errOut = createCappedAccumulator('stderr');
      proc.stdout?.on('data', (d) => out.push(d));
      proc.stderr?.on('data', (d) => errOut.push(d));

      const timer = setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {
          /* 忽略 */
        }
      }, req.timeoutMs);
      wireAbort(reqWithContainer, proc, timer, finishWithCleanup, () => ({
        stdout: out.toString(),
        stderr: errOut.toString(),
      }));

      proc.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') {
          // 异步 ENOENT：同样降级本地执行，并由 fallback 负责 resolve。
          delegated = true;
          this.fallback.exec(req).then(finish);
          return;
        }
        finishWithCleanup({ stdout: out.toString(), stderr: `error: ${err.message}`, code: -1, signal: null });
      });
      proc.on('close', (code, signal) => {
        // ENOENT 已委托 fallback：其结果会经 finish 返回，这里不再抢答。
        if (delegated) return;
        finishWithCleanup({ stdout: out.toString(), stderr: errOut.toString(), code: code ?? null, signal: signal ?? null });
      });
    });
  }
}

// ---------------------------------------------------------------------------
// 工厂：按环境变量选择 backend
// ---------------------------------------------------------------------------

export type SandboxBackend =
  | 'local'
  | 'container'
  | 'docker'
  | 'podman'
  | 'gvisor'
  | 'kata'
  | 'os'
  | 'native';

export interface CreateSandboxOptions {
  backend?: string;
  image?: string;
  memoryMb?: number;
  cpus?: number;
  pidsLimit?: number;
  dropUid?: number;
  dropGid?: number;
  /** OS 级沙箱策略（backend 为 'os' / 'native' 时生效）。 */
  osProfile?: import('../sandbox/types').OSSandboxProfile;
  /** 显式指定原生 helper 路径（backend 为 'os' / 'native' 时生效）。 */
  helperPath?: string;
}

/**
 * 按 backend 选择执行器。容器类 backend（container/docker/podman/gvisor/kata）走
 * ContainerSandboxExecutor；'os' / 'native' 走 OSSandboxExecutor（命名空间 + seccomp +
 * 资源限制 + 能力裁剪，依赖 Linux 内核与原生 helper，不可用则自动降级）；
 * 其余（含缺省）走 LocalSandboxExecutor。容器内二进制缺失时 ContainerSandboxExecutor
 * 内部会再降级到本地；OS 路径同理，保持「一切降级可用」。
 */
export function createSandboxExecutor(opts: CreateSandboxOptions = {}): SandboxExecutor {
  const backend = (opts.backend ?? process.env.SANDBOX_BACKEND ?? 'os').toLowerCase();
  const isContainer =
    backend === 'container' || backend === 'docker' || backend === 'podman' || backend === 'gvisor' || backend === 'kata';
  if (isContainer) {
    return new ContainerSandboxExecutor({
      backend: backend === 'podman' ? 'podman' : 'docker',
      image: opts.image ?? process.env.SANDBOX_IMAGE,
      memoryMb: opts.memoryMb ?? (process.env.SANDBOX_MEMORY_MB ? Number(process.env.SANDBOX_MEMORY_MB) : 256),
      cpus: opts.cpus ?? (process.env.SANDBOX_CPUS ? Number(process.env.SANDBOX_CPUS) : 1),
      pidsLimit: opts.pidsLimit ?? (process.env.SANDBOX_PIDS_LIMIT ? Number(process.env.SANDBOX_PIDS_LIMIT) : 128),
    });
  }
  if (backend === 'os' || backend === 'native') {
    // 延迟到函数体内引入，避免与 OS 沙箱模块形成加载期循环依赖。
    const { OSSandboxExecutor } = require('../sandbox/executor') as typeof import('../sandbox/executor');
    return new OSSandboxExecutor(opts.osProfile, { helperPath: opts.helperPath });
  }
  return new LocalSandboxExecutor({ dropUid: opts.dropUid, dropGid: opts.dropGid });
}

import { createInterface } from 'node:readline';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { objectParams, ToolRegistry } from '../tools';
import { createSandboxExecutor, LocalSandboxExecutor, type SandboxExecutor } from './sandbox';

/**
 * 沙箱 shell / 代码执行能力（可选）。
 *
 * 设计目标：让 Agent 能在「受控」前提下运行命令，而不是裸奔地执行任意 shell。
 * 三层闸门前置于执行：
 *   1) 命令白名单（allowlist）——只有声明的命令才能跑，杜绝 rm / curl 等越权。
 *   2) 作用域（scope）——工作目录被锁死在 sandbox root 内，绝对路径与越界均被拒。
 *   3) 确认（confirmation）——可要求 human-in-the-loop 批准，支持多种策略。
 *
 * 默认「关闭」，需显式开启（SHELL_ENABLED=true 或调用方传入 shellEnabled:true），
 * 与项目「一切降级可用、危险能力 opt-in」的约定一致。
 */

/** 一次 shell 执行请求（已解析到绝对 cwd），供 confirm 回调判断。 */
export interface ShellExecRequest {
  /** 被请求执行的基础命令（已取 basename）。 */
  command: string;
  /** 参数列表。 */
  args: string[];
  /** 解析后的绝对工作目录（保证在 root 内）。 */
  cwd: string;
  /** 沙箱根目录。 */
  root: string;
}

export type ShellConfirmStrategy =
  | 'auto' // 自动批准（仅白名单内命令）——适合自动化 / 演示
  | 'deny' // 一律拒绝（requireConfirmation=true 且无策略时的安全默认）
  | 'interactive' // 通过终端 readline 询问操作员（仅本地 CLI / TTY 有效）
  | ((req: ShellExecRequest) => boolean | Promise<boolean>); // 自定义回调（如对接 UI 审批队列）

export interface ShellOptions {
  /** 沙箱根目录；命令只能在 root 内执行。默认 process.cwd()。 */
  root?: string;
  /**
   * 命令白名单：允许执行的「基础命令」列表，如 ['ls','echo','node','python3']。
   * 为空 => 不执行任何命令（安全默认）。匹配时取命令的 basename 比对。
   */
  allowedCommands?: string[];
  /** 是否要求执行前确认（human-in-the-loop）。默认 false。 */
  requireConfirmation?: boolean;
  /**
   * 确认策略（详见 ShellConfirmStrategy）。
   * 省略时：requireConfirmation=false 等同 'auto'（白名单即安全网），
   *         requireConfirmation=true 等同 'deny'（无审批方则拒绝，绝不偷偷执行）。
   */
  confirm?: ShellConfirmStrategy;
  /** 单条命令超时（毫秒）。默认 10000。 */
  timeoutMs?: number;
  /**
   * 允许命令中出现 shell 元字符（| && ; > < $ 等）与管道？
   * 默认 false：只接受「单条命令 + 参数」，杜绝命令注入式拼接。
   */
  allowShellOperators?: boolean;
  /**
   * 执行器（P0-1）：决定「被白名单放行的命令如何被执行」。
   * 默认按 SANDBOX_BACKEND 选择（local 硬化进程 / container 容器内 OS 级隔离）。
   * 三道闸门（白名单/作用域/确认）在此 executor 之前已生效，executor 只改变执行方式。
   */
  executor?: SandboxExecutor;
}

// 常见的 shell 元字符 / 运算符。命中即视为潜在命令注入。
const SHELL_OPERATOR_RE = /[|&;<>$()`\\!*?{}[\]"'\n]/;

// ---------------------------------------------------------------------------
// P1 C6：解释器 inline-eval 逃逸拦截。
// 白名单一旦包含解释器（node / python / bash / perl…），`node -e "…rmSync('/etc/passwd')"`
// 这类 inline-eval 参数即可在解释器内执行任意代码、读写沙箱外任意路径 ——
// cwd 作用域锁与「只跑白名单命令」的承诺同时失效。
// 处置：local 硬化进程执行器（无 OS 级隔离）直接拒绝；container / os 执行器
// 具备真实文件系统隔离，放行。宁可误拒（如 node -c 语法检查），绝不放过逃逸。
// ---------------------------------------------------------------------------

/** 常见解释器的 basename（白名单命中这些命令时启用 inline-eval 检查）。 */
const INTERPRETER_BASENAMES = new Set([
  'node', 'deno', 'bun',
  'python', 'python3', 'python3.x', 'pypy', 'pypy3',
  'perl', 'ruby', 'php', 'php8', 'lua', 'lua5.1', 'lua5.3', 'lua5.4', 'luajit',
  'bash', 'sh', 'zsh', 'ksh', 'dash', 'fish', 'csh', 'tcsh',
  'tclsh', 'wish', 'awk', 'gawk', 'mawk', 'nawk',
  'julia', 'Rscript', 'ghci', 'pwsh', 'powershell',
]);

/**
 * 检测参数中是否携带 inline-eval 标志。返回命中的参数（供错误信息展示），无则 null。
 * 短参数按组合形式整体匹配（-e / -c / -pe / -ec …均命中）；宁可误拒不放过。
 */
function detectInterpreterInlineEval(base: string, args: string[]): string | null {
  if (!INTERPRETER_BASENAMES.has(base)) return null;
  for (const a of args) {
    if (a.startsWith('--')) {
      if (a === '--eval' || a === '--exec' || a.startsWith('--eval=') || a.startsWith('--exec=')) return a;
      continue;
    }
    if (a.length > 1 && a.startsWith('-') && /^-[a-zA-Z]*[ecpr]/.test(a)) return a;
  }
  return null;
}

export function registerShell(registry: ToolRegistry, opts: ShellOptions = {}): void {
  const root = resolve(opts.root ?? process.cwd());
  const allowed = new Set((opts.allowedCommands ?? []).map((c) => c.trim()).filter(Boolean));
  const requireConfirmation = opts.requireConfirmation ?? false;
  const confirm: ShellConfirmStrategy = opts.confirm ?? (requireConfirmation ? 'deny' : 'auto');
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const allowShellOperators = opts.allowShellOperators ?? false;
  const executor: SandboxExecutor = opts.executor ?? createSandboxExecutor();

  registry.register(
    'builtin__shell_exec',
    'Execute a single whitelisted command inside a sandboxed working directory. ' +
      'Only commands in the configured allowlist may run; the working directory is ' +
      'restricted to the sandbox root; execution can require human confirmation. ' +
      'Returns combined stdout/stderr and exit status. Shell operators are forbidden ' +
      'unless explicitly enabled.',
    objectParams(
      {
        command: {
          type: 'string',
          description:
            'Command name from the allowlist, e.g. "ls", "node", "python3". Absolute paths are reduced to basename for the allowlist check.',
        },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional ordered list of string arguments passed to the command.',
        },
        cwd: {
          type: 'string',
          description: 'Optional working directory relative to the sandbox root (default: root).',
        },
      },
      ['command']
    ),
    async (args: Record<string, unknown>, ctx?: Record<string, unknown>) => {
      const command = String(args.command ?? '').trim();
      if (!command) return 'error: missing command';
      const argList = Array.isArray(args.args) ? args.args.map(String) : [];
      const cwdRel = args.cwd != null ? String(args.cwd) : '.';

      // 1) 命令白名单
      const base = command.includes(sep) ? command.split(sep).pop()! : command;
      if (!allowed.has(command) && !allowed.has(base)) {
        const list = allowed.size ? ` (allowed: ${[...allowed].join(', ')})` : ' (allowlist empty)';
        return `error: command not in allowlist: ${command}${list}`;
      }

      // 1.5) P1 C6：解释器 inline-eval 逃逸拦截（详见 detectInterpreterInlineEval 注释）。
      //      仅在无真实文件系统隔离的 local 执行器上拒绝；container / os 执行器放行。
      const inlineEval = detectInterpreterInlineEval(base, argList);
      if (inlineEval && executor instanceof LocalSandboxExecutor) {
        return (
          `error: interpreter inline-eval is blocked on the local sandbox backend: ` +
          `"${base} ${inlineEval} …" executes arbitrary code that can read/write any path outside ` +
          `the sandbox root (allowlist + cwd lock do not contain it). ` +
          `Set SANDBOX_BACKEND=container or =os for real isolation, or drop the inline-eval flag.`
        );
      }

      // 2) 拒绝 shell 元字符 / 运算符（除非显式开启）
      if (!allowShellOperators) {
        const joined = [command, ...argList].join(' ');
        if (SHELL_OPERATOR_RE.test(joined)) {
          return 'error: shell operators are disabled (set allowShellOperators to enable pipelines/redirection)';
        }
      }

      // 3) 作用域：cwd 必须在 root 内
      let cwdAbs: string;
      try {
        cwdAbs = resolveScope(root, cwdRel);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return `error: ${msg}`;
      }

      // 4) 确认（human-in-the-loop）
      if (requireConfirmation) {
        let approved = false;
        try {
          approved = await evalConfirm(confirm, { command: base, args: argList, cwd: cwdAbs, root });
        } catch {
          approved = false;
        }
        if (!approved) {
          return `error: execution denied by confirmation policy (command: ${base})`;
        }
      }

      // 5) 执行：委托给注入的 SandboxExecutor（local 硬化 / container 隔离）。
      //    透传运行级 abort 信号：run 被取消/超时后及时强杀子进程（避免孤儿进程）。
      const signal = (ctx?.signal as AbortSignal | undefined) ?? undefined;
      const res = await executor.exec({ command: base, args: argList, cwd: cwdAbs, timeoutMs, signal });
      const status = res.signal ? `killed by ${res.signal}` : `exit code ${res.code ?? -1}`;
      const body = [res.stdout, res.stderr].filter(Boolean).join('') || '(no output)';
      return `[${status}]\n${body}`;
    },
    'builtin'
  );
}

/** 将相对 cwd 解析到 root 内；绝对路径或越界均抛错。 */
function resolveScope(root: string, cwdRel: string): string {
  if (isAbsolute(cwdRel)) throw new Error(`absolute cwd not allowed: ${cwdRel}`);
  const abs = resolve(root, cwdRel);
  const rel = relative(root, abs);
  if (rel.startsWith('..')) throw new Error(`cwd escapes sandbox root: ${cwdRel}`);
  return abs;
}

async function evalConfirm(confirm: ShellConfirmStrategy, req: ShellExecRequest): Promise<boolean> {
  if (typeof confirm === 'function') return await confirm(req);
  if (confirm === 'auto') return true;
  if (confirm === 'deny') return false;
  if (confirm === 'interactive') return interactiveConfirm(req);
  return false;
}

/** 终端交互确认：仅在 TTY 下有效，否则安全回退为拒绝（避免无输入时挂起）。 */
function interactiveConfirm(req: ShellExecRequest): Promise<boolean> {
  if (!process.stdin.isTTY) return Promise.resolve(false);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const prompt = `⚠️  允许在沙箱内执行 [${req.command} ${req.args.join(' ')}] @ ${req.cwd} ? (y/N) `;
  return new Promise<boolean>((resolve) => {
    rl.question(prompt, (ans: string) => {
      rl.close();
      resolve(/^y(es)?$/i.test(ans.trim()));
    });
  });
}

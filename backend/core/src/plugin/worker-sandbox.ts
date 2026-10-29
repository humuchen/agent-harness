/**
 * worker-sandbox.ts — tools-only 插件 worker 隔离（长期项落地，tools-only 先行）。
 *
 * 背景：manifest.isolation 声明（none|local|os|container）此前仅是记录；
 * PluginLoaderOptions.sandbox 钩子为 no-op。本模块兑现第一档真实隔离：
 * **entry 插件在 worker_threads 中加载**，工具注册/调用经 postMessage RPC ——
 * 插件代码崩溃/死循环不拖垮宿主（调用有超时看门狗），密钥面收敛为白名单子集。
 *
 * 诚实边界：
 * - 仅支持 **tools-only 插件**（server 路由 / web 视图 / events / cron / A2A 不跨线程代理）；
 * - 工具入参/返回值须为可结构化克隆的 JSON 值；
 * - isolation: 'none' 的插件仍走进程内形态（installModule），零回归；
 * - entry 由调用方解析为绝对路径（loader 侧不做用户输入拼接）。
 *
 * 生命周期：start() → ready 门控 → getTools()（facade Registry，注册进主线程
 * 工具表）→ stop()（terminate worker，disable/uninstall 时调用）。
 */

import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { ToolRegistry } from '../tools';
import { resolvePluginEnv } from './loader';
import type { PluginManifest } from './manifest';

/** 工具调用默认超时（ms）。 */
const DEFAULT_CALL_TIMEOUT_MS = 30_000;

type RpcFrame =
  | { type: 'register'; name: string; description: string; schema: Record<string, unknown> }
  | { type: 'ready' }
  | { type: 'load-error'; error: string }
  | { type: 'result'; id: number; ok: boolean; value?: unknown; error?: string }
  | { type: 'call'; id: number; name: string; args: Record<string, unknown> };

interface PendingCall {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export interface WorkerSandboxOptions {
  manifest: PluginManifest;
  /** 插件入口绝对路径（CommonJS；导出 setup(ctxLite)）。 */
  entry: string;
  /** 工具调用超时（默认 30s；死循环插件不拖垮宿主）。 */
  timeoutMs?: number;
  /** 额外透传给 worker 的 env 变量名（叠加在白名单之上，loader 的 envAllowlist 语义）。 */
  envAllowlist?: string[];
  /** P2 插件资源配额：单次运行内该插件工具调用次数上限（超限拒绝）。缺省不限制。 */
  maxCallsPerRun?: number;
}

export class WorkerToolsSandbox {
  private worker: Worker | null = null;
  private readonly facade = new ToolRegistry();
  private readonly pending = new Map<number, PendingCall>();
  private nextCallId = 1;
  private readonly timeoutMs: number;
  private readonly opts: WorkerSandboxOptions;
  private stopped = false;
  /** P2 插件资源配额：本 run 内已发起的插件调用计数。 */
  private callCount = 0;

  constructor(opts: WorkerSandboxOptions) {
    this.opts = opts;
    // manifest.quota.callTimeoutMs 为默认超时（startWorkerSandbox 已传；直接构造时回退）。
    this.timeoutMs = Math.max(1000, opts.timeoutMs ?? opts.manifest.quota?.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS);
  }

  /** 启动 worker 并等待插件 ready（注册阶段完成）。失败（load-error/超时）抛错。 */
  async start(): Promise<void> {
    if (this.worker) throw new Error('worker sandbox already started');
    const bootstrapJs = path.join(__dirname, 'worker-bootstrap.js');
    // 与进程内插件同一密钥纪律：白名单子集进入 worker env。
    // 关键：必须经 Worker 的 env 选项收敛 worker 的 process.env —— worker_threads
    // 默认继承父进程完整环境，插件代码里的 process.env.ADMIN_API_KEY 会直接可见，
    // 仅靠 workerData 传白名单子集形同虚设（守护测试覆盖的正是这条通道）。
    const env = resolvePluginEnv(process.env, this.opts.envAllowlist) as Record<string, string>;
    const worker = new Worker(bootstrapJs, {
      workerData: {
        entry: this.opts.entry,
        env,
        manifest: { id: this.opts.manifest.id, version: this.opts.manifest.version, name: this.opts.manifest.name },
      },
      env: { ...env }, // 收敛 worker 的 process.env（杜绝继承父进程密钥）
    });
    this.worker = worker;

    await new Promise<void>((resolve, reject) => {
      const onMessage = (msg: RpcFrame): void => {
        if (msg.type === 'register') {
          this.registerToolFromWorker(msg.name, msg.description, msg.schema);
          return;
        }
        if (msg.type === 'ready') {
          worker.off('message', onMessage);
          worker.on('message', this.onMessage);
          resolve();
        } else if (msg.type === 'load-error') {
          worker.off('message', onMessage);
          reject(new Error(`插件 worker 加载失败：${msg.error}`));
        }
      };
      worker.on('message', onMessage);
      worker.on('error', (e) => {
        worker.off('message', onMessage);
        reject(new Error(`插件 worker 异常退出：${e.message}`));
      });
    });
  }

  private onMessage = (msg: RpcFrame): void => {
    if (msg.type !== 'result') return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg.value);
    else p.reject(new Error(msg.error ?? 'worker tool call failed'));
  };

  /** worker 注册的工具 → 主线程 facade Registry（handler 转发 RPC）。 */
  private registerToolFromWorker(
    name: string,
    description: string,
    schema: Record<string, unknown>,
  ): void {
    this.facade.register(
      name,
      description,
      schema,
      async (args: Record<string, unknown>) => this.call(name, args),
    );
  }

  /** RPC 调用（带超时看门狗 + P2 调用配额）。 */
  private call(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (this.stopped || !this.worker) {
      return Promise.reject(new Error('插件 worker 已停止'));
    }
    // P2 插件资源配额：超过 maxCallsPerRun 的调用被拒绝（防插件无限循环拖垮宿主）。
    // 显式 opts 优先，缺省回退 manifest.quota.maxCallsPerRun。
    const max = this.opts.maxCallsPerRun ?? this.opts.manifest.quota?.maxCallsPerRun;
    if (max && max > 0) {
      if (this.callCount >= max) {
        return Promise.reject(new Error(`插件 ${this.opts.manifest.id} 调用次数超限（>${max}）`));
      }
      this.callCount++;
    }
    const id = this.nextCallId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`插件工具 ${name} 调用超时（>${this.timeoutMs}ms）`));
      }, this.timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      const frame: RpcFrame = { type: 'call', id, name, args };
      this.worker!.postMessage(frame);
    });
  }

  /** worker 注册的工具门面（enable 时由 loader 合并进进程共享插件工具表）。 */
  getTools(): ToolRegistry {
    return this.facade;
  }

  /** 终止 worker（幂等）；挂起调用全部拒绝。 */
  stop(): void {
    this.stopped = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('插件 worker 已被终止'));
    }
    this.pending.clear();
    if (this.worker) {
      void this.worker.terminate();
      this.worker = null;
    }
  }
}

// ---------------------------------------------------------------------------
// loader 集成：entry + isolation ≠ none → worker 沙箱形态。
// 由 PluginLoader 在 enable 阶段调用（见 loader.ts 的 startWorkerSandbox）。
// ---------------------------------------------------------------------------

/** 进程级沙箱表（pluginId → sandbox；disable/uninstall 时 stop）。 */
const sandboxes = new Map<string, WorkerToolsSandbox>();

/** 判定某清单是否应走 worker 沙箱形态（entry 存在且声明了非 none 隔离）。 */
export function shouldUseWorkerSandbox(manifest: PluginManifest): boolean {
  return !!manifest.entry && manifest.isolation !== undefined && manifest.isolation !== 'none';
}

/**
 * 启动 entry 插件的 worker 沙箱并把工具合入给定 ctx.tools。
 * @throws worker 加载失败（入口缺失/加载错误）时抛错 —— enable 失败回滚，fail-fast。
 */
export async function startWorkerSandbox(
  manifest: PluginManifest,
  targetTools: ToolRegistry,
  opts: { envAllowlist?: string[]; timeoutMs?: number } = {},
): Promise<WorkerToolsSandbox> {
  const entryPath = path.resolve(manifest.entry as string);
  const sandbox = new WorkerToolsSandbox({
    manifest,
    entry: entryPath,
    envAllowlist: opts.envAllowlist,
    // manifest.quota.callTimeoutMs 声明插件单次调用超时；loader 显式传入的 timeoutMs 优先。
    timeoutMs: opts.timeoutMs ?? manifest.quota?.callTimeoutMs,
    maxCallsPerRun: manifest.quota?.maxCallsPerRun,
  });
  await sandbox.start();
  sandboxes.set(manifest.id, sandbox);
  // 把 worker 内注册的工具转注册进插件 ctx.tools（loader 随后按 `${pluginId}__` 合并进共享表）。
  for (const { name, schema, fn } of sandbox.getTools().entries()) {
    targetTools.register(name, schema.description, schema.parameters, fn);
  }
  return sandbox;
}

/** 停止某插件的 worker 沙箱（disable/uninstall 时由 loader 调用；幂等）。 */
export function stopWorkerSandbox(pluginId: string): void {
  const sandbox = sandboxes.get(pluginId);
  if (sandbox) {
    sandbox.stop();
    sandboxes.delete(pluginId);
  }
}

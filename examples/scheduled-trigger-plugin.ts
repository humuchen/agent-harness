/**
 * 外部接入样例 ③：插件「进程内定时自触发」（含重启 reclaim）。
 *
 * 背景：agent-harness 当前**没有内置 cron / scheduling 子系统**。定时触发有两条路线：
 *   路线 A（推荐、最稳）：外部 OS 调度器周期性 POST /api/run
 *            —— 见 scripts/cron-run-example.sh（cron / systemd-timer / 外部 SaaS）。
 *   路线 B（轻量、需自管生命周期）：插件在 onStart 里 setInterval，自己定时触发自己。
 *            —— 本文件演示路线 B，并解决它最大的坑：Render 等平台**重启后会杀掉进程内定时器**，
 *               必须在 onStart 时从持久化状态里「追回」错过的 slot（catch-up），否则定时任务会丢。
 *
 * 本样例要点（均已用最小可跑方式落地，可直接 node 跑出效果）：
 *   - 幂等：用「slot 序号」做执行键，同一 slot 绝不重复执行（即使定时器因抖动重叠）。
 *   - 持久化：每次执行后把 lastExecutedSlot 落盘（tmp + rename 原子写），进程重启可恢复。
 *   - 重启 reclaim：onStart 立即跑一次 catch-up，把错过且未执行的 slot 补回来（带上限防止雪崩）。
 *   - 失败告警：触发失败（如本例默认无 server → ECONNREFUSED）走 ctx.events.emit 告警通道，
 *     并记录连续失败次数，供外部 Webhook / 日志 sink 采集。
 *   - 时区：interval 模式基于 epoch 毫秒，**与时区无关**；需要「每天 09:00 北京时间」时应改用
 *     cron 表达式 / 时区感知的 next-run 计算（见文档「时区注意事项」一节）。
 *
 * 运行：
 *   pnpm -r build
 *   pnpm --filter @agent-harness/examples run scheduled-trigger
 * （默认演示 8s 后自动 stop 退出；期间会按 2s 间隔触发若干次，因无 server 而演示失败告警路径。）
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import https from 'node:https';
import {
  PluginLoader,
  getAgentRegistry,
  type PluginManifest,
  type PluginModule,
  type PluginContext,
  type PluginEvent,
} from '@agent-harness/core';

// ---------------------------------------------------------------------------
// 1) 配置与状态
// ---------------------------------------------------------------------------

interface SchedulerConfig {
  /** 触发间隔（毫秒）。 */
  intervalMs: number;
  /** 状态文件（持久化 lastExecutedSlot，用于重启 reclaim）。 */
  stateFile: string;
  /** 调度起点 epoch（用于把时间切成固定 slot）。 */
  startEpoch: number;
  /** 单次 catch-up 最多补几个 slot，防止重启后雪崩。 */
  catchUpCap: number;
}

interface SchedulerState {
  startEpoch: number;
  intervalMs: number;
  /** 已执行到的最大 slot 序号；-1 表示尚未执行任何 slot。 */
  lastExecutedSlot: number;
  lastError?: string;
  consecutiveFailures: number;
}

type EmitFn = (e: PluginEvent) => void;

// ---------------------------------------------------------------------------
// 2) 原子写 & 状态读写
// ---------------------------------------------------------------------------

/** tmp + rename 原子写（进程崩溃也不会留下半截 JSON）。 */
function atomicWrite(file: string, data: string): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function loadState(cfg: SchedulerConfig): SchedulerState {
  try {
    const parsed = JSON.parse(fs.readFileSync(cfg.stateFile, 'utf8')) as SchedulerState;
    // 用本次配置校正运行期参数（state 只持久化「进度」，不持久化「配置」）。
    return { ...parsed, startEpoch: cfg.startEpoch, intervalMs: cfg.intervalMs };
  } catch {
    return {
      startEpoch: cfg.startEpoch,
      intervalMs: cfg.intervalMs,
      lastExecutedSlot: -1,
      consecutiveFailures: 0,
    };
  }
}

// ---------------------------------------------------------------------------
// 3) 触发动作：POST /api/run（best-effort，失败抛错交由调度器处理）
// ---------------------------------------------------------------------------

interface RunResult {
  ok: boolean;
  status: number;
  body: string;
}

/** 向本地 harness 发起一次运行（Authorization: Bearer <OPEN_API_KEY>）。 */
function postRun(baseUrl: string, apiKey: string, payload: object): Promise<RunResult> {
  return new Promise((resolve) => {
    let url: URL;
    try {
      url = new URL(baseUrl.replace(/\/+$/, '') + '/api/run');
    } catch {
      resolve({ ok: false, status: 0, body: 'bad baseUrl' });
      return;
    }
    const lib = url.protocol === 'https:' ? https : http;
    const data = JSON.stringify(payload);
    const req = lib.request(
      url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
          'content-length': Buffer.byteLength(data).toString(),
        },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () =>
          resolve({ ok: (res.statusCode ?? 500) < 400, status: res.statusCode ?? 0, body })
        );
      }
    );
    req.on('error', (e) => resolve({ ok: false, status: 0, body: e.message }));
    req.setTimeout(5000, () => req.destroy(new Error('timeout')));
    req.write(data);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// 4) 自触发调度器（interval 模式 + slot 幂等 + 重启 catch-up）
// ---------------------------------------------------------------------------

class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private state: SchedulerState;

  constructor(
    private readonly cfg: SchedulerConfig,
    private readonly logger: PluginContext['logger'],
    private readonly emit: EmitFn
  ) {
    this.state = loadState(cfg);
  }

  /** 当前时间落在第几个 slot（从 startEpoch 起每 intervalMs 一个）。 */
  private slotIndex(now: number): number {
    return Math.floor((now - this.state.startEpoch) / this.state.intervalMs);
  }

  private persist(): void {
    try {
      atomicWrite(this.cfg.stateFile, JSON.stringify(this.state));
    } catch (e) {
      this.logger.warn('scheduler state persist failed', { error: String(e) });
    }
  }

  /**
   * 启动轮询。每个 tick：
   *   - 跳过已执行 slot（幂等）；
   *   - 从「上次+1」追到「当前 slot」，但单次最多 catchUpCap 个（防雪崩）；
   *   - 每个 slot 触发一次，成功推进 lastExecutedSlot，失败发告警并继续。
   * 轮询粒度封顶 15s（避免 interval 过大时错过太久）。
   */
  start(onTrigger: (slot: number) => Promise<void>): void {
    const tick = async (): Promise<void> => {
      if (this.running) return; // 防止上一次还没跑完就重叠
      this.running = true;
      try {
        const now = Date.now();
        const slot = this.slotIndex(now);
        if (slot <= this.state.lastExecutedSlot) return; // 幂等：已执行

        const from = Math.max(this.state.lastExecutedSlot + 1, slot - this.cfg.catchUpCap + 1);
        for (let s = from; s <= slot; s++) {
          try {
            await onTrigger(s);
            this.state.consecutiveFailures = 0;
            this.state.lastError = undefined;
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            this.state.consecutiveFailures += 1;
            this.state.lastError = msg;
            // 失败告警：走核心 alert 通道（Webhook / 日志 sink 可采集）。
            this.emit({
              type: 'plugin:alert',
              plugin: 'scheduled-ping',
              reason: 'trigger_failed',
              slot: s,
              error: msg,
              consecutive: this.state.consecutiveFailures,
            });
          }
          // 无论成败，本 slot 只执行一次（幂等）：失败已发告警，不在后续 tick 反复重试。
          this.state.lastExecutedSlot = s;
          this.persist(); // 每步落盘，崩溃也不丢进度
        }
      } finally {
        this.running = false;
      }
    };

    // 立即跑一次：处理「重启错过的 slot」（catch-up）。
    void tick();
    this.timer = setInterval(() => void tick(), Math.min(this.cfg.intervalMs, 15_000));
  }

  /** 停止并清理定时器（onStop 调用）。 */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

// ---------------------------------------------------------------------------
// 5) 插件定义
// ---------------------------------------------------------------------------

const scheduledPingManifest: PluginManifest = {
  id: 'scheduled-ping',
  version: '1.0.0',
  name: '定时自触发示例',
  description: '演示插件进程内定时触发 + 重启 reclaim。生产请用外部 cron（见文档）。',
  domain: 'generic',
  capabilities: [{ id: 'scheduler-demo' }],
  isolation: 'none',
};

/** 注销句柄收集（onStop / onUnload 对称清理）。 */
const cleanupFns: Array<() => void> = [];

export const scheduledPingPlugin: PluginModule = {
  manifest: scheduledPingManifest,

  async setup(ctx: PluginContext): Promise<void> {
    // 此处只做轻量注册/订阅；真正起定时器在 onStart（启用后才进入 Running）。
    ctx.logger.info('scheduled-ping setup', {
      intervalMs: Number(ctx.env.SCHEDULE_INTERVAL_MS ?? 60_000),
    });
  },

  async onStart(ctx: PluginContext): Promise<void> {
    const intervalMs = Number(ctx.env.SCHEDULE_INTERVAL_MS ?? 60_000);
    const startEpoch = Date.now();
    const stateFile = String(
      ctx.env.SCHEDULE_STATE_FILE ??
        path.join(os.tmpdir(), 'agent-harness', 'scheduled-ping-state.json')
    );
    const baseUrl = String(ctx.env.HARNESS_BASE_URL ?? 'http://127.0.0.1:4173');
    const apiKey = String(ctx.env.OPEN_API_KEY ?? '');
    const prompt = String(ctx.env.SCHEDULE_PROMPT ?? '执行一次定时巡检任务。');
    const agentId = ctx.env.SCHEDULE_AGENT_ID ?? '';
    const emit = (e: PluginEvent) => ctx.events.emit(e);

    const sched = new Scheduler(
      { intervalMs, stateFile, startEpoch, catchUpCap: 10 },
      ctx.logger,
      emit
    );

    sched.start(async (slot) => {
      ctx.logger.info('scheduled trigger firing', { slot });
      // runId 用 slot 编码：即便 server 端也按 runId 去重，天然幂等。
      const res = await postRun(baseUrl, apiKey, {
        prompt,
        agentId: agentId || undefined,
        runId: `scheduled-ping:${slot}`,
        meta: { scheduled: true, slot },
      });
      if (!res.ok) {
        throw new Error(`/api/run → HTTP ${res.status} ${res.body}`);
      }
      ctx.logger.info('scheduled trigger ok', { slot, status: res.status });
    });

    cleanupFns.push(() => sched.stop());
    ctx.logger.info('scheduled-ping started', { intervalMs, stateFile });
  },

  async onStop(ctx: PluginContext): Promise<void> {
    while (cleanupFns.length) {
      try {
        cleanupFns.pop()?.();
      } catch {
        /* 单个清理失败不阻断 */
      }
    }
    ctx.logger.info('scheduled-ping stopped');
  },

  async onUnload(ctx: PluginContext): Promise<void> {
    while (cleanupFns.length) {
      try {
        cleanupFns.pop()?.();
      } catch {
        /* 单个清理失败不阻断 */
      }
    }
    ctx.logger.info('scheduled-ping unloaded');
  },
};

export default scheduledPingPlugin;

// ---------------------------------------------------------------------------
// 6) 自包含演示：用最小 loader 驱动插件生命周期（无需真实 server）。
//    真实环境中由 access/server 的 bootstrapPlugins 经 PluginLoader 启用本插件。
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // 演示参数：2s 间隔、8s 后自动退出；默认无 server → 用来演示「失败告警」路径。
  process.env.SCHEDULE_INTERVAL_MS = process.env.SCHEDULE_INTERVAL_MS ?? '2000';
  process.env.SCHEDULE_STATE_FILE =
    process.env.SCHEDULE_STATE_FILE ??
    path.join(os.tmpdir(), 'agent-harness', 'scheduled-ping-demo-state.json');
  const demoMs = Number(process.env.SCHEDULE_DEMO_MS ?? 8000);

  const loader = new PluginLoader({ registry: getAgentRegistry() });
  await loader.installModule(scheduledPingPlugin);
  await loader.enable(scheduledPingPlugin.manifest.id); // → setup + onStart（起定时器）

  console.log(`[scheduled] 演示中：每 2s 触发一次，约 ${demoMs}ms 后自动停止…`);
  await new Promise((r) => setTimeout(r, demoMs));

  await loader.disable(scheduledPingPlugin.manifest.id); // → onStop（清定时器）
  console.log('[scheduled] 演示结束（定时器已停，进程退出）。');
}

main().catch((e) => {
  console.error('[scheduled] 失败：', e);
  process.exit(1);
});

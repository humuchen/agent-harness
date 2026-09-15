/**
 * 客服提醒定时触发插件（进程内定时自触发 + 重启 reclaim）。
 *
 * 功能：每 5min 触发医美 agent 自动分析 leads 数据，输出 JSON 写入 cs_reminder 表，
 * 供客服看板轮询 + SSE 实时推送。
 *
 * 复用 examples/scheduled-trigger-plugin.ts 的 slot 幂等 + 重启补发模式。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import https from 'node:https';
import {
  type PluginManifest,
  type PluginModule,
  type PluginContext,
  type PluginEvent,
} from '@agent-harness/core';

// ---------------------------------------------------------------------------
// 1) 配置与状态
// ---------------------------------------------------------------------------

interface SchedulerConfig {
  intervalMs: number;
  stateFile: string;
  startEpoch: number;
  catchUpCap: number;
}

interface SchedulerState {
  startEpoch: number;
  intervalMs: number;
  lastExecutedSlot: number;
  lastError?: string;
  consecutiveFailures: number;
}

type EmitFn = (e: PluginEvent) => void;

// ---------------------------------------------------------------------------
// 2) 原子写 & 状态读写
// ---------------------------------------------------------------------------

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
// 3) 触发动作：POST /api/run 并解析 SSE 流获取最终输出
// ---------------------------------------------------------------------------

interface RunResult {
  ok: boolean;
  status: number;
  finalText: string;
}

/**
 * 向本地 harness 发起一次运行，解析 SSE 流获取 run:end 的 final 文本。
 * 使用 Bearer *** 认证（与 scheduled-trigger-plugin 一致）。
 */
function postRunAndParse(baseUrl: string, apiKey: string, payload: object): Promise<RunResult> {
  return new Promise((resolve) => {
    let url: URL;
    try {
      url = new URL(baseUrl.replace(/\/+$/, '') + '/api/run');
    } catch {
      resolve({ ok: false, status: 0, finalText: '' });
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
          accept: 'text/event-stream',
        },
      },
      (res) => {
        let body = '';
        res.on('data', (c: Buffer) => {
          body += c.toString('utf8');
        });
        res.on('end', () => {
          const statusCode = res.statusCode ?? 500;
          if (statusCode >= 400) {
            resolve({ ok: false, status: statusCode, finalText: '' });
            return;
          }
          // 解析 SSE 流：找 run:end 事件的 final 字段
          let finalText = '';
          const lines = body.split('\n');
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const evt = JSON.parse(line.slice(6));
                if (evt.type === 'run:end' && typeof evt.final === 'string') {
                  finalText = evt.final;
                }
              } catch {
                // 忽略非 JSON 行
              }
            }
          }
          resolve({ ok: true, status: statusCode, finalText });
        });
      }
    );
    req.on('error', (_e) => resolve({ ok: false, status: 0, finalText: '' }));
    req.setTimeout(120_000, () => req.destroy(new Error('timeout')));
    req.write(data);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// 4) 分析 prompt 模板
// ---------------------------------------------------------------------------

const ANALYSIS_PROMPT = `你是一名医美客服数据分析员。请基于 ma_lead 表中的真实数据库，使用 analytics_query 工具自动完成以下分析：

**查询方式**：调用 analytics_query，type="inactive"，daysThreshold=14

这将返回一个 JSON 数组，其中每个元素包含：
- leadId, name, phone, project, lastVisit, daysSince（距上次到院/咨询天数）, activityTitle, activityId

**检查活动关联**：检查 project 对应的 ma_project.activity_title / activity_id 是否有近期活动。

**输出格式**（严格 JSON，不要 markdown 包裹）：
{
  "type": "reminder.inactive_lead",
  "generatedAt": <当前时间戳毫秒>,
  "items": [
    {
      "leadId": "xxx",
      "name": "张三",
      "phone": "138xxxx",
      "project": "玻尿酸",
      "lastVisit": "2024-01-01T10:00:00Z",
      "daysSince": 18,
      "activityTitle": "会员日特惠",
      "activityId": "act_123"
    }
  ]
}

**规则**：
- 所有数据必须来自 analytics_query 工具的真实查询结果，禁止编造
- 只返回 JSON，不要任何解释文字
- 字段缺失时用 null 填充
- 如果没有符合条件的客户，返回 { "type": "reminder.inactive_lead", "generatedAt": ..., "items": [] }`;

// ---------------------------------------------------------------------------
// 5) 自触发调度器（interval 模式 + slot 幂等 + 重启 catch-up）
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

  start(onTrigger: (slot: number) => Promise<void>): void {
    const tick = async (): Promise<void> => {
      if (this.running) return;
      this.running = true;
      try {
        const now = Date.now();
        const slot = this.slotIndex(now);
        if (slot <= this.state.lastExecutedSlot) return;

        const from = Math.max(this.state.lastExecutedSlot + 1, slot - this.cfg.catchUpCap + 1);
        for (let s = from; s <= slot; s++) {
          try {
            await onTrigger(s);
            this.state.consecutiveFailures = 0;
            this.state.lastError = undefined;
          } catch (_e) {
            const msg = _e instanceof Error ? _e.message : String(_e);
            this.state.consecutiveFailures += 1;
            this.state.lastError = msg;
            this.emit({
              type: 'plugin:alert',
              plugin: 'cs-reminders-trigger',
              reason: 'trigger_failed',
              slot: s,
              error: msg,
              consecutive: this.state.consecutiveFailures,
            });
          }
          this.state.lastExecutedSlot = s;
          this.persist();
        }
      } finally {
        this.running = false;
      }
    };

    void tick();
    this.timer = setInterval(() => void tick(), Math.min(this.cfg.intervalMs, 15_000));
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

// ---------------------------------------------------------------------------
// 6) 插件定义
// ---------------------------------------------------------------------------

const manifest: PluginManifest = {
  id: 'cs-reminders-trigger',
  version: '1.0.0',
  name: '客服提醒定时触发',
  description: '定时触发医美 agent 分析 leads 数据，生成提醒写入 cs_reminder 表',
  domain: 'customer-service',
  capabilities: [{ id: 'reminder-scheduler' }],
  isolation: 'none',
};

const cleanupFns: Array<() => void> = [];

export const csRemindersTriggerPlugin: PluginModule = {
  manifest,

  async setup(ctx: PluginContext): Promise<void> {
    ctx.logger.info('cs-reminders-trigger setup', {
      intervalMs: Number(ctx.env.REMINDER_INTERVAL_MS ?? 5 * 60_000),
    });
  },

  async onStart(ctx: PluginContext): Promise<void> {
    const intervalMs = Number(ctx.env.REMINDER_INTERVAL_MS ?? 5 * 60_000);
    const startEpoch = Date.now();
    const stateFile = String(
      ctx.env.REMINDER_STATE_FILE ??
        path.join(os.tmpdir(), 'agent-harness', 'cs-reminders-state.json')
    );
    const baseUrl = String(ctx.env.HARNESS_BASE_URL ?? 'http://127.0.0.1:4173');
    const apiKey = String(ctx.env.OPEN_API_KEY ?? '');
    const agentId = 'medical-aesthetics-lead';
    const emit = (e: PluginEvent) => ctx.events.emit(e);

    const sched = new Scheduler(
      { intervalMs, stateFile, startEpoch, catchUpCap: 10 },
      ctx.logger,
      emit
    );

    sched.start(async (slot) => {
      ctx.logger.info('cs-reminders trigger firing', { slot });
      const res = await postRunAndParse(baseUrl, apiKey, {
        prompt: ANALYSIS_PROMPT,
        agentId,
        runId: `cs-reminder-analysis:${slot}`,
        meta: { scheduled: true, slot, source: 'cs-reminders-trigger' },
      });
      if (!res.ok) {
        throw new Error(`/api/run failed: HTTP ${res.status}`);
      }
      ctx.logger.info('cs-reminders trigger ok', {
        slot,
        finalLen: res.finalText.length,
      });
      // 输出由事件订阅者处理（写入 cs_reminder + SSE 推送）
      emit({
        type: 'cs:reminder:analysis_complete',
        plugin: 'cs-reminders-trigger',
        slot,
        finalText: res.finalText,
      });
    });

    cleanupFns.push(() => sched.stop());
    ctx.logger.info('cs-reminders-trigger started', { intervalMs, stateFile });
  },

  async onStop(ctx: PluginContext): Promise<void> {
    while (cleanupFns.length) {
      try {
        cleanupFns.pop()?.();
      } catch {
        /* 单个清理失败不阻断 */
      }
    }
    ctx.logger.info('cs-reminders-trigger stopped');
  },

  async onUnload(ctx: PluginContext): Promise<void> {
    while (cleanupFns.length) {
      try {
        cleanupFns.pop()?.();
      } catch {
        /* 单个清理失败不阻断 */
      }
    }
    ctx.logger.info('cs-reminders-trigger unloaded');
  },
};

export default csRemindersTriggerPlugin;

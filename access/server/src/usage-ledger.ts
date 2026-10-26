/**
 * usage-ledger.ts — 租户用量账本（长期：多租户运营面的账单聚合）。
 *
 * 背景：run:cost 事件此前仅进内存配额窗口（QuotaEngine.recordUsage，重启即失）
 * 与 telemetry 内存快照 —— 运营无法回答「某租户本月花了多少」。
 * 本模块按 (tenant, UTC 日) 聚合落库（usage_daily 表），提供账单区间查询。
 *
 * 设计要点：
 * - 写路径带内存缓冲（Map 聚合 + 定时批量 upsert + 优雅 flush）—— run:cost 是
 *   每 LLM step 一条的高频事件，逐条打库会放大 SQLite 单写者瓶颈；
 * - ON CONFLICT 增量累加（多写者安全靠租户分片/单写者部署约定，与 quota 一致）；
 * - 读路径供 GET /api/admin/tenants/:id/usage?from&to 消费；
 * - getDbAdapter 双后端，CREATE TABLE IF NOT EXISTS 自愈（与 tenant-store 同范式）。
 */

import { getDbAdapter, type DbAdapter } from '@agent-harness/core';

/** usage_daily 一行（day 为 UTC 日期 YYYY-MM-DD）。 */
export interface UsageDailyRow {
  tenantId: string;
  day: string;
  runs: number;
  tokens: number;
  cost: number;
  updatedAt: number;
}

/** usage_model_daily 一行（按 model 细分；runs 不细分，仅 token/cost）。 */
export interface UsageModelDailyRow {
  tenantId: string;
  day: string;
  model: string;
  tokens: number;
  cost: number;
  updatedAt: number;
}

const FLUSH_INTERVAL_MS = 5_000;
const FLUSH_THRESHOLD = 64;

export class UsageLedger {
  private file: string;
  private db: DbAdapter | null = null;
  private ready: Promise<void> | null = null;
  /** key = tenant|day|model（model 空 = 未标注）。 */
  private buffer = new Map<string, { runs: number; tokens: number; cost: number }>();
  private timer: NodeJS.Timeout | null = null;

  constructor(opts: { file?: string } = {}) {
    this.file = opts.file || process.env.USAGE_LEDGER_DB_FILE || '/var/lib/agent-harness/usage.db';
  }

  /** 显式初始化（建表 + 启动 flush 定时器）。幂等。 */
  async init(): Promise<void> {
    await this.ensure();
    if (!this.timer) {
      this.timer = setInterval(() => {
        void this.flush().catch(() => {
          /* flush 失败保留缓冲，下轮重试 */
        });
      }, FLUSH_INTERVAL_MS);
      if (typeof this.timer.unref === 'function') this.timer.unref();
    }
  }

  private ensure(): Promise<void> {
    if (!this.ready) {
      this.ready = (async () => {
        try {
          this.db = getDbAdapter({ file: this.file });
          await this.db.exec(
            'CREATE TABLE IF NOT EXISTS usage_daily (' +
              'tenant_id TEXT NOT NULL, ' +
              'day TEXT NOT NULL, ' +
              'runs INTEGER NOT NULL DEFAULT 0, ' +
              'tokens INTEGER NOT NULL DEFAULT 0, ' +
              'cost REAL NOT NULL DEFAULT 0, ' +
              'updated_at INTEGER NOT NULL, ' +
              'PRIMARY KEY (tenant_id, day))'
          );
          await this.db.exec(
            'CREATE TABLE IF NOT EXISTS usage_model_daily (' +
              'tenant_id TEXT NOT NULL, ' +
              'day TEXT NOT NULL, ' +
              'model TEXT NOT NULL, ' +
              'tokens INTEGER NOT NULL DEFAULT 0, ' +
              'cost REAL NOT NULL DEFAULT 0, ' +
              'updated_at INTEGER NOT NULL, ' +
              'PRIMARY KEY (tenant_id, day, model))'
          );
        } catch (e) {
          this.ready = null;
          throw e;
        }
      })();
    }
    return this.ready;
  }

  /** UTC 日键（与账单口径一致，避免时区歧义）。 */
  static dayOf(ts: number = Date.now()): string {
    return new Date(ts).toISOString().slice(0, 10);
  }

  /** 记一笔用量（内存聚合；高频路径零 IO）。model 提供时同步进 model 维度细分表。 */
  record(tenantId: string, tokens: number, cost: number, model?: string): void {
    const t = tenantId || 'anonymous';
    const day = UsageLedger.dayOf();
    const m = (model ?? '').trim();
    const key = `${t}|${day}|`;
    const cur = this.buffer.get(key) ?? { runs: 0, tokens: 0, cost: 0 };
    cur.tokens += Math.max(0, Math.floor(tokens || 0));
    cur.cost += Math.max(0, Number(cost) || 0);
    this.buffer.set(key, cur);
    if (m) {
      const mkey = `${t}|${day}|${m}`;
      const mcur = this.buffer.get(mkey) ?? { runs: 0, tokens: 0, cost: 0 };
      mcur.tokens += Math.max(0, Math.floor(tokens || 0));
      mcur.cost += Math.max(0, Number(cost) || 0);
      this.buffer.set(mkey, mcur);
    }
    if (this.buffer.size >= FLUSH_THRESHOLD) {
      void this.flush().catch(() => {});
    }
  }

  /** 记一次 run 完成（runs 计数维度）。 */
  recordRun(tenantId: string): void {
    const t = tenantId || 'anonymous';
    const key = `${t}|${UsageLedger.dayOf()}`;
    const cur = this.buffer.get(key) ?? { runs: 0, tokens: 0, cost: 0 };
    cur.runs += 1;
    this.buffer.set(key, cur);
  }

  /** 把缓冲批量 upsert 落库（幂等累加）。model 非空条目同时进 usage_model_daily。 */
  async flush(): Promise<void> {
    if (this.buffer.size === 0) return;
    await this.ensure();
    if (!this.db) return;
    const batch = [...this.buffer.entries()];
    this.buffer.clear();
    const now = Date.now();
    for (const [key, agg] of batch) {
      const parts = key.split('|');
      const tenantId = parts[0] ?? 'anonymous';
      const day = parts[1] ?? '';
      const model = parts.slice(2).join('|');
      if (!model) {
        // 聚合表：仅无 model 标注的条目写（model 条目在下方只进细分表，避免聚合翻倍）。
        await this.db
          .prepare(
            'INSERT INTO usage_daily (tenant_id, day, runs, tokens, cost, updated_at) ' +
              'VALUES (?, ?, ?, ?, ?, ?) ' +
              'ON CONFLICT(tenant_id, day) DO UPDATE SET ' +
              'runs = runs + excluded.runs, tokens = tokens + excluded.tokens, ' +
              'cost = cost + excluded.cost, updated_at = excluded.updated_at'
          )
          .run(tenantId, day, agg.runs, agg.tokens, agg.cost, now);
      } else {
        await this.db
          .prepare(
            'INSERT INTO usage_model_daily (tenant_id, day, model, tokens, cost, updated_at) ' +
              'VALUES (?, ?, ?, ?, ?, ?) ' +
              'ON CONFLICT(tenant_id, day, model) DO UPDATE SET ' +
              'tokens = tokens + excluded.tokens, cost = cost + excluded.cost, updated_at = excluded.updated_at'
          )
          .run(tenantId, day, model, agg.tokens, agg.cost, now);
      }
    }
  }

  /** 账单区间查询：[fromDay, toDay] 闭区间（UTC 日，YYYY-MM-DD），按日升序。 */
  async query(tenantId: string, fromDay?: string, toDay?: string): Promise<UsageDailyRow[]> {
    await this.ensure();
    if (!this.db) return [];
    const clauses: string[] = ['tenant_id = ?'];
    const args: unknown[] = [tenantId];
    if (fromDay) {
      clauses.push('day >= ?');
      args.push(fromDay);
    }
    if (toDay) {
      clauses.push('day <= ?');
      args.push(toDay);
    }
    const rows = (await this.db
      .prepare(`SELECT * FROM usage_daily WHERE ${clauses.join(' AND ')} ORDER BY day ASC`)
      .all(...args)) as Record<string, unknown>[];
    return rows.map((r) => ({
      tenantId: String(r.tenant_id),
      day: String(r.day),
      runs: Number(r.runs ?? 0),
      tokens: Number(r.tokens ?? 0),
      cost: Number(r.cost ?? 0),
      updatedAt: Number(r.updated_at ?? 0),
    }));
  }

  /** model 维度细分查询（同区间口径；无数据返回空数组）。 */
  async queryByModel(tenantId: string, fromDay?: string, toDay?: string): Promise<UsageModelDailyRow[]> {
    await this.ensure();
    if (!this.db) return [];
    const clauses: string[] = ['tenant_id = ?'];
    const args: unknown[] = [tenantId];
    if (fromDay) {
      clauses.push('day >= ?');
      args.push(fromDay);
    }
    if (toDay) {
      clauses.push('day <= ?');
      args.push(toDay);
    }
    const rows = (await this.db
      .prepare(`SELECT * FROM usage_model_daily WHERE ${clauses.join(' AND ')} ORDER BY day ASC, cost DESC`)
      .all(...args)) as Record<string, unknown>[];
    return rows.map((r) => ({
      tenantId: String(r.tenant_id),
      day: String(r.day),
      model: String(r.model),
      tokens: Number(r.tokens ?? 0),
      cost: Number(r.cost ?? 0),
      updatedAt: Number(r.updated_at ?? 0),
    }));
  }

  /** 停止 flush 定时器并把缓冲落库（优雅关闭）。 */
  async close(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    try {
      await this.flush();
    } catch {
      /* 关闭期 flush 失败不阻断退出 */
    }
  }
}

// ---------------------------------------------------------------------------
// 进程共享单例（server 启动 init；run-queue 记账、admin 路由查询共用）。
// ---------------------------------------------------------------------------
let _ledger: UsageLedger | null = null;

export function getUsageLedger(): UsageLedger {
  if (!_ledger) _ledger = new UsageLedger();
  return _ledger;
}

export function configureUsageLedger(opts: { file?: string }): UsageLedger {
  _ledger = new UsageLedger(opts);
  return _ledger;
}

/**
 * 工作流存储后端（P1-⑤）。
 *
 * 复用本仓库「接口 + 默认实现 + 工厂」范式（与 `memory-store.ts` / `agents/store.ts` 同构）：
 * - `WorkflowStore` 接口：save / get / list / delete；
 * - `VolatileWorkflowStore`（显式 `WORKFLOW_STORE_BACKEND=memory` 时）/ `FileWorkflowStore`（按工作流 id 分桶的 JSON 文件，原子 rename 落盘）；
 * - 工厂 `getWorkflowStore()`：默认 File（`WORKFLOW_STORE_DIR` || `./data/workflows`）；
 *   `WORKFLOW_STORE_BACKEND=memory` 显式回落 Volatile（测试/演示形态）。
 *
 * 注意：只存 WorkflowRun（def + 每 step 状态），引擎的执行逻辑无状态、可重放。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { WorkflowRun, StepTraceNode } from './types';
import { quarantineCorruptFile } from '../store-safety';
import { getDbAdapter, type DbAdapter } from '../db-adapter';

export interface WorkflowStore {
  save(run: WorkflowRun): Promise<void>;
  get(id: string): Promise<WorkflowRun | null>;
  list(): Promise<WorkflowRun[]>;
  delete(id: string): Promise<void>;
  /**
   * P1 C4 原子占位：在存储侧原子完成「检查该 def 是否已有在跑 run → 写入新检查点」。
   * - 无既有检查点、既有 run 已终态、或 runId 与本次相同（resume 重取）→ 写入并返回 true；
   * - 既有 run 仍 running 且 runId 不同 → 返回 false（拒绝并发运行）。
   * 可选方法：旧自定义 store 未实现时引擎回落两步 get+save（保留原行为）。
   */
  claim?(run: WorkflowRun): Promise<boolean>;
}

/** 文件/路径安全化：避免 step/工作流 id 注入路径穿越。 */
function sanitizeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 128);
}

/** 默认实现：进程内 Map。重启即丢，适用于演示与单实例。 */
export class VolatileWorkflowStore implements WorkflowStore {
  private map = new Map<string, WorkflowRun>();
  async save(run: WorkflowRun): Promise<void> {
    this.map.set(run.def.id, run);
  }
  async get(id: string): Promise<WorkflowRun | null> {
    return this.map.get(id) ?? null;
  }
  async list(): Promise<WorkflowRun[]> {
    return [...this.map.values()];
  }
  async delete(id: string): Promise<void> {
    this.map.delete(id);
  }
  /**
   * P1 C4：检查与写入之间无 await，事件循环内天然原子 —— 并发 claim 同一 def 时
   * 后到者必然看到先到者写入的 running 检查点。
   */
  async claim(run: WorkflowRun): Promise<boolean> {
    const existing = this.map.get(run.def.id) ?? null;
    if (existing && existing.state === 'running' && existing.runId && existing.runId !== run.runId) {
      return false;
    }
    this.map.set(run.def.id, run);
    return true;
  }
}

/** 文件实现：每个工作流一个 JSON 文件，写入走临时文件 + rename 保证原子性。 */
export class FileWorkflowStore implements WorkflowStore {
  constructor(private readonly opts: { dir: string }) {}

  /**
   * P1 C4：按 def.id 的进程内互斥队列。claim 的「读既有 → 检查 → 写入」链路
   * 经此串行化，消除 await 间隙被并发 claim 插入的 TOCTOU（rename 只保证单次写入
   * 原子，不保证检查-写入复合操作原子）。k8s 侧另有 HPA 锁副本=1，进程级互斥已闭环。
   */
  private mutexes = new Map<string, Promise<unknown>>();

  private exclusive<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.mutexes.get(id) ?? Promise.resolve();
    const next = prev.then(fn, fn); // 前序失败不阻塞后续 claim
    this.mutexes.set(id, next);
    return next;
  }

  private file(id: string): string {
    return join(this.opts.dir, `${sanitizeKey(id)}.json`);
  }

  async claim(run: WorkflowRun): Promise<boolean> {
    return this.exclusive(run.def.id, async () => {
      const existing = await this.get(run.def.id);
      if (existing && existing.state === 'running' && existing.runId && existing.runId !== run.runId) {
        return false;
      }
      await this.save(run);
      return true;
    });
  }

  async save(run: WorkflowRun): Promise<void> {
    const f = this.file(run.def.id);
    mkdirSync(dirname(f), { recursive: true });
    const tmp = `${f}.tmp`;
    writeFileSync(tmp, `{"v":1,"run":${JSON.stringify(run)}}`, 'utf-8');
    renameSync(tmp, f);
  }

  async get(id: string): Promise<WorkflowRun | null> {
    const f = this.file(id);
    if (!existsSync(f)) return null;
    // P2 统一损坏策略：解析失败 → 告警 + 隔离改名 + 空状态继续（此前静默当无检查点，
    // 断点续跑数据静默丢失且不可见）。
    try {
      const raw = readFileSync(f, 'utf-8');
      const parsed = JSON.parse(raw);
      return (parsed?.run ?? parsed) as WorkflowRun;
    } catch (e) {
      quarantineCorruptFile(f, 'workflow', e);
      return null;
    }
  }

  async list(): Promise<WorkflowRun[]> {
    const d = this.opts.dir;
    if (!existsSync(d)) return [];
    const out: WorkflowRun[] = [];
    for (const name of readdirSync(d)) {
      if (!name.endsWith('.json')) continue;
      const f = join(d, name);
      try {
        const parsed = JSON.parse(readFileSync(f, 'utf-8'));
        out.push((parsed?.run ?? parsed) as WorkflowRun);
      } catch (e) {
        // 损坏检查点：告警 + 隔离改名，其余检查点继续加载。
        quarantineCorruptFile(f, 'workflow', e);
      }
    }
    return out;
  }

  async delete(id: string): Promise<void> {
    const f = this.file(id);
    if (existsSync(f)) unlinkSync(f);
  }
}

let _store: WorkflowStore | null = null;

/**
 * P6 数据库检查点后端（PostgreSQL / SQLite / Turso 通用，经统一 DbAdapter）。
 *
 * 动机：FileWorkflowStore 落单机文件，多副本 / 容器重建场景下检查点易失；
 * 本实现把 WorkflowRun 全量 JSON 存进 `workflow_runs` 表（id = def.id），SQL 走
 * SQLite 方言、由 db-dialect 层在适配器出口统一翻译（PG：? → $n、datetime('now') → now()），
 * store 代码零方言分支——与 agents/store 等既有 store 同范式。
 *
 * claim() 原子性：单条 `INSERT ... ON CONFLICT(id) DO UPDATE SET ... WHERE
 * <既有行>.state != 'running' OR <既有行>.run_id = excluded.run_id`，按 changes 是否 >0
 * 判定占位成败——检查与写入在数据库侧一次完成，天然免疫并发 claim 的 TOCTOU
 * （FileWorkflowStore 只能做到进程内互斥；本实现跨副本安全，前提是共用同一库）。
 *
 * 后端选择：构造显式传 `adapter` 优先；否则 getDbAdapter()（DB_BACKEND / DATABASE_URL，
 * `postgres://…` 即 PostgreSQL，缺省本地 sqlite）。工厂 getWorkflowStore() 在
 * `WORKFLOW_STORE_BACKEND=db|postgres|postgresql` 时启用本实现。
 * （MySQL 未纳入：其方言层不支持带 WHERE 的 upsert，claim 原子占位不可用。）
 */
export class DbWorkflowStore implements WorkflowStore {
  private readonly adapter: DbAdapter;
  private readonly table: string;
  private schemaReady: Promise<void> | null = null;

  constructor(opts: { adapter?: DbAdapter; table?: string } = {}) {
    this.adapter = opts.adapter ?? getDbAdapter();
    this.table =
      opts.table && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(opts.table) ? opts.table : 'workflow_runs';
  }

  /** 幂等建表（首次操作时执行一次；并发调用共享同一 Promise）。 */
  private async ensureSchema(): Promise<void> {
    if (!this.schemaReady) {
      this.schemaReady = (async () => {
        await this.adapter.exec(
          `CREATE TABLE IF NOT EXISTS ${this.table} (` +
            `id TEXT PRIMARY KEY, ` +
            `run_id TEXT, ` +
            `state TEXT NOT NULL DEFAULT 'pending', ` +
            `data TEXT NOT NULL, ` +
            `updated_at TEXT DEFAULT (datetime('now')))`
        );
      })();
    }
    await this.schemaReady;
  }

  /** upsert SQL（claim 版本带 WHERE 守卫：仅在「无在跑 run 或同 runId 重取」时更新）。
   * 注：ON CONFLICT 目标必须是裸列名（PG 拒绝表名限定）；WHERE 子句引用既有行用表名限定。 */
  private upsertSql(guarded: boolean): string {
    const base =
      `INSERT INTO ${this.table} (id, run_id, state, data) VALUES (?, ?, ?, ?) ` +
      `ON CONFLICT(id) DO UPDATE SET ` +
      `run_id = excluded.run_id, state = excluded.state, data = excluded.data, ` +
      `updated_at = datetime('now')`;
    return guarded
      ? `${base} WHERE ${this.table}.state != 'running' OR ${this.table}.run_id = excluded.run_id`
      : base;
  }

  async claim(run: WorkflowRun): Promise<boolean> {
    await this.ensureSchema();
    const res = await this.adapter
      .prepare(this.upsertSql(true))
      .run(run.def.id, run.runId ?? null, run.state, JSON.stringify(run));
    return res.changes > 0;
  }

  async save(run: WorkflowRun): Promise<void> {
    await this.ensureSchema();
    await this.adapter
      .prepare(this.upsertSql(false))
      .run(run.def.id, run.runId ?? null, run.state, JSON.stringify(run));
  }

  async get(id: string): Promise<WorkflowRun | null> {
    await this.ensureSchema();
    const row = await this.adapter.prepare(`SELECT data FROM ${this.table} WHERE id = ?`).get(id);
    if (!row) return null;
    try {
      return JSON.parse(String(row.data)) as WorkflowRun;
    } catch (e) {
      // 损坏行：告警 + 按无检查点处理（与 FileWorkflowStore 的隔离策略同语义，但不物理删行，
      // 保留现场供人工排查）。
      console.warn(`[workflow-store] 检查点损坏（id=${id}）：${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  async list(): Promise<WorkflowRun[]> {
    await this.ensureSchema();
    const rows = await this.adapter.prepare(`SELECT data FROM ${this.table} ORDER BY updated_at`).all();
    const out: WorkflowRun[] = [];
    for (const row of rows) {
      try {
        out.push(JSON.parse(String(row.data)) as WorkflowRun);
      } catch (e) {
        console.warn(
          `[workflow-store] 跳过损坏检查点：${e instanceof Error ? e.message : String(e)}`
        );
      }
    }
    return out;
  }

  async delete(id: string): Promise<void> {
    await this.ensureSchema();
    await this.adapter.prepare(`DELETE FROM ${this.table} WHERE id = ?`).run(id);
  }
}

/**
 * 进程内共享的存储单例。
 *
 * 默认改为 **File 持久化**（目录 = `WORKFLOW_STORE_DIR` || `./data/workflows`）：
 * 此前默认 Volatile，未显式配置目录的部署在重启后丢检查点（断点续跑/对账全失效）。
 * 需要「纯内存、零落盘」的形态（测试/演示）显式设 `WORKFLOW_STORE_BACKEND=memory`。
 */
export function getWorkflowStore(): WorkflowStore {
  if (!_store) {
    const backend = (process.env.WORKFLOW_STORE_BACKEND ?? '').trim().toLowerCase();
    const dir = process.env.WORKFLOW_STORE_DIR;
    _store =
      backend === 'memory' || backend === 'volatile'
        ? new VolatileWorkflowStore()
        : backend === 'db' || backend === 'postgres' || backend === 'postgresql'
          ? new DbWorkflowStore()
          : new FileWorkflowStore({ dir: dir && dir.trim() ? dir : './data/workflows' });
  }
  return _store;
}

/** 测试用：清空共享单例（下次 getWorkflowStore 按当前 env 重建）。 */
export function resetWorkflowStoreForTest(): void {
  _store = null;
}

/* ------------------------------------------------------------------ */
/* P6 观测：run 级 trace 归档（方案三一期，见 docs/05-analysis/        */
/* p6-gap-remediation-eval.md §方案三）——「快照管状态可回放，          */
/* run_traces 管过程可检索」。与检查点后端解耦：直接挂 getDbAdapter()   */
/* （缺省本地 sqlite），任何部署形态下 run 过程均可跨重启检索。          */
/* ------------------------------------------------------------------ */

/** 单次 run 的过程归档：per-step 状态 / 重试计数 / 错误 / 调用链路（StepTraceNode 序列）。 */
export interface RunTraceRecord {
  workflowId: string;
  runId: string;
  /** 归档时间（epoch ms）。 */
  ts: number;
  /** run 终态（done / failed / cancelled）。 */
  state: string;
  /** stepId → 过程数据（不落产出正文 —— 大体积产出归检查点/交付文件，trace 记过程）。 */
  steps: Record<
    string,
    { state?: string; attempts?: number; error?: string; trace?: StepTraceNode[] }
  >;
}

/** run_traces 归档上限：单条记录序列化后超过该字节数则剥离 trace.detail（保类型/标签/时间轴）。 */
export const RUN_TRACE_MAX_BYTES = 1_000_000;

/** 从终态 run 提取归档记录（体积超限时降级剥离 detail，保时间轴与结论）。 */
export function buildRunTraceRecord(run: WorkflowRun): RunTraceRecord {
  const steps: RunTraceRecord['steps'] = {};
  for (const [id, sr] of Object.entries(run.steps)) {
    steps[id] = {
      state: sr?.state,
      ...(sr?.attempts ? { attempts: sr.attempts } : {}),
      ...(sr?.error ? { error: sr.error } : {}),
      ...(sr?.trace && sr.trace.length ? { trace: sr.trace } : {}),
    };
  }
  const rec: RunTraceRecord = {
    workflowId: run.def.id,
    runId: run.runId ?? '',
    ts: Date.now(),
    state: run.state,
    steps,
  };
  // 体积护栏：超限剥离 detail（detail 是体积大头，时间轴/类型/标签保留）。
  if (JSON.stringify(rec).length > RUN_TRACE_MAX_BYTES) {
    for (const s of Object.values(steps)) {
      if (s.trace) {
        s.trace = s.trace.map((n) => {
          const { detail: _detail, ...rest } = n as { detail?: string } & typeof n;
          return rest as typeof n;
        });
      }
    }
  }
  return rec;
}

/**
 * run 过程归档存储（独立于 WorkflowStore —— 过程数据的生命周期与检查点不同：
 * 检查点每 def.id 一份最新，trace 每 run 一份历史）。
 * 表结构 `(def_id, run_id)` 复合主键；upsert 幂等（同 runId 重终态覆盖）。
 */
export class DbRunTraceStore {
  private readonly adapter: DbAdapter;
  private readonly table: string;
  private schemaReady: Promise<void> | null = null;

  constructor(opts: { adapter?: DbAdapter; table?: string } = {}) {
    this.adapter = opts.adapter ?? getDbAdapter();
    this.table =
      opts.table && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(opts.table)
        ? opts.table
        : 'workflow_run_traces';
  }

  private async ensureSchema(): Promise<void> {
    if (!this.schemaReady) {
      this.schemaReady = (async () => {
        await this.adapter.exec(
          `CREATE TABLE IF NOT EXISTS ${this.table} (` +
            `def_id TEXT NOT NULL, ` +
            `run_id TEXT NOT NULL, ` +
            `ts INTEGER NOT NULL, ` +
            `state TEXT NOT NULL DEFAULT 'pending', ` +
            `data TEXT NOT NULL, ` +
            `PRIMARY KEY (def_id, run_id))`
        );
      })().catch((e: unknown) => {
        // 建表失败重置 promise，下次操作重试（瞬时锁/连接抖动自愈）。
        this.schemaReady = null;
        throw e;
      });
    }
    await this.schemaReady;
  }

  async save(rec: RunTraceRecord): Promise<void> {
    await this.ensureSchema();
    await this.adapter
      .prepare(
        `INSERT INTO ${this.table} (def_id, run_id, ts, state, data) VALUES (?, ?, ?, ?, ?) ` +
          `ON CONFLICT(def_id, run_id) DO UPDATE SET ` +
          `ts = excluded.ts, state = excluded.state, data = excluded.data`
      )
      .run(rec.workflowId, rec.runId, rec.ts, rec.state, JSON.stringify(rec));
  }

  /** 列出某工作流的归档（新→旧，limit 缺省 20；data 内含完整 steps 过程）。 */
  async list(workflowId: string, limit = 20): Promise<RunTraceRecord[]> {
    await this.ensureSchema();
    const rows = await this.adapter
      .prepare(`SELECT data FROM ${this.table} WHERE def_id = ? ORDER BY ts DESC LIMIT ?`)
      .all(workflowId, limit);
    const out: RunTraceRecord[] = [];
    for (const row of rows) {
      try {
        out.push(JSON.parse(String(row.data)) as RunTraceRecord);
      } catch (e) {
        console.warn(
          `[workflow-trace] 归档损坏跳过（def=${workflowId}）：${e instanceof Error ? e.message : String(e)}`
        );
      }
    }
    return out;
  }

  async get(workflowId: string, runId: string): Promise<RunTraceRecord | null> {
    await this.ensureSchema();
    const row = await this.adapter
      .prepare(`SELECT data FROM ${this.table} WHERE def_id = ? AND run_id = ?`)
      .get(workflowId, runId);
    if (!row) return null;
    try {
      return JSON.parse(String(row.data)) as RunTraceRecord;
    } catch (e) {
      console.warn(
        `[workflow-trace] 归档损坏（def=${workflowId}, run=${runId}）：${e instanceof Error ? e.message : String(e)}`
      );
      return null;
    }
  }
}

let _traceStore: DbRunTraceStore | null = null;

/** 进程内共享的 run 归档单例（挂 getDbAdapter() —— 缺省本地 sqlite，与检查点后端解耦）。 */
export function getRunTraceStore(): DbRunTraceStore {
  if (!_traceStore) _traceStore = new DbRunTraceStore();
  return _traceStore;
}

/** 测试用：清空共享单例。 */
export function resetRunTraceStoreForTest(): void {
  _traceStore = null;
}

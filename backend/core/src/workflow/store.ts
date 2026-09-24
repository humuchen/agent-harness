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
import type { WorkflowRun } from './types';

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
    try {
      const raw = readFileSync(f, 'utf-8');
      const parsed = JSON.parse(raw);
      return (parsed?.run ?? parsed) as WorkflowRun;
    } catch {
      return null;
    }
  }

  async list(): Promise<WorkflowRun[]> {
    const d = this.opts.dir;
    if (!existsSync(d)) return [];
    const out: WorkflowRun[] = [];
    for (const name of readdirSync(d)) {
      if (!name.endsWith('.json')) continue;
      try {
        const parsed = JSON.parse(readFileSync(join(d, name), 'utf-8'));
        out.push((parsed?.run ?? parsed) as WorkflowRun);
      } catch {
        /* 跳过损坏文件 */
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
        : new FileWorkflowStore({ dir: dir && dir.trim() ? dir : './data/workflows' });
  }
  return _store;
}

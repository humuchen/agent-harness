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
}

/** 文件实现：每个工作流一个 JSON 文件，写入走临时文件 + rename 保证原子性。 */
export class FileWorkflowStore implements WorkflowStore {
  constructor(private readonly opts: { dir: string }) {}

  private file(id: string): string {
    return join(this.opts.dir, `${sanitizeKey(id)}.json`);
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

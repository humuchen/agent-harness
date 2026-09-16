/**
 * Plan 协同存储（P2-3）。
 *
 * 将「Plan 模式产物」（计划书 / 步骤树）持久化为可视化、可多人协同的文档。
 * 设计沿用「接口 + 默认实现 + 组合工厂」范式，与 artifact-store / data-source 同风格。
 *
 * 数据模型（与设计文档 Section 3 一致）：
 * - `PlanNode`：单个计划节点（todo/doing/done/blocked + assignee + dependsOn + note）
 * - `PlanDoc`：整个计划文档（id/title/nodes/version/updatedBy/updatedAt）
 * - `PlanDiff`：版本间 diff 结果
 *
 * 协同传输：复用 chat-bus 的 SSE 订阅范式（`subscribeChatEvents` 同族），
 * 前端用 `EventSource` 接收他人编辑 → 乐观更新 + 版本号冲突解决。
 *
 * 存储后端（接口 + 默认实现 + 组合工厂）：
 * - `SqlitePlanStore`（默认）：经统一 db-adapter 落 SQLite/Turso 数据库，
 *   表 `plan_docs`（id / title / nodes / version / updated_by / updated_at / session_id）；
 * - `FilePlanStore`（测试 / 本地回退）：每个 plan 存为独立 JSON 文件。
 *
 * 数据库运行时不可用时自动降级为内存实现，保证服务可启动、功能可用（仅失去跨重启持久化）。
 *
 * 环境变量：
 * - PLAN_STORE_BACKEND: 'sqlite'（默认）| 'file' | 'memory'
 * - PLAN_STORE_DIR: 文件后端目录（默认 `.data/plans`）
 * - PLAN_DB_FILE: SQLite 文件路径（默认 `<cwd>/data/plans.db`）
 */

import { getDbAdapter, type DbAdapter } from '@agent-harness/core';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

/** 计划节点状态。 */
export type PlanNodeStatus = 'todo' | 'doing' | 'done' | 'blocked';

/** 计划中的单个节点。 */
export interface PlanNode {
  id: string;
  title: string;
  status: PlanNodeStatus;
  /** 指派人（用户 sub）。 */
  assignee?: string;
  /** 依赖的前置节点 id（必须引用 nodes 内其它 id）。 */
  dependsOn: string[];
  /** 备注（评论 / 说明）。 */
  note?: string;
}

/** 计划文档。 */
export interface PlanDoc {
  id: string;
  title: string;
  /** 节点列表（拓扑顺序由前端处理）。 */
  nodes: PlanNode[];
  /** 版本号（每写一次 +1），用于乐观更新冲突检测。 */
  version: number;
  /** 最后更新人。 */
  updatedBy: string;
  /** 最后更新时间（ISO 字符串）。 */
  updatedAt: string;
  /** 来源会话 id（可选，关联到 chat session）。 */
  sessionId?: string;
}

/** 版本 diff 结果。 */
export interface PlanDiff {
  /** 变更的节点 id。 */
  added: string[];
  removed: string[];
  /** 字段变更的节点 id → 变更说明。 */
  changed: Array<{ id: string; changes: string }>;
  /** 旧版本号 / 新版本号。 */
  fromVersion: number;
  toVersion: number;
}

/** PlanStore 契约。 */
export interface PlanStore {
  /** 读取计划（不存在返回 null）。 */
  read(id: string): Promise<PlanDoc | null>;
  /** 保存计划（存在则覆盖，version +1）。 */
  save(doc: PlanDoc): Promise<PlanDoc>;
  /** 删除计划。 */
  remove(id: string): Promise<boolean>;
  /** 列出计划（可选按 owner 过滤）。 */
  list(owner?: string): Promise<PlanDoc[]>;
  /** diff 两个版本。 */
  diff(aId: string, bId: string): Promise<PlanDiff>;
}

/** diff 两个计划文档（纯函数，各后端共用）。 */
function diffDocs(a: PlanDoc, b: PlanDoc): PlanDiff {
  const aNodes = new Map(a.nodes.map((n) => [n.id, n]));
  const bNodes = new Map(b.nodes.map((n) => [n.id, n]));

  const added: string[] = [];
  const removed: string[] = [];
  const changed: Array<{ id: string; changes: string }> = [];

  for (const [id, node] of bNodes) {
    if (!aNodes.has(id)) {
      added.push(id);
    } else {
      const prev = aNodes.get(id)!;
      const diffs: string[] = [];
      if (prev.title !== node.title)
        diffs.push(`title: "${prev.title}" → "${node.title}"`);
      if (prev.status !== node.status)
        diffs.push(`status: ${prev.status} → ${node.status}`);
      if (prev.assignee !== node.assignee)
        diffs.push(`assignee: ${prev.assignee ?? 'none'} → ${node.assignee ?? 'none'}`);
      if (prev.note !== node.note) diffs.push('note changed');
      if (JSON.stringify(prev.dependsOn) !== JSON.stringify(node.dependsOn))
        diffs.push(`dependsOn changed`);
      if (diffs.length > 0) {
        changed.push({ id, changes: diffs.join('; ') });
      }
    }
  }

  for (const id of aNodes.keys()) {
    if (!bNodes.has(id)) removed.push(id);
  }

  return {
    added,
    removed,
    changed,
    fromVersion: a.version,
    toVersion: b.version
  };
}

/* ------------------------------ 内存实现 ------------------------------ */

class MemoryPlanStore implements PlanStore {
  private docs = new Map<string, PlanDoc>();

  async read(id: string): Promise<PlanDoc | null> {
    return this.docs.get(id) ?? null;
  }

  async save(doc: PlanDoc): Promise<PlanDoc> {
    const existing = this.docs.get(doc.id);
    const next: PlanDoc = {
      ...doc,
      version: existing ? existing.version + 1 : 1,
      updatedAt: new Date().toISOString()
    };
    this.docs.set(doc.id, next);
    return next;
  }

  async remove(id: string): Promise<boolean> {
    return this.docs.delete(id);
  }

  async list(owner?: string): Promise<PlanDoc[]> {
    const all = [...this.docs.values()];
    const filtered = owner ? all.filter((d) => d.updatedBy === owner) : all;
    return filtered.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async diff(aId: string, bId: string): Promise<PlanDiff> {
    const a = await this.read(aId);
    const b = await this.read(bId);
    if (!a || !b) throw new Error('one or both plans not found');
    return diffDocs(a, b);
  }
}

/* ----------------------------- SQLite 实现 ---------------------------- */

class SqlitePlanStore implements PlanStore {
  private db: DbAdapter;

  constructor(file: string) {
    // 使用统一适配器（支持 sqlite / turso 双后端），与 history-store 同款范式。
    this.db = getDbAdapter({ file });
    const execResult = this.db.exec(`
      CREATE TABLE IF NOT EXISTS plan_docs (
        id         TEXT PRIMARY KEY,
        title      TEXT NOT NULL,
        nodes      TEXT NOT NULL,
        version    INTEGER NOT NULL DEFAULT 1,
        updated_by TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL,
        session_id TEXT
      );
    `);
    // Turso 后端的 exec 为 Promise-based，需等待完成（与 history-store 对齐）。
    const finish = () => {};
    if (execResult && typeof (execResult as any).then === 'function') {
      (execResult as Promise<void>).then(finish);
    } else {
      finish();
    }
  }

  private rowToDoc(row: Record<string, unknown>): PlanDoc {
    let nodes: PlanNode[] = [];
    try {
      const parsed = JSON.parse(String(row.nodes));
      if (Array.isArray(parsed)) nodes = parsed;
    } catch {
      nodes = [];
    }
    return {
      id: String(row.id),
      title: String(row.title),
      nodes,
      version: Number(row.version) || 1,
      updatedBy: String(row.updated_by ?? ''),
      updatedAt: String(row.updated_at ?? new Date().toISOString()),
      ...(row.session_id ? { sessionId: String(row.session_id) } : {})
    };
  }

  async read(id: string): Promise<PlanDoc | null> {
    const row = await this.db
      .prepare(
        `SELECT id, title, nodes, version, updated_by, updated_at, session_id FROM plan_docs WHERE id = ?`
      )
      .get(id);
    if (!row) return null;
    return this.rowToDoc(row);
  }

  async save(doc: PlanDoc): Promise<PlanDoc> {
    const existing = await this.read(doc.id);
    const next: PlanDoc = {
      ...doc,
      version: existing ? existing.version + 1 : 1,
      updatedAt: new Date().toISOString()
    };
    await this.db
      .prepare(
        `INSERT INTO plan_docs (id, title, nodes, version, updated_by, updated_at, session_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title,
           nodes = excluded.nodes,
           version = excluded.version,
           updated_by = excluded.updated_by,
           updated_at = excluded.updated_at,
           session_id = excluded.session_id`
      )
      .run(
        next.id,
        next.title,
        JSON.stringify(next.nodes),
        next.version,
        next.updatedBy,
        next.updatedAt,
        next.sessionId ?? null
      );
    return next;
  }

  async remove(id: string): Promise<boolean> {
    const r = await this.db.prepare(`DELETE FROM plan_docs WHERE id = ?`).run(id);
    return Number(r?.changes ?? 0) > 0;
  }

  async list(owner?: string): Promise<PlanDoc[]> {
    const sql = owner
      ? `SELECT id, title, nodes, version, updated_by, updated_at, session_id FROM plan_docs WHERE updated_by = ? ORDER BY updated_at DESC`
      : `SELECT id, title, nodes, version, updated_by, updated_at, session_id FROM plan_docs ORDER BY updated_at DESC`;
    const rows = owner
      ? await this.db.prepare(sql).all(owner)
      : await this.db.prepare(sql).all();
    return (rows ?? []).map((row: Record<string, unknown>) => this.rowToDoc(row));
  }

  async diff(aId: string, bId: string): Promise<PlanDiff> {
    const a = await this.read(aId);
    const b = await this.read(bId);
    if (!a || !b) throw new Error('one or both plans not found');
    return diffDocs(a, b);
  }
}

/* ----------------------------- 文件实现（测试 / 回退） ---------------------------- */

/** 文件系统实现：每个 plan 存为独立 JSON 文件。 */
export class FilePlanStore implements PlanStore {
  private readonly dir: string;

  constructor(dir: string = '.data/plans') {
    this.dir = resolve(dir);
  }

  private filePath(id: string): string {
    // 安全校验：id 仅接受 UUID 或安全字符
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
      throw new Error(`invalid plan id: ${id}`);
    }
    return resolve(this.dir, `${id}.json`);
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  private async readRaw(id: string): Promise<PlanDoc | null> {
    const file = this.filePath(id);
    if (!existsSync(file)) return null;
    try {
      const raw = await readFile(file, 'utf-8');
      const parsed = JSON.parse(raw) as PlanDoc;
      return parsed;
    } catch {
      return null;
    }
  }

  async read(id: string): Promise<PlanDoc | null> {
    return this.readRaw(id);
  }

  async save(doc: PlanDoc): Promise<PlanDoc> {
    await this.ensureDir();
    const existing = await this.readRaw(doc.id);
    // version 递增
    const next: PlanDoc = {
      ...doc,
      version: existing ? existing.version + 1 : 1,
      updatedAt: new Date().toISOString()
    };
    const file = this.filePath(doc.id);
    await writeFile(file, JSON.stringify(next, null, 2), 'utf-8');
    return next;
  }

  async remove(id: string): Promise<boolean> {
    const file = this.filePath(id);
    if (!existsSync(file)) return false;
    try {
      const { unlink } = await import('node:fs/promises');
      await unlink(file);
      return true;
    } catch {
      return false;
    }
  }

  async list(owner?: string): Promise<PlanDoc[]> {
    await this.ensureDir();
    if (!existsSync(this.dir)) return [];
    const { readdir } = await import('node:fs/promises');
    const files = await readdir(this.dir);
    const docs: PlanDoc[] = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const raw = await readFile(resolve(this.dir, f), 'utf-8');
        const doc = JSON.parse(raw) as PlanDoc;
        if (!owner || doc.updatedBy === owner) {
          docs.push(doc);
        }
      } catch {
        /* 忽略损坏文件 */
      }
    }
    // 按 updatedAt 倒序
    return docs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /**
   * diff 两个计划文档。比较节点集合：
   * - added: 在 b 中但不在 a 中的节点
   * - removed: 在 a 中但不在 b 中的节点
   * - changed: 存在于两者但 status/title/assignee/note/dependsOn 有变的节点
   */
  async diff(aId: string, bId: string): Promise<PlanDiff> {
    const a = await this.readRaw(aId);
    const b = await this.readRaw(bId);
    if (!a || !b) {
      throw new Error('one or both plans not found');
    }
    return diffDocs(a, b);
  }
}

/** 单节点快捷构造（用于测试 / 简单创建）。 */
export function makePlanNode(
  id: string,
  title: string,
  status: PlanNodeStatus = 'todo',
  opts: { assignee?: string; dependsOn?: string[]; note?: string } = {}
): PlanNode {
  return { id, title, status, dependsOn: opts.dependsOn ?? [], ...opts };
}

/** 单文档快捷构造。 */
export function makePlanDoc(
  id: string | undefined,
  title: string,
  nodes: PlanNode[],
  updatedBy: string,
  sessionId?: string
): PlanDoc {
  return {
    id: id ?? randomUUID(),
    title,
    nodes,
    version: 0,
    updatedBy,
    updatedAt: new Date().toISOString(),
    ...(sessionId ? { sessionId } : {})
  };
}

// ── 组合工厂 ──

let storeSingleton: PlanStore | null = null;

/** 取进程级单例存储；按 PLAN_STORE_BACKEND 选择实现，sqlite 初始化失败自动回退内存。 */
export function getPlanStore(env: NodeJS.ProcessEnv = process.env): PlanStore {
  if (!storeSingleton) {
    const backend = (env.PLAN_STORE_BACKEND || 'sqlite').toLowerCase();
    if (backend === 'memory') {
      storeSingleton = new MemoryPlanStore();
    } else if (backend === 'file') {
      const dir = env.PLAN_STORE_DIR || '.data/plans';
      storeSingleton = new FilePlanStore(dir);
    } else {
      try {
        const file = env.PLAN_DB_FILE || resolve(process.cwd(), 'data/plans.db');
        storeSingleton = new SqlitePlanStore(file);
      } catch (err) {
        // node:sqlite 不可用 / 文件无法创建：降级为内存实现，服务不因存储层不可用而拒启。
        console.warn(
          '[plan-store] SQLite 不可用，降级为内存存储：',
          err instanceof Error ? err.message : err
        );
        storeSingleton = new MemoryPlanStore();
      }
    }
  }
  return storeSingleton;
}

/** 供测试注入自定义 store（传 null 重置单例）。 */
export function setPlanStore(s: PlanStore | null): void {
  storeSingleton = s;
}

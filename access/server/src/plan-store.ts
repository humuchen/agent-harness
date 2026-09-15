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
 * 本模块仅使用 node: 内置模块。
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
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
        if (prev.title !== node.title) diffs.push(`title: "${prev.title}" → "${node.title}"`);
        if (prev.status !== node.status) diffs.push(`status: ${prev.status} → ${node.status}`);
        if (prev.assignee !== node.assignee) diffs.push(`assignee: ${prev.assignee ?? 'none'} → ${node.assignee ?? 'none'}`);
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

/** 组合工厂：按环境变量 PLAN_STORE_DIR 选择目录（默认 `.data/plans`）。 */
export function getPlanStore(env: NodeJS.ProcessEnv = process.env): PlanStore {
  if (!storeSingleton) {
    const dir = env.PLAN_STORE_DIR || '.data/plans';
    storeSingleton = new FilePlanStore(dir);
  }
  return storeSingleton;
}

/** 供测试注入自定义 store（传 null 重置单例）。 */
export function setPlanStore(s: PlanStore | null): void {
  storeSingleton = s;
}

/**
 * 工作空间（Workspace）——参考图能力链路的第 2 环：User → **Workspace** → Skill → Tool → Data → Credential → Policy。
 *
 * 解决的问题：此前「一个用户的一组会话 / 可用技能 / 成员 / 配额」全部是隐式的——
 * 会话只按 `owner` 平铺隔离，技能面由全局 env 决定，配额是租户级单值。
 * 缺少一个显式的「空间」载体来回答「谁、在哪个空间里、能用哪些技能、受什么配额约束」。
 *
 * 分层：纯业务层（`access/server`），core 零感知；存储用「接口 + 默认实现 + 组合工厂」范式
 * （Volatile / File），与 `RecipeStore` 同款。
 */

/** 空间级配额（覆盖全局默认；0 / undefined = 不限）。 */
export interface WorkspaceQuota {
  /** 单日最大 run 次数。 */
  maxRunsPerDay?: number;
  /** 单日最大成本（美元）。 */
  maxCostPerDay?: number;
}

/** 工作空间。 */
export interface Workspace {
  id: string;
  name: string;
  /** 归属用户（创建者，天然是成员）。 */
  owner: string;
  /** 租户 id（多租户隔离维度，可选）。 */
  tenantId?: string;
  /** 成员列表（含 owner；用于共享空间的可见性判定）。 */
  members: string[];
  /** 可用技能白名单（空 / undefined = 全部技能可用）。 */
  skills?: string[];
  /** 空间级配额。 */
  quota?: WorkspaceQuota;
  createdAt: number;
  updatedAt: number;
}

/** 创建入参。 */
export interface WorkspaceCreateInput {
  name: string;
  owner: string;
  tenantId?: string;
  members?: string[];
  skills?: string[];
  quota?: WorkspaceQuota;
}

/** 更新入参（均为可选，未提供的字段保持不变）。 */
export interface WorkspaceUpdateInput {
  name?: string;
  members?: string[];
  skills?: string[];
  quota?: WorkspaceQuota;
  tenantId?: string;
}

/** 存储契约。 */
export interface WorkspaceStore {
  readonly kind: 'volatile' | 'file';
  /** 列出某用户可见的空间（owner 或 members 命中）。owner 省略时返回全部（运维用）。 */
  list(owner?: string): Workspace[];
  get(id: string): Workspace | null;
  create(input: WorkspaceCreateInput): Workspace;
  /** 更新；空间不存在返回 null。 */
  update(id: string, patch: WorkspaceUpdateInput): Workspace | null;
  /** 删除；返回是否真的删除。 */
  remove(id: string): boolean;
}

/** 默认空间 id：新用户首个自动创建的空间，保证开箱即用。 */
export const DEFAULT_WORKSPACE_ID_PREFIX = 'ws_';
export const DEFAULT_WORKSPACE_NAME = '默认空间';

function genId(): string {
  return `${DEFAULT_WORKSPACE_ID_PREFIX}${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

/** 归一化成员：去重、去空、确保 owner 在内。 */
function normalizeMembers(owner: string, members?: string[]): string[] {
  const set = new Set<string>();
  if (owner) set.add(owner);
  for (const m of members ?? []) {
    const t = String(m ?? '').trim();
    if (t) set.add(t);
  }
  return [...set];
}

/** 归一化技能白名单：去重、去空；空数组视为「未限制」→ 返回 undefined。 */
function normalizeSkills(skills?: string[]): string[] | undefined {
  if (!skills || skills.length === 0) return undefined;
  const out = [...new Set(skills.map((s) => String(s ?? '').trim()).filter(Boolean))];
  return out.length ? out : undefined;
}

/** 进程内实现（默认，无持久化）。 */
export class VolatileWorkspaceStore implements WorkspaceStore {
  readonly kind = 'volatile' as const;
  private readonly map = new Map<string, Workspace>();

  list(owner?: string): Workspace[] {
    const all = [...this.map.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    if (!owner) return all;
    return all.filter((w) => w.members.includes(owner));
  }

  get(id: string): Workspace | null {
    return this.map.get(id) ?? null;
  }

  create(input: WorkspaceCreateInput): Workspace {
    const now = Date.now();
    const ws: Workspace = {
      id: genId(),
      name: input.name?.trim() || '未命名空间',
      owner: input.owner,
      members: normalizeMembers(input.owner, input.members),
      ...(input.tenantId ? { tenantId: input.tenantId } : {}),
      ...(normalizeSkills(input.skills) ? { skills: normalizeSkills(input.skills) } : {}),
      ...(input.quota ? { quota: input.quota } : {}),
      createdAt: now,
      updatedAt: now
    };
    this.map.set(ws.id, ws);
    return ws;
  }

  update(id: string, patch: WorkspaceUpdateInput): Workspace | null {
    const cur = this.map.get(id);
    if (!cur) return null;
    const next: Workspace = {
      ...cur,
      ...(patch.name != null ? { name: String(patch.name).trim() || cur.name } : {}),
      ...(patch.members != null
        ? { members: normalizeMembers(cur.owner, patch.members) }
        : {}),
      ...(patch.skills != null ? { skills: normalizeSkills(patch.skills) } : {}),
      ...(patch.quota !== undefined ? { quota: patch.quota } : {}),
      ...(patch.tenantId !== undefined ? { tenantId: patch.tenantId || undefined } : {}),
      updatedAt: Date.now()
    };
    this.map.set(id, next);
    return next;
  }

  remove(id: string): boolean {
    return this.map.delete(id);
  }
}

/**
 * 文件实现：单文件 JSON 数组 + 原子写（tmp → rename），零依赖、单实例落地。
 * 与 chat-sessions 的持久化同款（崩溃不产生半截文件）。
 */
export class FileWorkspaceStore implements WorkspaceStore {
  readonly kind = 'file' as const;
  private readonly file: string;
  private map = new Map<string, Workspace>();
  private loaded = false;

  constructor(opts: { file: string }) {
    this.file = opts.file;
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    // 延迟 require，保持模块顶层零副作用（便于单测注入临时路径）。
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('node:fs') as typeof import('node:fs');
    if (!this.file || !fs.existsSync(this.file)) return;
    try {
      const arr = JSON.parse(fs.readFileSync(this.file, 'utf-8')) as Workspace[];
      for (const w of arr) {
        if (w?.id) {
          this.map.set(w.id, {
            ...w,
            members: normalizeMembers(w.owner, w.members)
          });
        }
      }
    } catch {
      // 损坏存档不致命：从空态继续。
    }
  }

  private persist(): void {
    if (!this.file) return;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('node:fs') as typeof import('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('node:path') as typeof import('node:path');
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify([...this.map.values()], null, 2), 'utf-8');
      fs.renameSync(tmp, this.file);
    } catch {
      // 持久化失败不影响内存态运行。
    }
  }

  list(owner?: string): Workspace[] {
    this.load();
    const all = [...this.map.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    if (!owner) return all;
    return all.filter((w) => w.members.includes(owner));
  }

  get(id: string): Workspace | null {
    this.load();
    return this.map.get(id) ?? null;
  }

  create(input: WorkspaceCreateInput): Workspace {
    this.load();
    const now = Date.now();
    const ws: Workspace = {
      id: genId(),
      name: input.name?.trim() || '未命名空间',
      owner: input.owner,
      members: normalizeMembers(input.owner, input.members),
      ...(input.tenantId ? { tenantId: input.tenantId } : {}),
      ...(normalizeSkills(input.skills) ? { skills: normalizeSkills(input.skills) } : {}),
      ...(input.quota ? { quota: input.quota } : {}),
      createdAt: now,
      updatedAt: now
    };
    this.map.set(ws.id, ws);
    this.persist();
    return ws;
  }

  update(id: string, patch: WorkspaceUpdateInput): Workspace | null {
    this.load();
    const cur = this.map.get(id);
    if (!cur) return null;
    const next: Workspace = {
      ...cur,
      ...(patch.name != null ? { name: String(patch.name).trim() || cur.name } : {}),
      ...(patch.members != null ? { members: normalizeMembers(cur.owner, patch.members) } : {}),
      ...(patch.skills != null ? { skills: normalizeSkills(patch.skills) } : {}),
      ...(patch.quota !== undefined ? { quota: patch.quota } : {}),
      ...(patch.tenantId !== undefined ? { tenantId: patch.tenantId || undefined } : {}),
      updatedAt: Date.now()
    };
    this.map.set(id, next);
    this.persist();
    return next;
  }

  remove(id: string): boolean {
    this.load();
    const ok = this.map.delete(id);
    if (ok) this.persist();
    return ok;
  }
}

/**
 * 组合工厂：按环境变量选择后端。
 * - `WORKSPACE_FILE` 已配置 → FileWorkspaceStore（单实例持久化）
 * - 其余 / 未设置         → VolatileWorkspaceStore（默认，零行为变更）
 */
export function createWorkspaceStore(env: NodeJS.ProcessEnv = process.env): WorkspaceStore {
  const file = env.WORKSPACE_FILE;
  if (file) return new FileWorkspaceStore({ file });
  return new VolatileWorkspaceStore();
}

/**
 * 保证用户至少有一个空间：无任何可见空间时自动创建一个「默认空间」。
 * 幂等：已有空间则原样返回列表。
 */
export function ensureDefaultWorkspace(store: WorkspaceStore, owner: string): Workspace[] {
  const existing = store.list(owner);
  if (existing.length > 0) return existing;
  const created = store.create({ name: DEFAULT_WORKSPACE_NAME, owner });
  return [created];
}

/**
 * 策略编辑器后端（P2-2）。
 *
 * 提供 RBAC 角色-权限矩阵的读取 / 校验 / 写入 / 预览能力，供前端「策略编辑器」Tab 使用。
 * 设计沿用本项目一贯的「接口 + 默认实现 + 组合工厂」范式：
 * - `PolicyStore` 是契约（read / write / preview）；
 * - 默认实现 `FilePolicyStore` 读写 `.data/policy.json`，结构与 `authz.ts` 的
 *   `DEFAULT_MATRIX` + `UI_ROLE_PERMISSIONS` 等价；
 * - `write()` 在落盘前会做合法性校验（Action 必须 ∈ 联合类型，角色 ∈ admin|operator|viewer），
 *   并执行安全护栏校验（不能把所有 admin 权限移除，至少保留一个 escape 通道）；
 * - `preview()` 直接查当前矩阵，判断某角色对某 action 是否放行。
 *
 * 安全：写入必须带 `policy:write` 权限（由调用方在路由层通过 guard 保护）。
 * 本模块不直接读 process.env 的密钥，仅操作 policy.json。
 *
 * 仅使用 node: 内置模块，保持自包含。
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { loadMatrix, type Role, type Action } from './authz';

/** 策略文档：角色-权限矩阵映射，键为角色名，值为该角色拥有的 Action 列表。 */
export interface PolicyDoc {
  matrix: Record<string, Action[]>;
}

export interface PolicyStore {
  /** 读取当前策略文档（从文件或内存）。 */
  read(): Promise<PolicyDoc>;
  /**
   * 校验并写入新的策略文档。
   * 抛错表示校验失败（如权限越界锁死、Action 非法），调用方应回 400。
   */
  write(doc: PolicyDoc): Promise<void>;
  /** 预览某角色对某动作的放行/拒绝（查当前矩阵）。 */
  preview(role: Role, action: Action): Promise<boolean>;
  /** 全部 Action 清单（供前端渲染下拉/矩阵表头）。 */
  listActions(): Action[];
}

/** 默认策略文件路径。 */
const DEFAULT_POLICY_FILE = '.data/policy.json';

/** 合法的角色清单。 */
const ROLES: Role[] = ['admin', 'operator', 'viewer'];

/**
 * 把 `UI_ROLE_PERMISSIONS` 环境变量（JSON 字符串）解析为 Partial 矩阵。
 * 格式：{"admin":[...], "operator":[...], "viewer":[...]}
 */
function parseEnvOverride(
  raw: string | undefined
): Partial<Record<Role, Action[]>> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const out: Partial<Record<Role, Action[]>> = {};
    for (const r of ROLES) {
      const v = (parsed as Record<string, unknown>)[r];
      if (Array.isArray(v)) out[r] = v.map(String) as Action[];
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * 枚举所有 Action 类型。从 authz.ts 的 Action 联合类型导出清单。
 * 此处手动枚举，与 authz.ts 的 Action 类型保持一致；
 * 后续若 Action 增减，需同步更新。
 */
export function allActions(): Action[] {
  return [
    'agent:run:mock',
    'agent:run:real',
    'agent:run:real-mcp',
    'verify',
    'env:create',
    'env:destroy',
    'mcp:read',
    'mcp:add',
    'mcp:preset',
    'mcp:reconnect',
    'mcp:remove',
    'shell:approve',
    'memory:read',
    'memory:clear',
    'metrics:read',
    'errors:read',
    'jobs:read',
    'sessions:read',
    'eval:run',
    'recipe:save',
    'recipe:read',
    'policy:read',
    'policy:write',
    'approvals:review',
    'approvals:read',
    'agent:read',
    'agent:register',
    'workflow:run',
    'workflow:read',
    'a2a:receive',
    'a2a:send',
    'plugin:manage',
    'chat:read',
    'chat:write',
    'chat:delete',
    'env:read',
    'upload:file',
    'provider:manage',
    'features:write',
    'workspace:read',
    'workspace:write',
    'audit:read',
    'org:read',
    'artifact:read',
    'artifact:write',
    'skill:read',
    'skill:manage',
    'datasource:read',
    'datasource:manage',
    'sandbox:use',
    'supplychain:read',
    'plan:read',
    'plan:write',
    'plan:execute'
  ];
}

const VALID_ACTIONS = new Set<Action>(allActions());

/**
 * 校验 PolicyDoc 合法性：
 * - matrix 必须包含所有 Role；
 * - 每个 Action 必须 ∈ allActions()；
 * - 至少保留 admin 角色的 escape 通道（不能清空 admin 权限）。
 */
export function validatePolicyDoc(doc: PolicyDoc): string | null {
  if (!doc || typeof doc !== 'object') return 'PolicyDoc 必须是对象';
  const matrix = doc.matrix;
  if (!matrix || typeof matrix !== 'object') return 'matrix 必须是对象';
  for (const role of ROLES) {
    if (!(role in matrix)) return `缺少角色 ${role}`;
    const acts = matrix[role];
    if (!Array.isArray(acts)) return `角色 ${role} 的权限必须是数组`;
    for (const a of acts) {
      if (!VALID_ACTIONS.has(a)) return `非法 Action: ${a}（角色 ${role}）`;
    }
  }
  // 安全护栏：不能把所有 admin 权限移除（至少保留一个 escape 通道）
  const adminActs = matrix.admin ?? [];
  if (adminActs.length === 0) {
    return 'admin 角色不能清空所有权限（需保留至少一个 Action 以防锁库）';
  }
  return null;
}

export class FilePolicyStore implements PolicyStore {
  private readonly file: string;
  private cached: PolicyDoc | null = null;
  private initialized = false;

  constructor(file?: string) {
    this.file = resolve(file ?? DEFAULT_POLICY_FILE);
  }

  private ensureInitialized(): void {
    if (this.initialized) return;
    this.initialized = true;
  }

  private async readOnDisk(): Promise<PolicyDoc> {
    this.ensureInitialized();
    if (this.cached) return this.cached;

    // 优先从 env 覆盖构造
    const envOverride = parseEnvOverride(process.env.UI_ROLE_PERMISSIONS);
    if (envOverride) {
      const base = loadMatrix();
      this.cached = {
        matrix: {
          admin: envOverride.admin ?? base.admin,
          operator: envOverride.operator ?? base.operator,
          viewer: envOverride.viewer ?? base.viewer
        }
      };
      return this.cached;
    }

    // 再从文件加载
    if (existsSync(this.file)) {
      try {
        const raw = await readFile(this.file, 'utf-8');
        const parsed = JSON.parse(raw) as { matrix?: Record<string, string[]> };
        if (parsed?.matrix) {
          const matrix = parsed.matrix;
          this.cached = {
            matrix: ROLES.reduce(
              (acc, role) => {
                const acts = Array.isArray(matrix[role])
                  ? (matrix[role] as Action[])
                  : loadMatrix()[role];
                acc[role] = acts;
                return acc;
              },
              {} as Record<string, Action[]>
            )
          };
          return this.cached;
        }
      } catch {
        /* 文件损坏时回退默认矩阵 */
      }
    }

    // 文件不存在 / 解析失败：构建默认矩阵
    const base = loadMatrix();
    this.cached = {
      matrix: {
        admin: [...base.admin],
        operator: [...base.operator],
        viewer: [...base.viewer]
      }
    };
    return this.cached;
  }

  async read(): Promise<PolicyDoc> {
    return this.readOnDisk();
  }

  async write(doc: PolicyDoc): Promise<void> {
    const err = validatePolicyDoc(doc);
    if (err) throw new Error(err);
    // 落盘
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(doc, null, 2), 'utf-8');
    this.cached = doc;
  }

  async preview(role: Role, action: Action): Promise<boolean> {
    const doc = await this.readOnDisk();
    const acts = doc.matrix[role] ?? [];
    // 直接查矩阵：复用 authz.ts 的权限判断语义
    return acts.includes(action);
  }

  listActions(): Action[] {
    return allActions();
  }
}

// ── 组合工厂 ──

let storeSingleton: PolicyStore | null = null;

/** 组合工厂：按环境变量 POLICY_FILE 选择文件路径（默认 `.data/policy.json`）。 */
export function getPolicyStore(env: NodeJS.ProcessEnv = process.env): PolicyStore {
  if (!storeSingleton) {
    const file = env.POLICY_FILE || DEFAULT_POLICY_FILE;
    storeSingleton = new FilePolicyStore(file);
  }
  return storeSingleton;
}

/** 供测试注入自定义 store（传 null 重置单例）。 */
export function setPolicyStore(s: PolicyStore | null): void {
  storeSingleton = s;
}

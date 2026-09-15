/**
 * 企业组织树（P1-3）。
 *
 * 提供部门 / 成员层级数据，供前端「企业组织树」可视化与权限/配额按组织单元归属使用。
 *
 * 设计：与本项目一贯的「接口 + 默认实现 + 组合工厂」一致——
 * - `OrgProvider` 是契约（返回一棵 `OrgNode` 树）；
 * - 默认实现 `FileOrgProvider` 从 `ORG_TREE_FILE`（JSON）读取，便于对接企业导出的组织数据；
 * - 文件缺失 / 非法 / 未配置时回落到内置演示树（保证端点始终可用、可演示）；
 * - 后续可新增 `LdapOrgProvider` / `ScimOrgProvider` / `WeComOrgProvider`（企业微信通讯录）实现同一接口，
 *   业务层（路由 + 前端）零改动。
 *
 * 数据不写入，仅读取；端点 `GET /api/org` 受 `org:read` 保护。
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

export type OrgNodeType = 'dept' | 'user';

export interface OrgNode {
  id: string;
  name: string;
  type: OrgNodeType;
  /** 成员标题（如「工程师」），仅 user 节点有意义。 */
  title?: string;
  /** 成员邮箱 / 工号，仅 user 节点有意义。 */
  email?: string;
  /** 子节点（部门下挂子部门或成员）。 */
  children?: OrgNode[];
  /** 便捷统计：该部门（含递归子部门）的成员总数，构建时计算填入。 */
  memberCount?: number;
}

export interface OrgTree {
  root: OrgNode;
  /** 数据来源：file=配置文件 / demo=内置演示 / 具体 provider 名。 */
  source: string;
}

export interface OrgProvider {
  readonly name: string;
  getTree(): Promise<OrgTree>;
}

// ── 内置演示树：保证端点始终有可演示数据 ──
const DEMO_TREE: OrgNode = {
  id: 'root',
  name: '示例企业',
  type: 'dept',
  children: [
    {
      id: 'rd',
      name: '研发部',
      type: 'dept',
      children: [
        { id: 'u-alice', name: 'Alice', type: 'user', title: '首席工程师', email: 'alice@demo.co' },
        { id: 'u-bob', name: 'Bob', type: 'user', title: '后端工程师', email: 'bob@demo.co' },
        {
          id: 'platform',
          name: '平台组',
          type: 'dept',
          children: [
            { id: 'u-carol', name: 'Carol', type: 'user', title: 'SRE', email: 'carol@demo.co' }
          ]
        }
      ]
    },
    {
      id: 'biz',
      name: '业务部',
      type: 'dept',
      children: [
        { id: 'u-dave', name: 'Dave', type: 'user', title: '产品经理', email: 'dave@demo.co' }
      ]
    }
  ]
};

/** 递归校验并归一化外部输入（容错：跳过 id/name/type 缺失的节点，扁平化非法 children）。 */
export function normalize(node: any, seen = new Set<string>()): OrgNode | null {
  if (!node || typeof node !== 'object') return null;
  const id = String(node.id ?? '');
  const name = String(node.name ?? '');
  const type: OrgNodeType = node.type === 'user' ? 'user' : 'dept';
  if (!id || !name) return null;
  // 防环：仅 dept 展开子节点，且当前 id 不得已在祖先链中（自引用 / 环形数据）。
  // 祖先集合不删除（不按分支回退），确保任意祖先 id 不会在后代中重复展开，
  // 环形 / 重复 id 数据收敛为叶子而非无限递归；正常树无副作用。
  const childrenRaw = Array.isArray(node.children) ? node.children : [];
  const children: OrgNode[] = [];
  if (type === 'dept' && !seen.has(id)) {
    seen.add(id);
    for (const c of childrenRaw) {
      const n = normalize(c, seen);
      if (n) children.push(n);
    }
  }
  const out: OrgNode = { id, name, type };
  if (type === 'user') {
    if (node.title != null) out.title = String(node.title);
    if (node.email != null) out.email = String(node.email);
  } else if (children.length) {
    out.children = children;
  }
  return out;
}

/** 递归计算部门（含子部门）成员总数。 */
export function computeMemberCount(node: OrgNode): number {
  if (node.type === 'user') return 1;
  let n = 0;
  for (const c of node.children ?? []) n += computeMemberCount(c);
  node.memberCount = n;
  return n;
}

export class FileOrgProvider implements OrgProvider {
  readonly name = 'file';
  constructor(private readonly file: string | undefined) {}

  async getTree(): Promise<OrgTree> {
    if (!this.file || !existsSync(this.file)) {
      return this.demo();
    }
    try {
      const raw = await readFile(this.file, 'utf-8');
      const parsed = JSON.parse(raw);
      const node = normalize(parsed?.root ?? parsed);
      if (!node) return this.demo();
      computeMemberCount(node);
      return { root: node, source: `file:${this.file}` };
    } catch {
      // 文件损坏 / 解析失败：回落演示树，避免端点 5xx。
      return this.demo();
    }
  }

  private demo(): OrgTree {
    const root = JSON.parse(JSON.stringify(DEMO_TREE)) as OrgNode;
    computeMemberCount(root);
    return { root, source: 'demo' };
  }
}

let providerSingleton: OrgProvider | null = null;

/** 组合工厂：按环境变量选择 provider（默认 file 回落 demo）。 */
export function getOrgProvider(env: NodeJS.ProcessEnv = process.env): OrgProvider {
  if (!providerSingleton) {
    providerSingleton = new FileOrgProvider(env.ORG_TREE_FILE || undefined);
  }
  return providerSingleton;
}

/** 供测试注入自定义 provider。 */
export function setOrgProvider(p: OrgProvider | null): void {
  providerSingleton = p;
}

export async function getOrgTree(env: NodeJS.ProcessEnv = process.env): Promise<OrgTree> {
  return getOrgProvider(env).getTree();
}

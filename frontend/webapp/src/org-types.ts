/** 企业组织树类型（与 access/server/src/org.ts 的 OrgNode / OrgTree 保持一致）。 */
export type OrgNodeType = 'dept' | 'user';

export interface OrgNode {
  id: string;
  name: string;
  type: OrgNodeType;
  title?: string;
  email?: string;
  children?: OrgNode[];
  memberCount?: number;
}

export interface OrgTree {
  root: OrgNode;
  source: string;
}

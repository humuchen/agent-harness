/**
 * 用户展示相关的纯函数（顶栏头像、我页、设置中心共用）。
 *
 * 集中在此避免各组件重复实现同一套「角色中文名 / 头像占位字」规则：
 *  - 角色徽标文案（admin / operator / viewer → 管理员 / 操作员 / 访客）；
 *  - 头像占位字（中文取首字，英文取首 1-2 字母大写）。
 */

/** 角色 → 中文标签。未识别的角色原样透出，避免展示空白。 */
const ROLE_LABEL: Record<string, string> = {
  admin: '管理员',
  operator: '操作员',
  viewer: '访客'
};

export function roleLabel(role: string): string {
  return ROLE_LABEL[role] ?? role;
}

/** 取用户名首字母（中文取首字，英文取首 1-2 字母）作头像占位。 */
export function avatarInitial(name: string): string {
  const n = (name || '?').trim();
  if (!n) return '?';
  // 中文/日文等：取首字
  if (/[一-龥぀-ヿ]/.test(n[0]!)) return n[0]!;
  // 英文：首字母大写
  return n.slice(0, 2).toUpperCase();
}

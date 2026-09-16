/**
 * <ah-plan-board> 的纯逻辑工具集（无 DOM、无副作用、可单测）。
 *
 * 抽出原因：泳道分组与完成度统计是「桌面横向四列」与「移动端纵向四分区」共用的
 * 同一份语义，写在 render() 里既不可测，两套视图也容易各自漂移（例如列序或标签
 * 改了一处漏了另一处）。这里作为列序 / 标签 / 分组的单一来源。
 */
import type { PlanNode, PlanNodeStatus } from './plan-board';

/** 泳道顺序：桌面横向列序 = 移动端纵向分区序，单一来源。 */
export const PLAN_COLUMNS: PlanNodeStatus[] = ['todo', 'doing', 'done', 'blocked'];

/** 泳道标题。 */
export const PLAN_COLUMN_LABELS: Record<PlanNodeStatus, string> = {
  todo: '待办',
  doing: '进行中',
  done: '已完成',
  blocked: '阻塞'
};

/**
 * 按状态分组，保持节点在文档中的原序（看板内不重排，避免与后端顺序不一致）。
 * 未知状态一律归入「待办」——否则该节点在四个泳道里都不出现，等于凭空丢失。
 */
export function groupNodesByStatus(
  nodes: readonly PlanNode[]
): Record<PlanNodeStatus, PlanNode[]> {
  const out: Record<PlanNodeStatus, PlanNode[]> = {
    todo: [],
    doing: [],
    done: [],
    blocked: []
  };
  for (const node of nodes) {
    const key = PLAN_COLUMNS.includes(node.status) ? node.status : 'todo';
    out[key].push(node);
  }
  return out;
}

/** 完成度统计；total 为 0 时 percent 记 0，避免 NaN% 写进样式。 */
export function planProgress(nodes: readonly PlanNode[]): {
  done: number;
  total: number;
  percent: number;
} {
  const total = nodes.length;
  const done = nodes.filter((n) => n.status === 'done').length;
  return { done, total, percent: total === 0 ? 0 : Math.round((done / total) * 100) };
}

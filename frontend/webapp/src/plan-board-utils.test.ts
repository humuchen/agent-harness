import { describe, expect, it } from 'vitest';
import {
  PLAN_COLUMNS,
  PLAN_COLUMN_LABELS,
  groupNodesByStatus,
  planProgress
} from './plan-board-utils';
import type { PlanNode, PlanNodeStatus } from './plan-board';

function node(id: string, status: PlanNodeStatus): PlanNode {
  return { id, title: `任务 ${id}`, status, dependsOn: [] };
}

describe('PLAN_COLUMNS', () => {
  it('四个泳道的顺序与标签稳定（桌面列序 = 移动端分区序）', () => {
    expect(PLAN_COLUMNS).toEqual(['todo', 'doing', 'done', 'blocked']);
    expect(PLAN_COLUMN_LABELS.todo).toBe('待办');
    expect(PLAN_COLUMN_LABELS.doing).toBe('进行中');
    expect(PLAN_COLUMN_LABELS.done).toBe('已完成');
    expect(PLAN_COLUMN_LABELS.blocked).toBe('阻塞');
  });
});

describe('groupNodesByStatus', () => {
  it('按状态分组且保持原序', () => {
    const nodes = [
      node('a', 'todo'),
      node('b', 'doing'),
      node('c', 'done'),
      node('d', 'todo'),
      node('e', 'blocked'),
      node('f', 'done')
    ];
    const grouped = groupNodesByStatus(nodes);
    expect(grouped.todo.map((n) => n.id)).toEqual(['a', 'd']);
    expect(grouped.doing.map((n) => n.id)).toEqual(['b']);
    expect(grouped.done.map((n) => n.id)).toEqual(['c', 'f']);
    expect(grouped.blocked.map((n) => n.id)).toEqual(['e']);
  });

  it('空输入返回四个空泳道（不返回 undefined，渲染层无需兜底）', () => {
    const grouped = groupNodesByStatus([]);
    for (const col of PLAN_COLUMNS) expect(grouped[col]).toEqual([]);
  });

  it('未知状态归入待办，节点不会凭空消失', () => {
    const weird = { id: 'x', title: 'x', status: 'paused' as PlanNodeStatus, dependsOn: [] };
    const grouped = groupNodesByStatus([weird]);
    expect(grouped.todo.map((n) => n.id)).toEqual(['x']);
    const total = PLAN_COLUMNS.reduce((sum, col) => sum + grouped[col].length, 0);
    expect(total).toBe(1);
  });
});

describe('planProgress', () => {
  it('统计已完成数与百分比（四舍五入）', () => {
    const nodes = [
      node('a', 'done'),
      node('b', 'done'),
      node('c', 'doing'),
      node('d', 'todo'),
      node('e', 'blocked')
    ];
    expect(planProgress(nodes)).toEqual({ done: 2, total: 5, percent: 40 });
  });

  it('空计划不产生 NaN', () => {
    expect(planProgress([])).toEqual({ done: 0, total: 0, percent: 0 });
  });

  it('进度条宽度落在 0-100 之间（可直接写进 style）', () => {
    const p = planProgress([node('a', 'done'), node('b', 'done'), node('c', 'done')]);
    expect(p.percent).toBe(100);
    expect(p.percent).toBeLessThanOrEqual(100);
  });
});

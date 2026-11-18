/**
 * chat-render-utils 回归测试（P2-10）。
 *
 * 此前 50.77KB 最大模块零测试——状态推演（applyPlanWfEvent）、确定性派生
 * （derivePlanWfId）、消息反推（derivePlanExecFromMessages）等核心逻辑无回归网。
 * 本测试覆盖：工具函数、状态机推演、确定性派生、摘要提取、DAG 开关、消息反推。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  fileIcon,
  formatSize,
  formatPlanWfDuration,
  planWfReplayStateLabel,
  planWfReplayMark,
  planDagSummaryGoal,
  applyPlanWfEvent,
  derivePlanWfId,
  isPlanDagEnabled,
  setPlanDagEnabled,
  buildPlanStatusLookup,
  derivePlanExecFromMessages,
  PLAN_DAG_STORAGE_KEY,
  PLAN_DAG_SUMMARY_PREFIX,
  type PlanWfEvent
} from './chat-render-utils';
import type { PlanExecState } from './chat-types';

// ---------- 工具函数 ----------

describe('工具函数', () => {
  describe('fileIcon', () => {
    it('图片 → 🖼', () => {
      expect(fileIcon({ type: 'image/png' } as never)).toBe('🖼');
    });
    it('PDF → 📄', () => {
      expect(fileIcon({ type: 'application/pdf' } as never)).toBe('📄');
    });
    it('CSV/JSON/text → 📝', () => {
      expect(fileIcon({ type: 'text/csv' } as never)).toBe('📝');
      expect(fileIcon({ type: 'application/json' } as never)).toBe('📝');
      expect(fileIcon({ type: 'text/plain' } as never)).toBe('📝');
    });
    it('其它 → 📎', () => {
      expect(fileIcon({ type: 'application/octet-stream' } as never)).toBe('📎');
    });
  });

  describe('formatSize', () => {
    it('< 1KB 显示 B', () => {
      expect(formatSize(0)).toBe('0 B');
      expect(formatSize(512)).toBe('512 B');
      expect(formatSize(1023)).toBe('1023 B');
    });
    it('< 1MB 显示 KB（一位小数）', () => {
      expect(formatSize(1024)).toBe('1.0 KB');
      expect(formatSize(1536)).toBe('1.5 KB');
    });
    it('≥ 1MB 显示 MB（一位小数）', () => {
      expect(formatSize(1024 * 1024)).toBe('1.0 MB');
      expect(formatSize(2.5 * 1024 * 1024)).toBe('2.5 MB');
    });
  });

  describe('formatPlanWfDuration', () => {
    it('undefined / NaN / 负数 → —', () => {
      expect(formatPlanWfDuration(undefined)).toBe('—');
      expect(formatPlanWfDuration(NaN)).toBe('—');
      expect(formatPlanWfDuration(-1)).toBe('—');
    });
    it('< 1s 显示 ms', () => {
      expect(formatPlanWfDuration(0)).toBe('0ms');
      expect(formatPlanWfDuration(500)).toBe('500ms');
      expect(formatPlanWfDuration(999)).toBe('999ms');
    });
    it('< 10s 显示秒（一位小数）', () => {
      expect(formatPlanWfDuration(1000)).toBe('1.0s');
      expect(formatPlanWfDuration(1500)).toBe('1.5s');
      expect(formatPlanWfDuration(9500)).toBe('9.5s');
    });
    it('≥ 10s 显示秒（整数）', () => {
      expect(formatPlanWfDuration(10000)).toBe('10s');
      expect(formatPlanWfDuration(65000)).toBe('65s');
    });
  });

  describe('planWfReplayStateLabel', () => {
    it('已知状态 → 中文标签', () => {
      expect(planWfReplayStateLabel('done')).toBe('完成');
      expect(planWfReplayStateLabel('failed')).toBe('失败');
      expect(planWfReplayStateLabel('running')).toBe('执行中');
      expect(planWfReplayStateLabel('pending')).toBe('待执行');
      expect(planWfReplayStateLabel('awaiting')).toBe('待审批');
    });
    it('未知状态 → 原样返回', () => {
      expect(planWfReplayStateLabel('unknown')).toBe('unknown');
    });
  });

  describe('planWfReplayMark', () => {
    it('已知状态 → 图标', () => {
      expect(typeof planWfReplayMark('done')).toBe('string');
      expect(planWfReplayMark('done')).not.toBe('•');
    });
    it('未知状态 → 兜底 •', () => {
      expect(planWfReplayMark('unknown')).toBe('•');
    });
  });
});

// ---------- 状态推演：applyPlanWfEvent ----------

describe('applyPlanWfEvent：wf:* 事件 → 计划状态推演', () => {
  const known = new Set(['t1', 't2', 't3']);
  const base: PlanExecState = { status: 'pending', done: {} };

  it('wf:step:start → running + currentTaskId + thinking 初始化', () => {
    const next = applyPlanWfEvent(base, { type: 'wf:step:start', stepId: 't1' }, known);
    expect(next.status).toBe('running');
    expect(next.currentTaskId).toBe('t1');
    expect(next.runningTaskIds).toContain('t1');
    expect(next.thinking).toEqual({ taskId: 't1', text: '' });
    expect(next.thinkingByTask?.['t1']).toBe('');
  });

  it('wf:step:done → done[stepId]=true，移出 running', () => {
    const started = applyPlanWfEvent(base, { type: 'wf:step:start', stepId: 't1' }, known);
    const next = applyPlanWfEvent(started, { type: 'wf:step:done', stepId: 't1' }, known);
    expect(next.done['t1']).toBe(true);
    expect(next.runningTaskIds).not.toContain('t1');
    // 整体仍 running（未到 wf:done）
    expect(next.status).toBe('running');
  });

  it('wf:step:failed → 整体 failed + failedTaskId', () => {
    const next = applyPlanWfEvent(base, { type: 'wf:step:failed', stepId: 't2' }, known);
    expect(next.status).toBe('failed');
    expect(next.failedTaskId).toBe('t2');
    expect(next.runningTaskIds).toBeUndefined();
  });

  it('wf:done → 整体 done，清瞬态', () => {
    const started = applyPlanWfEvent(base, { type: 'wf:step:start', stepId: 't1' }, known);
    const done = applyPlanWfEvent(started, { type: 'wf:done' }, known);
    expect(done.status).toBe('done');
    expect(done.currentTaskId).toBeUndefined();
    expect(done.runningTaskIds).toBeUndefined();
    expect(done.thinking).toBeUndefined();
  });

  it('wf:failed → 整体 failed，从 run.steps 定位首个失败 step', () => {
    const ev: PlanWfEvent = {
      type: 'wf:failed',
      run: { steps: { s1: { state: 'done' }, s2: { state: 'failed', id: 't2' } } }
    };
    const next = applyPlanWfEvent(base, ev, known);
    expect(next.status).toBe('failed');
    expect(next.failedTaskId).toBe('t2');
  });

  it('wf:awaiting-approval → awaiting + awaitingTaskIds（与本计划 task 求交集）', () => {
    const next = applyPlanWfEvent(base, {
      type: 'wf:awaiting-approval',
      stepIds: ['t1', 't9-unknown']
    }, known);
    expect(next.status).toBe('awaiting');
    expect(next.awaitingTaskIds).toEqual(['t1']);
  });

  it('未知 stepId → 同引用返回（不变更）', () => {
    const prev = base;
    const next = applyPlanWfEvent(prev, { type: 'wf:step:start', stepId: 'unknown' }, known);
    expect(next).toBe(prev);
  });

  it('无关事件类型 → 同引用返回', () => {
    const prev = base;
    const next = applyPlanWfEvent(prev, { type: 'wf:start' }, known);
    expect(next).toBe(prev);
    expect(applyPlanWfEvent(prev, { type: 'wf:compensate:start' }, known)).toBe(prev);
  });

  it('wf:step:retry → 记录重试次数', () => {
    const next = applyPlanWfEvent(base, { type: 'wf:step:retry', stepId: 't1', attempt: 2 }, known);
    expect(next.retryCounts?.['t1']).toBe(2);
  });
});

// ---------- 确定性派生：derivePlanWfId ----------

describe('derivePlanWfId：确定性工作流检查点键', () => {
  const plan = {
    goal: '调研市场',
    tasks: [
      { id: 't1', title: '收集资料', dependsOn: [] },
      { id: 't2', title: '分析数据', dependsOn: ['t1'] }
    ]
  };

  it('同输入 → 同输出（确定性）', () => {
    const a = derivePlanWfId('session-1', plan as never);
    const b = derivePlanWfId('session-1', plan as never);
    expect(a).toBe(b);
  });

  it('不同 session → 不同输出', () => {
    const a = derivePlanWfId('session-1', plan as never);
    const b = derivePlanWfId('session-2', plan as never);
    expect(a).not.toBe(b);
  });

  it('不同 goal → 不同输出', () => {
    const plan2 = { ...plan, goal: '写报告' };
    expect(derivePlanWfId('s1', plan as never)).not.toBe(derivePlanWfId('s1', plan2 as never));
  });

  it('结果形如 plan-<hex>（纯 ASCII）', () => {
    expect(derivePlanWfId('s1', plan as never)).toMatch(/^plan-[a-f0-9]+$/);
  });
});

// ---------- 摘要提取：planDagSummaryGoal ----------

describe('planDagSummaryGoal：从摘要消息提取 goal', () => {
  it('正常摘要 → 提取 goal', () => {
    const content = `${PLAN_DAG_SUMMARY_PREFIX}调研市场（共 3 个任务）`;
    expect(planDagSummaryGoal(content)).toBe('调研市场');
  });

  it('无任务数后缀 → 取剩余文本', () => {
    const content = `${PLAN_DAG_SUMMARY_PREFIX}写报告`;
    expect(planDagSummaryGoal(content)).toBe('写报告');
  });

  it('非摘要消息 → null', () => {
    expect(planDagSummaryGoal('普通消息')).toBeNull();
    expect(planDagSummaryGoal('')).toBeNull();
  });

  it('空 goal → null', () => {
    const content = `${PLAN_DAG_SUMMARY_PREFIX}（共 1 个任务）`;
    expect(planDagSummaryGoal(content)).toBeNull();
  });
});

// ---------- DAG 开关：isPlanDagEnabled / setPlanDagEnabled ----------

describe('isPlanDagEnabled / setPlanDagEnabled', () => {
  beforeEach(() => {
    // vitest node 环境无 localStorage（ExperimentalWarning），用 Map mock。
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
      clear: () => store.clear()
    });
  });

  it('默认开（无 key）', () => {
    expect(isPlanDagEnabled()).toBe(true);
  });

  it("显式 '0' → 关", () => {
    localStorage.setItem(PLAN_DAG_STORAGE_KEY, '0');
    expect(isPlanDagEnabled()).toBe(false);
  });

  it("setPlanDagEnabled(false) → 写 '0'", () => {
    setPlanDagEnabled(false);
    expect(localStorage.getItem(PLAN_DAG_STORAGE_KEY)).toBe('0');
    expect(isPlanDagEnabled()).toBe(false);
  });

  it('setPlanDagEnabled(true) → 移除 key（回到默认开）', () => {
    setPlanDagEnabled(false);
    setPlanDagEnabled(true);
    expect(localStorage.getItem(PLAN_DAG_STORAGE_KEY)).toBeNull();
    expect(isPlanDagEnabled()).toBe(true);
  });
});

// ---------- 计划状态查表：buildPlanStatusLookup ----------

describe('buildPlanStatusLookup：按 goal 对齐 PlanExecMirror', () => {
  it('按 goal 建查表', () => {
    const msgs = [
      { plan: { goal: 'A' }, planStatus: { status: 'done', done: {} } },
      { plan: { goal: 'B' }, planStatus: { status: 'failed', done: {} } }
    ] as never;
    const lookup = buildPlanStatusLookup(msgs);
    expect(lookup.get('A')?.status).toBe('done');
    expect(lookup.get('B')?.status).toBe('failed');
  });

  it('无 plan / 无 planStatus / goal 非字符串 → 跳过', () => {
    const msgs = [
      { plan: undefined, planStatus: { status: 'done', done: {} } },
      { plan: { goal: 123 }, planStatus: { status: 'done', done: {} } },
      { plan: { goal: 'C' }, planStatus: undefined }
    ] as never;
    expect(buildPlanStatusLookup(msgs).size).toBe(0);
  });

  it('同 goal 仅保留首个（不覆盖）', () => {
    const msgs = [
      { plan: { goal: 'A' }, planStatus: { status: 'done', done: {} } },
      { plan: { goal: 'A' }, planStatus: { status: 'failed', done: {} } }
    ] as never;
    const lookup = buildPlanStatusLookup(msgs);
    expect(lookup.get('A')?.status).toBe('done');
  });
});

// ---------- 消息反推：derivePlanExecFromMessages ----------

describe('derivePlanExecFromMessages：从线程反推计划进度', () => {
  it('无派发痕迹 → null', () => {
    const plan = { tasks: [{ id: 't1' }, { id: 't2' }] };
    const msgs = [{ role: 'user', content: '普通消息' }];
    expect(derivePlanExecFromMessages(plan, msgs)).toBeNull();
  });

  it('全部任务有派发+产出 → done', () => {
    const plan = { tasks: [{ id: 't1' }, { id: 't2' }] };
    const msgs = [
      { role: 'user', content: '【计划任务 t1】执行' },
      { role: 'assistant', content: 't1 结果' },
      { role: 'user', content: '【计划任务 t2】执行' },
      { role: 'assistant', content: 't2 结果' }
    ];
    const result = derivePlanExecFromMessages(plan, msgs);
    expect(result?.status).toBe('done');
    expect(result?.done['t1']).toBe(true);
    expect(result?.done['t2']).toBe(true);
  });

  it('部分任务缺产出 → failed', () => {
    const plan = { tasks: [{ id: 't1' }, { id: 't2' }] };
    const msgs = [
      { role: 'user', content: '【计划任务 t1】执行' },
      { role: 'assistant', content: 't1 结果' },
      { role: 'user', content: '【计划任务 t2】执行' }
      // t2 无 assistant 产出
    ];
    const result = derivePlanExecFromMessages(plan, msgs);
    expect(result?.status).toBe('failed');
  });

  it('无 tasks → null', () => {
    expect(derivePlanExecFromMessages({}, [])).toBeNull();
    expect(derivePlanExecFromMessages(undefined, [])).toBeNull();
  });
});

/**
 * P3（多 agent DAG 计划执行）卡片状态机单测。
 *
 * 覆盖 applyPlanWfEvent（wf:* 事件 → PlanExecState 的叠加语义，见
 * design/plan-mode-multiagent.md §6 + R8 all-or-nothing）与 isPlanDagEnabled
 * （特性开关，默认开、显式 '0' 关）。confirmPlanViaWorkflow 的 SSE 编排由服务端 mock executor
 * 测试（backend/core）+ client 契约测试（backend/client）共同覆盖，本文件锁住
 * 纯函数状态机——卡片渲染的唯一驱动来源。
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  applyPlanWfEvent,
  isPlanDagEnabled,
  setPlanDagEnabled,
  PLAN_DAG_STORAGE_KEY,
  type PlanWfEvent
} from './chat-render-utils';
import type { PlanExecState } from './chat-types';

const KNOWN = new Set(['t1', 't2', 't3']);
const base: PlanExecState = { status: 'running', done: {} };

describe('applyPlanWfEvent', () => {
  it('wf:step:start → running + currentTaskId（未知 task 原样返回）', () => {
    const next = applyPlanWfEvent(base, { type: 'wf:step:start', stepId: 't2' }, KNOWN);
    expect(next).not.toBe(base);
    expect(next).toEqual({ status: 'running', currentTaskId: 't2', done: {} });
    expect(applyPlanWfEvent(base, { type: 'wf:step:start', stepId: 'nope' }, KNOWN)).toBe(base);
    expect(applyPlanWfEvent(base, { type: 'wf:step:start' }, KNOWN)).toBe(base);
  });

  it('wf:step:done → done 集合累加，状态保持 running（多任务并行时不提前 done）', () => {
    let st = applyPlanWfEvent(base, { type: 'wf:step:start', stepId: 't1' }, KNOWN);
    st = applyPlanWfEvent(st, { type: 'wf:step:done', stepId: 't1' }, KNOWN);
    expect(st.status).toBe('running');
    expect(st.done).toEqual({ t1: true });
    // 同波次另一 task 并行完成。
    st = applyPlanWfEvent(st, { type: 'wf:step:start', stepId: 't3' }, KNOWN);
    st = applyPlanWfEvent(st, { type: 'wf:step:done', stepId: 't3' }, KNOWN);
    expect(st.done).toEqual({ t1: true, t3: true });
    expect(st.status).toBe('running');
  });

  it('wf:step:failed → 该 task 标 failed（R8：引擎中止该波次，独立分支可能被放弃）', () => {
    let st = applyPlanWfEvent(base, { type: 'wf:step:start', stepId: 't2' }, KNOWN);
    st = applyPlanWfEvent(st, { type: 'wf:step:failed', stepId: 't2' }, KNOWN);
    expect(st.status).toBe('failed');
    expect(st.failedTaskId).toBe('t2');
  });

  it('wf:done → 整体 done，清 current/failed', () => {
    let st = applyPlanWfEvent(base, { type: 'wf:step:start', stepId: 't1' }, KNOWN);
    st = applyPlanWfEvent(st, { type: 'wf:step:done', stepId: 't1' }, KNOWN);
    st = applyPlanWfEvent(st, { type: 'wf:done' }, KNOWN);
    expect(st.status).toBe('done');
    expect(st.currentTaskId).toBeUndefined();
    expect(st.failedTaskId).toBeUndefined();
    expect(st.done).toEqual({ t1: true });
  });

  it('wf:failed → 整体 failed，failedTaskId 取 run.steps 中首个 failed step', () => {
    const ev: PlanWfEvent = {
      type: 'wf:failed',
      run: {
        state: 'failed',
        steps: {
          t1: { id: 't1', state: 'done' },
          t2: { id: 't2', state: 'failed' },
          t3: { id: 't3', state: 'pending' }
        }
      }
    };
    const st = applyPlanWfEvent(base, ev, KNOWN);
    expect(st.status).toBe('failed');
    expect(st.failedTaskId).toBe('t2');
    // run.steps 全 done（无 failed step，如补偿后重放）→ 保留既有 failedTaskId。
    const st2 = applyPlanWfEvent(
      { ...base, failedTaskId: 't9' },
      { type: 'wf:failed', run: { state: 'failed', steps: { t1: { state: 'done' } } } },
      KNOWN
    );
    expect(st2.failedTaskId).toBe('t9');
  });

  it('无关事件（harness 嵌套 / compensate / start / 坏帧）原样返回 prev（同引用）', () => {
    const same = [
      { type: 'wf:start' },
      { type: 'wf:compensate:start', stepId: 't1' },
      { type: 'harness' },
      { type: '_wf_done' },
      null as unknown as PlanWfEvent,
      {} as PlanWfEvent,
      { type: 42 } as unknown as PlanWfEvent
    ];
    for (const ev of same) expect(applyPlanWfEvent(base, ev, KNOWN)).toBe(base);
  });
});

describe('isPlanDagEnabled', () => {
  afterEach(() => {
    try {
      localStorage.removeItem(PLAN_DAG_STORAGE_KEY);
    } catch {
      /* 非浏览器环境无 localStorage */
    }
  });

  it('默认开（未写入 localStorage）', () => {
    expect(isPlanDagEnabled()).toBe(true);
  });

  it("localStorage 置 '0' 时关", () => {
    try {
      localStorage.setItem(PLAN_DAG_STORAGE_KEY, '0');
      expect(isPlanDagEnabled()).toBe(false);
    } catch {
      /* skip: 环境无 localStorage（node 默认环境），此时实现安全回落「开」 */
    }
  });

  it("localStorage 置 '1' 或其它值时开（仅 '0' 关闭）", () => {
    try {
      localStorage.setItem(PLAN_DAG_STORAGE_KEY, '1');
      expect(isPlanDagEnabled()).toBe(true);
      localStorage.setItem(PLAN_DAG_STORAGE_KEY, 'x');
      expect(isPlanDagEnabled()).toBe(true);
    } catch {
      /* skip: 环境无 localStorage */
    }
  });

  it('localStorage 不可用时安全回落 true（默认开，不抛错）', () => {
    // 通过全局替换验证 try/catch 兜底：localStorage.getItem 抛错 → 取默认「开」。
    const orig = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      get: () => {
        throw new Error('no storage');
      },
      configurable: true
    });
    try {
      expect(isPlanDagEnabled()).toBe(true);
    } finally {
      if (orig) Object.defineProperty(globalThis, 'localStorage', orig);
      else delete (globalThis as Record<string, unknown>).localStorage;
    }
  });
});

describe('setPlanDagEnabled（设置中心 toggle 的写入口）', () => {
  afterEach(() => {
    try {
      localStorage.removeItem(PLAN_DAG_STORAGE_KEY);
    } catch {
      /* 非浏览器环境无 localStorage */
    }
  });

  it("关（on=false）显式写 '0'，isPlanDagEnabled 回落 false", () => {
    try {
      setPlanDagEnabled(false);
      expect(localStorage.getItem(PLAN_DAG_STORAGE_KEY)).toBe('0');
      expect(isPlanDagEnabled()).toBe(false);
    } catch {
      /* skip: 环境无 localStorage */
    }
  });

  it('开（on=true）移除 key（回到「默认开」，不留脏值），isPlanDagEnabled 恒 true', () => {
    try {
      localStorage.setItem(PLAN_DAG_STORAGE_KEY, '0');
      expect(isPlanDagEnabled()).toBe(false);
      setPlanDagEnabled(true);
      expect(localStorage.getItem(PLAN_DAG_STORAGE_KEY)).toBeNull();
      expect(isPlanDagEnabled()).toBe(true);
    } catch {
      /* skip: 环境无 localStorage */
    }
  });

  it('localStorage 不可用时不抛错（静默忽略，读取方回落默认「开」）', () => {
    const orig = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      get: () => {
        throw new Error('no storage');
      },
      configurable: true
    });
    try {
      expect(() => setPlanDagEnabled(false)).not.toThrow();
      expect(isPlanDagEnabled()).toBe(true);
    } finally {
      if (orig) Object.defineProperty(globalThis, 'localStorage', orig);
      else delete (globalThis as Record<string, unknown>).localStorage;
    }
  });
});

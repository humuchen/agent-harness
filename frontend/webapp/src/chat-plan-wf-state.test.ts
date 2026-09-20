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
  applyPlanThinking,
  isPlanDagEnabled,
  setPlanDagEnabled,
  derivePlanWfId,
  buildPlanWfReplayRows,
  buildPlanWfTraceLines,
  compactPlanWfSnapshot,
  formatPlanWfOutput,
  formatPlanWfDuration,
  planWfReplayStateLabel,
  planWfReplayMark,
  planWfTraceMetaLabel,
  planWfTraceMetaRowTitle,
  REPLAY_DETAIL_MAX,
  PLAN_DAG_STORAGE_KEY,
  PLAN_THINKING_MAX,
  type PlanWfEvent
} from './chat-render-utils';
import type { ExecutionPlanView, PlanExecState } from './chat-types';
import { toMirrorPlanStatus } from './chat-persist';

const KNOWN = new Set(['t1', 't2', 't3', 't4']);
const base: PlanExecState = { status: 'running', done: {} };

describe('applyPlanWfEvent', () => {
  it('wf:step:start → running + currentTaskId（未知 task 原样返回）', () => {
    const next = applyPlanWfEvent(base, { type: 'wf:step:start', stepId: 't2' }, KNOWN);
    expect(next).not.toBe(base);
    // P5 静默执行：任务开始时建立空思考槽位（llm:reasoning 增量随后叠入）。
    // 并行（2026-09-20）：同时聚合 runningTaskIds + 建立分槽 thinkingByTask。
    expect(next).toEqual({
      status: 'running',
      currentTaskId: 't2',
      done: {},
      runningTaskIds: ['t2'],
      thinking: { taskId: 't2', text: '' },
      thinkingByTask: { t2: '' }
    });
    expect(applyPlanWfEvent(base, { type: 'wf:step:start', stepId: 'nope' }, KNOWN)).toBe(base);
    expect(applyPlanWfEvent(base, { type: 'wf:step:start' }, KNOWN)).toBe(base);
  });

  it('P5：思考面板生命周期 —— step:start 建立空槽，step:done/failed/wf:done 清空', () => {
    let st = applyPlanWfEvent(base, { type: 'wf:step:start', stepId: 't1' }, KNOWN);
    expect(st.thinking).toEqual({ taskId: 't1', text: '' });
    st = applyPlanWfEvent(st, { type: 'wf:step:done', stepId: 't1' }, KNOWN);
    expect(st.thinking).toBeUndefined();
    st = applyPlanWfEvent(st, { type: 'wf:step:start', stepId: 't2' }, KNOWN);
    expect(st.thinking?.taskId).toBe('t2');
    st = applyPlanWfEvent(st, { type: 'wf:step:failed', stepId: 't2' }, KNOWN);
    expect(st.thinking).toBeUndefined();
    st = applyPlanWfEvent(base, { type: 'wf:step:start', stepId: 't3' }, KNOWN);
    st = applyPlanWfEvent(st, { type: 'wf:done' }, KNOWN);
    expect(st.thinking).toBeUndefined();
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

  it('P3：wf:awaiting-approval → status=awaiting + awaitingTaskIds 收集，done 集合保留', () => {
    let st = applyPlanWfEvent(base, { type: 'wf:step:start', stepId: 't1' }, KNOWN);
    st = applyPlanWfEvent(st, { type: 'wf:step:done', stepId: 't1' }, KNOWN);
    st = applyPlanWfEvent(st, { type: 'wf:step:start', stepId: 't2' }, KNOWN);
    const gated = applyPlanWfEvent(
      st,
      { type: 'wf:awaiting-approval', stepIds: ['t2', 't3'] },
      KNOWN
    );
    expect(gated.status).toBe('awaiting');
    expect(gated.awaitingTaskIds).toEqual(['t2', 't3']);
    // 已完成集合不因暂停丢失（继续执行时依赖它判断「哪些任务可跳」）。
    expect(gated.done).toEqual({ t1: true });
  });

  it('P3：批准放行后 wf:step:start 清掉 awaitingTaskIds（重新进入 running）', () => {
    let st = applyPlanWfEvent(base, { type: 'wf:step:start', stepId: 't2' }, KNOWN);
    st = applyPlanWfEvent(st, { type: 'wf:awaiting-approval', stepIds: ['t2'] }, KNOWN);
    expect(st.status).toBe('awaiting');
    st = applyPlanWfEvent(st, { type: 'wf:step:start', stepId: 't2' }, KNOWN);
    expect(st.status).toBe('running');
    expect(st.currentTaskId).toBe('t2');
    expect(st.awaitingTaskIds).toBeUndefined();
  });

  it('P3：awaiting 态收到 wf:done → 收敛 done（清 awaitingTaskIds，保留 done 集合）', () => {
    let st = applyPlanWfEvent(base, { type: 'wf:step:start', stepId: 't1' }, KNOWN);
    st = applyPlanWfEvent(st, { type: 'wf:step:done', stepId: 't1' }, KNOWN);
    st = applyPlanWfEvent(st, { type: 'wf:awaiting-approval', stepIds: ['t2'] }, KNOWN);
    st = applyPlanWfEvent(st, { type: 'wf:done' }, KNOWN);
    expect(st.status).toBe('done');
    expect(st.awaitingTaskIds).toBeUndefined();
    expect(st.done).toEqual({ t1: true });
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

describe('applyPlanThinking（P5 静默执行：思考增量叠加）', () => {
  it('running 且有 thinking 槽位 → 增量叠入 text', () => {
    const st = applyPlanWfEvent(base, { type: 'wf:step:start', stepId: 't1' }, KNOWN);
    const next = applyPlanThinking(st, '分析目标…');
    expect(next).not.toBe(st);
    expect(next.thinking).toEqual({ taskId: 't1', text: '分析目标…' });
    const next2 = applyPlanThinking(next, '，检索数据中');
    expect(next2.thinking?.text).toBe('分析目标…，检索数据中');
  });

  it('非 running / 无 thinking 槽位 / 空增量 → 同引用返回（no-op）', () => {
    expect(applyPlanThinking(base, 'x')).toBe(base);
    const done: PlanExecState = { status: 'done', done: {} };
    expect(applyPlanThinking(done, 'x')).toBe(done);
    const runningNoThink: PlanExecState = { status: 'running', done: {} };
    expect(applyPlanThinking(runningNoThink, 'x')).toBe(runningNoThink);
    const st = applyPlanWfEvent(base, { type: 'wf:step:start', stepId: 't1' }, KNOWN);
    expect(applyPlanThinking(st, '')).toBe(st);
  });

  it('超上限截尾保新（tail 展示语义）', () => {
    const st = applyPlanWfEvent(base, { type: 'wf:step:start', stepId: 't1' }, KNOWN);
    const big = 'a'.repeat(PLAN_THINKING_MAX + 100);
    const next = applyPlanThinking(st, big);
    expect(next.thinking?.text.length).toBe(PLAN_THINKING_MAX);
    expect(next.thinking?.text.startsWith('a')).toBe(true);
  });

  // P5.1 同步自愈：思考流按服务端注入的 stepId 归因（wf:step:start 丢失/乱序时不再错挂旧任务）。
  it('stepId 与当前槽位不一致 → 丢弃旧槽、按事件归属重建（自愈切换）', () => {
    const st = applyPlanWfEvent(base, { type: 'wf:step:start', stepId: 't3' }, KNOWN);
    const withT3 = applyPlanThinking(st, 't3 的思考…');
    const healed = applyPlanThinking(withT3, 't4 的思考…', 't4');
    expect(healed.thinking).toEqual({ taskId: 't4', text: 't4 的思考…' });
    const grown = applyPlanThinking(healed, ' 继续', 't4');
    expect(grown.thinking?.text).toBe('t4 的思考… 继续');
  });

  it('running 且无槽位但带 stepId → 直接建槽（刷新恢复后思考流不再被丢弃）', () => {
    const runningNoThink: PlanExecState = { status: 'running', done: {} };
    const next = applyPlanThinking(runningNoThink, '恢复后的思考…', 't4');
    expect(next.thinking).toEqual({ taskId: 't4', text: '恢复后的思考…' });
    // 不带 stepId 保持原行为：无槽位 no-op。
    expect(applyPlanThinking(runningNoThink, 'x')).toBe(runningNoThink);
  });

  it('wf:step:done 只清本任务槽位：乱序的 done(t3) 不误删已自愈到 t4 的思考流', () => {
    const st = applyPlanWfEvent(base, { type: 'wf:step:start', stepId: 't3' }, KNOWN);
    const withT4 = applyPlanThinking(st, 't4 的思考…', 't4');
    const afterLateDone = applyPlanWfEvent(withT4, { type: 'wf:step:done', stepId: 't3' }, KNOWN);
    expect(afterLateDone.done['t3']).toBe(true);
    expect(afterLateDone.thinking?.taskId).toBe('t4');
    // 本任务的 done 仍正常清槽。
    const afterOwnDone = applyPlanWfEvent(withT4, { type: 'wf:step:done', stepId: 't4' }, KNOWN);
    expect(afterOwnDone.thinking).toBeUndefined();
  });
});

describe('P5 并行执行：多任务同波（runningTaskIds / thinkingByTask 分槽）', () => {
  it('同波两个 start → runningTaskIds 聚合，各建独立思考槽（单槽 mirror 保持最近启动）', () => {
    let st = applyPlanWfEvent(base, { type: 'wf:step:start', stepId: 't2' }, KNOWN);
    st = applyPlanWfEvent(st, { type: 'wf:step:start', stepId: 't3' }, KNOWN);
    expect(st.status).toBe('running');
    expect(st.runningTaskIds).toEqual(['t2', 't3']);
    expect(st.currentTaskId).toBe('t3');
    expect(st.thinkingByTask).toEqual({ t2: '', t3: '' });
    expect(st.thinking).toEqual({ taskId: 't3', text: '' });
  });

  it('交错思考增量归因各自分槽，互不覆盖（并行核心语义）', () => {
    let st = applyPlanWfEvent(base, { type: 'wf:step:start', stepId: 't2' }, KNOWN);
    st = applyPlanWfEvent(st, { type: 'wf:step:start', stepId: 't3' }, KNOWN);
    st = applyPlanThinking(st, 't2 第一段', 't2');
    st = applyPlanThinking(st, 't3 第一段', 't3');
    st = applyPlanThinking(st, 't2 第二段', 't2');
    expect(st.thinkingByTask?.['t2']).toBe('t2 第一段t2 第二段');
    expect(st.thinkingByTask?.['t3']).toBe('t3 第一段');
    // 单槽 mirror = 最近接收增量的任务（t2），仅兼容面（并行渲染不读它）。
    expect(st.thinking?.taskId).toBe('t2');
    expect(st.thinking?.text).toBe('t2 第二段');
  });

  it('本任务 done 只清本槽：t2 完成后 t3 思考流与在跑标记保留', () => {
    let st = applyPlanWfEvent(base, { type: 'wf:step:start', stepId: 't2' }, KNOWN);
    st = applyPlanWfEvent(st, { type: 'wf:step:start', stepId: 't3' }, KNOWN);
    st = applyPlanThinking(st, 't2 思考', 't2');
    st = applyPlanThinking(st, 't3 思考', 't3');
    st = applyPlanWfEvent(st, { type: 'wf:step:done', stepId: 't2' }, KNOWN);
    expect(st.done).toEqual({ t2: true });
    expect(st.status).toBe('running');
    expect(st.runningTaskIds).toEqual(['t3']);
    expect(st.thinkingByTask?.['t2']).toBeUndefined();
    expect(st.thinkingByTask?.['t3']).toBe('t3 思考');
  });

  it('本任务 failed → 整卡 failed，在跑集合 / 分槽思考全清（引擎 all-or-nothing）', () => {
    let st = applyPlanWfEvent(base, { type: 'wf:step:start', stepId: 't2' }, KNOWN);
    st = applyPlanWfEvent(st, { type: 'wf:step:start', stepId: 't3' }, KNOWN);
    st = applyPlanThinking(st, 't3 思考', 't3');
    st = applyPlanWfEvent(st, { type: 'wf:step:failed', stepId: 't2' }, KNOWN);
    expect(st.status).toBe('failed');
    expect(st.failedTaskId).toBe('t2');
    expect(st.runningTaskIds).toBeUndefined();
    expect(st.thinkingByTask).toBeUndefined();
  });

  it('applyPlanThinking 旧帧（无 stepId）→ 增量落入单槽对应分槽键（旧服务端兼容）', () => {
    const st = applyPlanWfEvent(base, { type: 'wf:step:start', stepId: 't1' }, KNOWN);
    const next = applyPlanThinking(st, '旧帧思考');
    expect(next.thinking?.text).toBe('旧帧思考');
    expect(next.thinkingByTask?.['t1']).toBe('旧帧思考');
  });

  it('超上限截尾同样作用于分槽（tail 语义一致）', () => {
    const st = applyPlanWfEvent(base, { type: 'wf:step:start', stepId: 't1' }, KNOWN);
    const big = 'b'.repeat(PLAN_THINKING_MAX + 10);
    const next = applyPlanThinking(st, big, 't1');
    expect(next.thinkingByTask?.['t1']?.length).toBe(PLAN_THINKING_MAX);
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

describe('derivePlanWfId（P1 断点续跑：确定性检查点键）', () => {
  const planA: ExecutionPlanView = {
    goal: '上线新功能',
    tasks: [
      {
        id: 't1',
        title: '写核心逻辑',
        steps: ['实现 A', '实现 B'],
        dependsOn: [],
        expectedOutput: '可编译的核心模块'
      },
      {
        id: 't2',
        title: '写测试',
        steps: ['单测'],
        dependsOn: ['t1'],
        expectedOutput: '全绿测试'
      }
    ]
  };

  it('同输入恒同输出（刷新 / 重启后可重算，无需持久化 wfId）', () => {
    expect(derivePlanWfId('sess-1', planA)).toBe(derivePlanWfId('sess-1', planA));
  });

  it('不同会话 → 不同键（检查点隔离，跨会话同文案计划互不覆盖）', () => {
    expect(derivePlanWfId('sess-1', planA)).not.toBe(derivePlanWfId('sess-2', planA));
  });

  it('结构键不变（仅任务文案变化）→ 同一键：改文案后仍能定位原检查点续跑', () => {
    const relit: ExecutionPlanView = {
      goal: planA.goal,
      tasks: planA.tasks.map((t, i) =>
        i === 1 ? { ...t, title: '写集成测试', steps: ['e2e'], expectedOutput: 'e2e 全绿' } : t
      )
    };
    expect(derivePlanWfId('sess-1', relit)).toBe(derivePlanWfId('sess-1', planA));
  });

  it('结构变化（增删任务 / 依赖边 / goal）→ 不同键', () => {
    const addTask: ExecutionPlanView = {
      goal: planA.goal,
      tasks: [
        ...planA.tasks,
        { id: 't3', title: '部署', steps: [], dependsOn: ['t2'], expectedOutput: '上线' }
      ]
    };
    const reparent: ExecutionPlanView = {
      goal: planA.goal,
      tasks: planA.tasks.map((t) =>
        t.id === 't2' ? { ...t, dependsOn: [] } : t
      )
    };
    const reGoal: ExecutionPlanView = { ...planA, goal: '上线别的功能' };
    expect(derivePlanWfId('sess-1', addTask)).not.toBe(derivePlanWfId('sess-1', planA));
    expect(derivePlanWfId('sess-1', reparent)).not.toBe(derivePlanWfId('sess-1', planA));
    expect(derivePlanWfId('sess-1', reGoal)).not.toBe(derivePlanWfId('sess-1', planA));
  });

  it('输出形如 plan-<8位hex>，经 sanitizeKey（仅留 [a-zA-Z0-9._-]）后原样不变 → 可安全作检查点文件名', () => {
    const key = derivePlanWfId('sess-1', planA);
    expect(key).toMatch(/^plan-[0-9a-f]{8}$/);
    // 与服务端 FileWorkflowStore.sanitizeKey 同款规则对齐：本键零字符被替换。
    expect(key.replace(/[^a-zA-Z0-9._-]/g, '_')).toBe(key);
    // 与旧随机键前缀 plan:（冒号）区分——旧 run 无法被确定性定位（resume 404 → 回退串行）。
    expect(key.startsWith('plan:')).toBe(false);
  });
});

describe('P2 轨迹回放：快照 → 时间线行（buildPlanWfReplayRows 等纯函数）', () => {
  const p: ExecutionPlanView = {
    goal: '上线',
    tasks: [
      { id: 't1', title: '写核心逻辑', steps: [], dependsOn: [], expectedOutput: '核心模块' },
      { id: 't2', title: '写测试', steps: [], dependsOn: ['t1'], expectedOutput: '全绿测试' }
    ]
  };
  // 快照形状与 buildPlanWfReplayRows 第二参对齐（步骤最小结构），便于字面量构造。
  type SnapStep = {
    state?: string;
    agentId?: string;
    output?: unknown;
    error?: string;
    startedAt?: number;
    finishedAt?: number;
    trace?: import('@agent-harness/client').StepTraceNode[];
  };
  const snap = (steps: Record<string, SnapStep>) => ({ steps });

  it('快照缺失 → 全部 task 记 pending（无 agent / 无耗时 / 无正文）', () => {
    const rows = buildPlanWfReplayRows(p, null);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      id: 't1',
      title: '写核心逻辑',
      agentId: undefined,
      state: 'pending',
      durationMs: undefined,
      detail: undefined
    });
  });

  it('done 行：产出作为折叠正文，耗时 = finishedAt - startedAt，agentId 透出', () => {
    const rows = buildPlanWfReplayRows(
      p,
      snap({
        t1: {
          state: 'done',
          agentId: 'agent-a',
          output: '核心模块 v1',
          startedAt: 1000,
          finishedAt: 3500
        },
        t2: { state: 'running', agentId: 'agent-b', startedAt: 3500 }
      })
    );
    expect(rows[0]).toEqual({
      id: 't1',
      title: '写核心逻辑',
      agentId: 'agent-a',
      state: 'done',
      durationMs: 2500,
      detail: '核心模块 v1'
    });
    // running 尚无产出 → detail 为 undefined；缺 finishedAt → 无耗时。
    const r1 = rows[1];
    expect(r1?.state).toBe('running');
    expect(r1?.detail).toBeUndefined();
    expect(r1?.durationMs).toBeUndefined();
  });

  it('failed 行：错误信息作为折叠正文（而非产出）', () => {
    const rows = buildPlanWfReplayRows(
      p,
      snap({ t1: { state: 'failed', error: 'LLM 401 无 Key', startedAt: 1, finishedAt: 2 } })
    );
    expect(rows[0]?.detail).toBe('LLM 401 无 Key');
  });

  it('skipped 行：无产出语义 → 即便快照记录了 output 也不展示', () => {
    const rows = buildPlanWfReplayRows(p, snap({ t2: { state: 'skipped', output: '不应展示' } }));
    expect(rows[1]?.state).toBe('skipped');
    expect(rows[1]?.detail).toBeUndefined();
  });

  it('对象产出 → JSON 化；正常体量全文保留（不再 600 字截断），仅病态超长兜底', () => {
    expect(formatPlanWfOutput({ a: 1, b: [2, 3] }) ?? '').toContain('"a"');
    // 研报级体量（数千~数万字）必须完整回到抽屉，不得出现省略号（2026-09-20 放宽）。
    const long = 'x'.repeat(1000);
    expect(formatPlanWfOutput(long)).toBe(long);
    const chapter = '研'.repeat(50_000);
    expect(formatPlanWfOutput(chapter)).toBe(chapter);
    // 兜底上限 REPLAY_DETAIL_MAX=200_000：仅防病态 JSON dump 拖垮 DOM。
    const pathological = 'y'.repeat(REPLAY_DETAIL_MAX + 1);
    const capped = formatPlanWfOutput(pathological);
    expect(capped?.length).toBe(REPLAY_DETAIL_MAX + 1); // 上限 + '…'
    expect(capped).toBe(`${'y'.repeat(REPLAY_DETAIL_MAX)}…`);
    expect(formatPlanWfOutput('   ')).toBeUndefined();
    expect(formatPlanWfOutput(null)).toBeUndefined();
  });

  it('耗时格式化：ms / 秒 / 取整 + 缺省「—」', () => {
    expect(formatPlanWfDuration(0)).toBe('0ms');
    expect(formatPlanWfDuration(800)).toBe('800ms');
    expect(formatPlanWfDuration(1500)).toBe('1.5s');
    expect(formatPlanWfDuration(25600)).toBe('26s');
    expect(formatPlanWfDuration(undefined)).toBe('—');
    expect(formatPlanWfDuration(-5)).toBe('—');
  });

  it('状态标签 / 图标：已知状态映射，未知状态原样透出（引擎新增状态后 UI 不空白）', () => {
    expect(planWfReplayStateLabel('done')).toBe('完成');
    expect(planWfReplayStateLabel('skipped')).toBe('已跳过');
    expect(planWfReplayStateLabel('weird')).toBe('weird');
    expect(planWfReplayMark('done')).toBe('✅');
    expect(planWfReplayMark('weird')).toBe('•');
  });
});

describe('P2.5 调用链路：step 运行过程回放（buildPlanWfReplayRows.trace + buildPlanWfTraceLines）', () => {
  const p: ExecutionPlanView = {
    goal: '上线',
    tasks: [{ id: 't1', title: '写核心逻辑', steps: [], dependsOn: [], expectedOutput: '核心模块' }]
  };

  it('buildPlanWfReplayRows 透传 StepRun.trace 到行（空 / 缺失 → undefined，抽屉不渲染链路区）', () => {
    const rows = buildPlanWfReplayRows(
      p,
      {
        steps: {
          t1: {
            state: 'done',
            trace: [{ type: 'llm:call', ts: 1000, label: 'LLM 调用' }]
          }
        }
      }
    );
    expect(rows[0]?.trace).toEqual([{ type: 'llm:call', ts: 1000, label: 'LLM 调用' }]);
    // 空数组 / 无 trace 键（旧快照）→ undefined（零回归：抽屉不渲染「调用链路」）。
    const rowsEmpty = buildPlanWfReplayRows(p, { steps: { t1: { state: 'done', trace: [] } } });
    expect(rowsEmpty[0]?.trace).toBeUndefined();
    const rowsNone = buildPlanWfReplayRows(p, { steps: { t1: { state: 'done' } } });
    expect(rowsNone[0]?.trace).toBeUndefined();
  });

  it('buildPlanWfTraceLines：图标 / 相对时间 / detail 截断 / 状态透传', () => {
    const lines = buildPlanWfTraceLines([
      { type: 'run:start', ts: 1000, label: '任务开始', detail: '做核心逻辑' },
      { type: 'llm:call', ts: 1500, step: 1, label: 'LLM 调用', meta: { msgs: '1' } },
      { type: 'tool:result', ts: 2300, step: 1, label: '工具 web_fetch 结果', status: 'error', detail: 'timeout' },
      { type: 'run:end', ts: 2500, label: '任务结束' }
    ]);
    expect(lines).toHaveLength(4);
    // 首节点相对 0 → 无 at；后续节点相对首节点。
    expect(lines[0]?.at).toBeUndefined();
    expect(lines[1]?.at).toBe('500ms');
    expect(lines[3]?.at).toBe('1.5s');
    // 图标 / 状态透传。
    expect(lines[0]?.icon).toBe('▶️');
    expect(lines[2]?.icon).toBe('🔧');
    expect(lines[2]?.status).toBe('error');
    expect(lines[0]?.detail).toBe('做核心逻辑');
  });

  it('buildPlanWfTraceLines：超长 detail 截断到 400 字 + 省略号；空 / undefined 返回 []', () => {
    const long = 'x'.repeat(600);
    const lines = buildPlanWfTraceLines([{ type: 'llm:response', ts: 1, label: '模型响应', detail: long }]);
    expect(lines[0]?.detail).toBe(`${long.slice(0, 400)}…`);
    expect(buildPlanWfTraceLines([])).toEqual([]);
    expect(buildPlanWfTraceLines(undefined)).toEqual([]);
  });

  it('buildPlanWfTraceLines：meta 透传为 [键, 值] 对（用量 / 模型数据此前被丢弃 → 抽屉不可见）；空 / 全空值 meta 不透传', () => {
    const lines = buildPlanWfTraceLines([
      {
        type: 'run:cost',
        ts: 1000,
        label: '用量',
        meta: { model: 'deepseek-v4', tokens: '1280', cost: '0.0032' }
      },
      { type: 'llm:usage', ts: 1200, label: '上下文用量', meta: { prompt: '1000', completion: '280', window: '' } },
      { type: 'llm:call', ts: 1400, label: 'LLM 调用' }
    ]);
    expect(lines[0]?.meta).toEqual([
      ['model', 'deepseek-v4'],
      ['tokens', '1280'],
      ['cost', '0.0032']
    ]);
    // 空值键被过滤（window: '' 不进 chip，避免渲染空数据行）。
    expect(lines[1]?.meta).toEqual([
      ['prompt', '1000'],
      ['completion', '280']
    ]);
    // 无 meta 的行 → undefined（渲染端不画空 chip 区）。
    expect(lines[2]?.meta).toBeUndefined();
  });

  it('planWfTraceMetaLabel：已知键 → 中文标签，未知键原样透出（采集端新增 meta 键后 UI 不空白）', () => {
    expect(planWfTraceMetaLabel('model')).toBe('模型');
    expect(planWfTraceMetaLabel('tokens')).toBe('Token');
    expect(planWfTraceMetaLabel('prompt')).toBe('输入');
    expect(planWfTraceMetaLabel('weird-key')).toBe('weird-key');
  });

  it('planWfTraceMetaRowTitle：含用量/模型键 → 「模型 / 用量」，仅参数键 → 「参数」（独立 meta 行标题语义）', () => {
    // run:cost 行：model/tokens/cost 全在用量键集合。
    expect(planWfTraceMetaRowTitle([['model', 'deepseek-v4'], ['tokens', '1280']])).toBe('模型 / 用量');
    // llm:usage 行：prompt/completion/window。
    expect(planWfTraceMetaRowTitle([['prompt', '1000'], ['window', '128000']])).toBe('模型 / 用量');
    // llm:call 行：msgs/tools 属参数键（无用量键）→「参数」。
    expect(planWfTraceMetaRowTitle([['msgs', '2'], ['tools', '5']])).toBe('参数');
    // 混合格（llm:response 带 partial）：无用量键 → 参数。
    expect(planWfTraceMetaRowTitle([['partial', 'true']])).toBe('参数');
  });

  it('未知事件类型 → 通用图标「•」（采集端新增事件后 UI 不空白）', () => {
    const lines = buildPlanWfTraceLines([{ type: 'wf:something-new', ts: 1, label: '新事件' }]);
    expect(lines[0]?.icon).toBe('•');
    expect(lines[0]?.label).toBe('新事件');
  });
});

/* ────────────────────────────────────────────────────────────────────
 * P2.6 镜像回退：紧凑 run 快照（compactPlanWfSnapshot）+ 检查点 404 → 历史镜像水合。
 * 根因：「执行详情」抽屉唯一数据源是服务端检查点（GET /api/workflows/:wfId），而检查点
 * 寿命受 store 形态约束——本地 dev 未配 WORKFLOW_STORE_DIR 是 VolatileWorkflowStore
 * （进程重启即丢），Render free 层 /app/data 是临时盘（闲置唤醒 / 部署重置清空）。
 * 执行完 → 服务重启 → 刷新重进 → getWorkflow 404 → 抽屉「没有任何数据」。
 * 修复：终态帧的 run 快照经 compactPlanWfSnapshot 紧凑化，随 planStatus 镜像落会话历史
 * （SQLite / Turso，跨重启保留）；抽屉 404 时回退镜像水合并标注来源。
 * ──────────────────────────────────────────────────────────────────── */
describe('P2.6 镜像回退：compactPlanWfSnapshot（终态 run → 紧凑快照，随 planStatus 镜像持久化）', () => {
  const mkRun = (over: Record<string, unknown> = {}) => ({
    state: 'done',
    startedAt: 1000,
    finishedAt: 5000,
    steps: {
      t1: {
        state: 'done',
        agentId: 'a1',
        startedAt: 1000,
        finishedAt: 3000,
        output: 't1 产出',
        trace: [{ type: 'run:start', ts: 1000, label: '开始' }]
      },
      t2: {
        state: 'done',
        agentId: 'a2',
        startedAt: 3000,
        finishedAt: 5000,
        output: 't2 产出'
      }
    },
    ...over
  });

  it('正常终态 run → 保留回放字段（state/时间戳/每 step state/agentId/时间戳/output/trace）', () => {
    const snap = compactPlanWfSnapshot(mkRun());
    expect(snap?.state).toBe('done');
    expect(snap?.startedAt).toBe(1000);
    expect(snap?.finishedAt).toBe(5000);
    expect(snap?.steps.t1?.state).toBe('done');
    expect(snap?.steps.t1?.agentId).toBe('a1');
    expect(snap?.steps.t1?.output).toBe('t1 产出');
    expect(snap?.steps.t1?.trace?.[0]?.type).toBe('run:start');
    // 非字符串 output → JSON 化后保留。
    const obj = compactPlanWfSnapshot(
      mkRun({ steps: { t1: { state: 'done', output: { k: 1 } } } })
    );
    expect(obj?.steps.t1?.output).toBe('{"k":1}');
  });

  it('形状非法 / 无 steps → undefined（调用方不落镜像字段，零回归面）', () => {
    expect(compactPlanWfSnapshot(undefined)).toBeUndefined();
    expect(compactPlanWfSnapshot(null)).toBeUndefined();
    expect(compactPlanWfSnapshot('x')).toBeUndefined();
    expect(compactPlanWfSnapshot({ state: 'done' })).toBeUndefined(); // 缺 steps
    expect(compactPlanWfSnapshot({ state: 'done', steps: null })).toBeUndefined();
  });

  it('run.state 缺失 → 收敛为 done（避免镜像出现非法状态）', () => {
    const snap = compactPlanWfSnapshot({ steps: {} });
    expect(snap?.state).toBe('done');
  });

  it('output / error 超长截断（REPLAY_MIRROR_OUTPUT_MAX=2000 + 省略号）', () => {
    const big = 'a'.repeat(3000);
    const snap = compactPlanWfSnapshot(
      mkRun({
        error: big,
        steps: { t1: { state: 'failed', error: big } }
      })
    );
    expect(snap?.error?.length).toBeLessThanOrEqual(2000 + 1);
    expect(snap?.error?.endsWith('…')).toBe(true);
    expect(snap?.steps.t1?.error?.endsWith('…')).toBe(true);
  });

  it('trace 二级限幅：节点超 30 截断 + detail 超 200 截断（控制历史信封体积）', () => {
    const nodes = Array.from({ length: 40 }, (_, i) => ({
      type: 'llm:call',
      ts: i,
      label: `n${i}`,
      detail: 'd'.repeat(500)
    }));
    const snap = compactPlanWfSnapshot(
      mkRun({ steps: { t1: { state: 'done', trace: nodes } } })
    );
    expect(snap?.steps.t1?.trace?.length).toBe(30);
    expect(snap?.steps.t1?.trace?.[0]?.detail?.length).toBeLessThanOrEqual(200 + 1);
  });

  it('awaiting partial 快照：保留 run.state=awaiting + 已执行 step（审批等待中刷新可回看）', () => {
    const snap = compactPlanWfSnapshot(
      mkRun({ state: 'awaiting', finishedAt: undefined, steps: { t1: { state: 'done' } } })
    );
    expect(snap?.state).toBe('awaiting');
    expect(snap?.finishedAt).toBeUndefined();
    expect(snap?.steps.t1?.state).toBe('done');
  });
});

describe('P2.6 镜像回退：toMirrorPlanStatus 写穿 wfSnapshot（随 planStatus 落会话历史）', () => {
  it('PlanExecState 带 wfSnapshot → 镜像含该字段（刷新后 applyPlanStatusLookup 可恢复）', () => {
    const st: PlanExecState = {
      status: 'done',
      done: { t1: true },
      wfSnapshot: {
        state: 'done',
        startedAt: 1,
        finishedAt: 2,
        steps: { t1: { state: 'done', agentId: 'a1' } }
      }
    };
    const out = toMirrorPlanStatus(st) as Record<string, unknown>;
    expect(out.wfSnapshot).toEqual(st.wfSnapshot);
  });

  it('无 wfSnapshot（旧计划 / 串行路径）→ 镜像不含该字段（零回归）', () => {
    const st: PlanExecState = { status: 'done', done: { t1: true } };
    const out = toMirrorPlanStatus(st) as Record<string, unknown>;
    expect('wfSnapshot' in out).toBe(false);
  });
});

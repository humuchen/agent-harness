/**
 * 计划卡片状态恢复单测（计划进度「显示错位」回归防护）。
 *
 * 背景：计划已全部执行成功，卡片却仍显示「待确认」并暴露「确认执行 / 取消」按钮。
 * 根因有二，本文件分别锁定：
 * 1. 进度镜像缺失时（旧数据未带 planStatus / 镜像被整包覆盖 / 服务端重启回落），
 *    卡片退回默认 pending —— 由 derivePlanExecFromMessages 从线程反推修正；
 * 2. 前端是「计划整体完成」的唯一知情方，必须把状态写穿到落盘消息上 ——
 *    由 stampPlanStatus / toMirrorPlanStatus 保证。
 */
import { describe, it, expect } from 'vitest';
import {
  derivePlanExecFromMessages,
  PLAN_TASK_DISPATCH_RE,
  filterPlanSingleStep,
  recoverPlanFinalResult,
  buildPlanStatusLookup,
  mergePlanStatusLookup,
  planStatusProgressRank,
  type PlanDeriveMsg
} from './chat-render-utils';
import { stampPlanStatus, toMirrorPlanStatus } from './chat-persist';
import type { ChatMsg, ExecutionPlanView, PlanExecState } from './chat-types';

const plan: ExecutionPlanView = {
  goal: '分析报告',
  tasks: [
    { id: 't1', title: '文本', steps: [], dependsOn: [], expectedOutput: 'x' },
    { id: 't2', title: '插画', steps: [], dependsOn: [], expectedOutput: 'x' },
    { id: 't3', title: '配色', steps: [], dependsOn: [], expectedOutput: 'x' }
  ]
};

/** 构造「派发任务 → 任务产出」的消息对（与 confirmPlan 落库形状一致）。 */
function dispatched(id: string, answer: string | null, errored = false): PlanDeriveMsg[] {
  const msgs: PlanDeriveMsg[] = [
    { role: 'user', content: `【计划任务 ${id}】任务 ${id}` }
  ];
  if (answer !== null) {
    msgs.push({ role: 'assistant', content: answer, ...(errored ? { error: true } : {}) });
  }
  return msgs;
}

describe('derivePlanExecFromMessages（镜像缺失时从线程反推）', () => {
  it('无任何派发痕迹 → null（信息不足，保持待确认）', () => {
    const msgs: PlanDeriveMsg[] = [
      { role: 'user', content: '帮我分析这张图' },
      { role: 'assistant', content: '已生成执行计划…' }
    ];
    expect(derivePlanExecFromMessages(plan, msgs)).toBeNull();
  });

  it('计划无任务 → null（防御非法计划实体）', () => {
    expect(derivePlanExecFromMessages({ tasks: [] }, dispatched('t1', 'ok'))).toBeNull();
    expect(derivePlanExecFromMessages(undefined, dispatched('t1', 'ok'))).toBeNull();
  });

  it('全部任务均有非空产出 → done（报告的核心回归场景）', () => {
    const msgs = [
      ...dispatched('t1', '任务一完成'),
      ...dispatched('t2', '任务二完成'),
      ...dispatched('t3', '任务三完成')
    ];
    const st = derivePlanExecFromMessages(plan, msgs);
    expect(st?.status).toBe('done');
    expect(Object.keys(st?.done ?? {}).sort()).toEqual(['t1', 't2', 't3']);
    expect(st?.currentTaskId).toBeUndefined();
    expect(st?.failedTaskId).toBeUndefined();
  });

  it('部分完成 → failed，失败节点 = 首个未完成任务，已完成集合保留', () => {
    const msgs = [
      ...dispatched('t1', '任务一完成'),
      ...dispatched('t2', '任务二完成'),
      ...dispatched('t3', null) // 派发了但无产出（中断）
    ];
    const st = derivePlanExecFromMessages(plan, msgs);
    expect(st?.status).toBe('failed');
    expect(st?.failedTaskId).toBe('t3');
    expect(st?.done).toEqual({ t1: true, t2: true });
  });

  it('任务产出为错误态 → 不计入已完成', () => {
    const msgs = [...dispatched('t1', '出错了', true), ...dispatched('t2', '任务二完成')];
    const st = derivePlanExecFromMessages(plan, msgs);
    expect(st?.status).toBe('failed');
    expect(st?.failedTaskId).toBe('t1');
    expect(st?.done).toEqual({ t2: true });
  });

  it('产出为空白的 assistant 消息不算完成', () => {
    const msgs = [...dispatched('t1', '   '), ...dispatched('t2', 'ok')];
    const st = derivePlanExecFromMessages(plan, msgs);
    expect(st?.status).toBe('failed');
    expect(st?.failedTaskId).toBe('t1');
  });

  it('忽略非本计划的同形消息（用户手输 / 其它计划）', () => {
    const msgs: PlanDeriveMsg[] = [
      { role: 'user', content: '【计划任务 t99】我没干过的任务' },
      { role: 'assistant', content: '不相关回答' }
    ];
    expect(derivePlanExecFromMessages(plan, msgs)).toBeNull();
  });

  it('任务 id 非 tN 命名同样可识别（planner 实际常产出 1 / task-1）', () => {
    const p: ExecutionPlanView = {
      goal: 'g',
      tasks: [
        { id: '1', title: 'a', steps: [], dependsOn: [], expectedOutput: '' },
        { id: 'task-2', title: 'b', steps: [], dependsOn: [], expectedOutput: '' }
      ]
    };
    const st = derivePlanExecFromMessages(p, [
      ...dispatched('1', '产出 a'),
      ...dispatched('task-2', '产出 b')
    ]);
    expect(st?.status).toBe('done');
    expect(Object.keys(st?.done ?? {}).sort()).toEqual(['1', 'task-2']);
  });

  it('派发文本前缀契约：与 confirmPlan 的派发格式一致', () => {
    expect(PLAN_TASK_DISPATCH_RE.test('【计划任务 t1】提取文本')).toBe(true);
    expect(PLAN_TASK_DISPATCH_RE.test('【计划任务 t 12】提取文本')).toBe(true);
    expect(PLAN_TASK_DISPATCH_RE.test('【计划任务 task-1】提取文本')).toBe(true);
    expect(PLAN_TASK_DISPATCH_RE.test('普通用户消息')).toBe(false);
  });
});

describe('filterPlanSingleStep（刷新恢复：丢弃单步任务消息对）', () => {
  const planCard: ChatMsg = {
    id: 2,
    role: 'assistant',
    content: '📋 分析报告',
    plan
  };

  it('保留用户需求、计划卡片，丢弃每个「派发提示 + 任务产出」对', () => {
    const msgs: ChatMsg[] = [
      { id: 1, role: 'user', content: '帮我做分析报告' },
      planCard,
      { id: 3, role: 'user', content: '【计划任务 t1】文本' },
      { id: 4, role: 'assistant', content: 't1 的产出' },
      { id: 5, role: 'user', content: '【计划任务 t2】插画' },
      { id: 6, role: 'assistant', content: 't2 的产出' }
    ];
    const out = filterPlanSingleStep(msgs);
    expect(out.map((m) => m.id)).toEqual([1, 2]);
  });

  it('任务派发后无产出（中断）也只丢弃派发提示', () => {
    const msgs: ChatMsg[] = [
      { id: 1, role: 'user', content: 'hi' },
      planCard,
      { id: 3, role: 'user', content: '【计划任务 t1】文本' }
    ];
    expect(filterPlanSingleStep(msgs).map((m) => m.id)).toEqual([1, 2]);
  });

  it('非计划单步的普通 assistant 消息不被误删（相邻无派发提示）', () => {
    const msgs: ChatMsg[] = [
      { id: 1, role: 'user', content: 'hi' },
      { id: 2, role: 'assistant', content: '普通回答' }
    ];
    expect(filterPlanSingleStep(msgs).map((m) => m.id)).toEqual([1, 2]);
  });
});

describe('recoverPlanFinalResult（刷新恢复：兜底回收最终结果）', () => {
  const planCard: ChatMsg = {
    id: 2,
    role: 'assistant',
    content: '📋 分析报告',
    plan
  };

  it('base 已含摘要 → 原样返回', () => {
    const base: ChatMsg[] = [
      { id: 1, role: 'user', content: 'hi' },
      planCard,
      { id: 9, role: 'assistant', content: '📋 计划执行摘要：…' }
    ];
    const out = recoverPlanFinalResult(base, []);
    expect(out).toBe(base);
  });

  it('base 无摘要 → 从 clean 回收最后一条任务产出作为最终结果', () => {
    const base: ChatMsg[] = [
      { id: 1, role: 'user', content: 'hi' },
      planCard
    ];
    const clean: ChatMsg[] = [
      { id: 1, role: 'user', content: 'hi' },
      planCard,
      { id: 3, role: 'user', content: '【计划任务 t1】文本' },
      { id: 4, role: 'assistant', content: 't1 产出' },
      { id: 5, role: 'user', content: '【计划任务 t2】插画' },
      { id: 6, role: 'assistant', content: 't2 产出（最终）' }
    ];
    const out = recoverPlanFinalResult(base, clean);
    expect(out.length).toBe(3);
    const last = out[2]!;
    expect(last.role).toBe('assistant');
    expect(last.content).toContain('t2 产出（最终）');
  });

  it('clean 中无任务产出 → 原样返回（不追加空结果）', () => {
    const base: ChatMsg[] = [
      { id: 1, role: 'user', content: 'hi' },
      planCard
    ];
    const out = recoverPlanFinalResult(base, base);
    expect(out).toBe(base);
  });
});

describe('计划进度写穿落盘（前端是「整体完成」的唯一知情方）', () => {
  const planMsg: ChatMsg = { id: 7, role: 'assistant', content: '已生成执行计划…', plan };

  it('pending → 丢弃 planStatus 字段（镜像契约无 pending，避免误写成执行中）', () => {
    expect(toMirrorPlanStatus({ status: 'pending', done: {} })).toBeNull();
    const out = stampPlanStatus([planMsg], {
      7: { status: 'pending', done: {} }
    }) as Array<Record<string, unknown>>;
    expect('planStatus' in out[0]!).toBe(false);
  });

  it('done → 写穿成镜像形态（done 由 map 转数组）', () => {
    const st: PlanExecState = { status: 'done', done: { t1: true, t2: true } };
    expect(toMirrorPlanStatus(st)).toEqual({ status: 'done', done: ['t1', 't2'] });

    const out = stampPlanStatus([planMsg], { 7: st }) as Array<
      Record<string, unknown>
    >;
    expect(out[0]!.planStatus).toEqual({ status: 'done', done: ['t1', 't2'] });
  });

  it('failed → 保留失败节点，供「从失败任务继续」', () => {
    const st: PlanExecState = {
      status: 'failed',
      failedTaskId: 't3',
      done: { t1: true }
    };
    expect(toMirrorPlanStatus(st)).toEqual({
      status: 'failed',
      failedTaskId: 't3',
      done: ['t1']
    });
  });

  it('done 映射只保留为 true 的任务（防御 false/脏值）', () => {
    const st = {
      status: 'running',
      currentTaskId: 't2',
      done: { t1: true, t2: false }
    } as unknown as PlanExecState;
    expect(toMirrorPlanStatus(st)).toEqual({
      status: 'running',
      currentTaskId: 't2',
      done: ['t1']
    });
  });

  it('不携带计划的消息 / 无状态的计划消息 / 未传 planExec 一律原样返回', () => {
    const plain: ChatMsg = { id: 1, role: 'user', content: 'hi' };
    const noState: ChatMsg = { id: 8, role: 'assistant', content: 'x', plan };
    const planExec = { 7: { status: 'done', done: { t1: true } } as PlanExecState };

    const out = stampPlanStatus([plain, planMsg, noState], planExec) as Array<
      Record<string, unknown>
    >;
    expect(out[0]).toBe(plain);
    expect(out[2]).toBe(noState);
    expect(out[1]!.planStatus).toEqual({ status: 'done', done: ['t1'] });

    const untouched = stampPlanStatus([planMsg]) as unknown[];
    expect(untouched[0]).toBe(planMsg);
  });

  it('不修改入参消息（写穿是纯函数，避免污染运行时线程）', () => {
    const before = JSON.stringify(planMsg);
    stampPlanStatus([planMsg], { 7: { status: 'done', done: { t1: true } } });
    expect(JSON.stringify(planMsg)).toBe(before);
  });
});

describe('P2.7 对账合并（mergePlanStatusLookup：服务端权威 vs 本地镜像）', () => {
  it('进度等级排序：done > cancelled > failed > awaiting > running > 缺失', () => {
    expect(planStatusProgressRank({ status: 'done' })).toBe(5);
    expect(planStatusProgressRank({ status: 'cancelled' })).toBe(4);
    expect(planStatusProgressRank({ status: 'failed' })).toBe(3);
    expect(planStatusProgressRank({ status: 'awaiting' })).toBe(2);
    expect(planStatusProgressRank({ status: 'running' })).toBe(1);
    expect(planStatusProgressRank(undefined)).toBe(0);
    expect(planStatusProgressRank(null)).toBe(0);
  });

  it('权威缺失该 goal → 镜像值直接补上（服务端丢 planStatus 时唯一来源）', () => {
    const mirrored = buildPlanStatusLookup([
      { plan, planStatus: { status: 'failed', failedTaskId: 't6', done: ['t1'] } }
    ]);
    const merged = mergePlanStatusLookup(new Map(), mirrored);
    expect(merged.get(plan.goal)).toEqual({
      status: 'failed',
      failedTaskId: 't6',
      done: ['t1']
    });
  });

  it('镜像等级严格更高 → 采用镜像（权威落后于本地时兜底）', () => {
    const authoritative = buildPlanStatusLookup([
      { plan, planStatus: { status: 'running', done: [] } }
    ]);
    const mirrored = buildPlanStatusLookup([
      { plan, planStatus: { status: 'done', done: ['t1', 't2', 't3'] } }
    ]);
    const merged = mergePlanStatusLookup(authoritative, mirrored);
    expect(merged.get(plan.goal)!.status).toBe('done');
    expect(merged.get(plan.goal)!.done).toEqual(['t1', 't2', 't3']);
  });

  it('同级或镜像更低 → 保留权威（不回退新权威）；wfSnapshot 只进不出', () => {
    const authoritative = buildPlanStatusLookup([
      { plan, planStatus: { status: 'failed', failedTaskId: 't2', done: ['t1'] } }
    ]);
    const mirrored = buildPlanStatusLookup([
      { plan, planStatus: { status: 'running', done: [] } }
    ]);
    const merged = mergePlanStatusLookup(authoritative, mirrored);
    expect(merged.get(plan.goal)!.status).toBe('failed');
    expect(merged.get(plan.goal)!.failedTaskId).toBe('t2');

    // 同级（均 failed）：保留权威，但补镜像独有的 wfSnapshot（抽屉回退数据源）。
    const mirrorWithSnap = buildPlanStatusLookup([
      {
        plan,
        planStatus: {
          status: 'failed',
          failedTaskId: 't2',
          done: ['t1'],
          wfSnapshot: { state: 'failed', steps: {} } as never
        }
      }
    ]);
    const merged2 = mergePlanStatusLookup(authoritative, mirrorWithSnap);
    expect(merged2.get(plan.goal)!.status).toBe('failed');
    expect(merged2.get(plan.goal)!.wfSnapshot).toEqual({
      state: 'failed',
      steps: {}
    });
  });
});

describe('核心回归：串行执行中断（t6 失败 → 切走重开）不得回退 t1 全量重跑', () => {
  it('派发前落盘的 running 镜像含完整 done 集合与当前任务（恢复收敛为 failed+t6）', () => {
    // confirmPlan 派发 t6 前的 planExec（saveHistory 写穿落盘）：
    const exec: PlanExecState = {
      status: 'running',
      currentTaskId: 't6',
      done: { t1: true, t2: true, t3: true, t4: true, t5: true }
    };
    // t1-t6 七任务计划（比文件顶部的三任务 plan 多几个，贴近实测场景）。
    const plan6: ExecutionPlanView = {
      goal: '多任务报告',
      tasks: ['t1', 't2', 't3', 't4', 't5', 't6'].map((id) => ({
        id,
        title: `任务 ${id}`,
        steps: [],
        dependsOn: [],
        expectedOutput: 'x'
      }))
    };
    const planCard: ChatMsg = { id: 7, role: 'assistant', content: 'x', plan: plan6 };
    // 落盘：stampPlanStatus 把 running+t6+done[t1..t5] 写穿到计划卡消息。
    const stamped = stampPlanStatus([planCard], { 7: exec }) as Array<
      Record<string, unknown>
    >;
    // 恢复：服务端权威缺失（重启回落 / 未配 CHAT_SESSIONS_FILE / 拉取失败降级），
    // 本地镜像是唯一来源 —— mergePlanStatusLookup 接线后 lookup 必须命中。
    const lookup = mergePlanStatusLookup(
      new Map(),
      buildPlanStatusLookup(stamped as never)
    );
    const ps = lookup.get(plan6.goal)!;
    expect(ps.status).toBe('running');
    expect(ps.currentTaskId).toBe('t6');
    expect(ps.done).toEqual(['t1', 't2', 't3', 't4', 't5']);
    // chat.ts applyPlanStatusLookup 对 running 的收敛语义（中断 ≠ 丢失）：
    // failed + failedTaskId=currentTaskId，done 集合原样保留 → 「从失败任务继续」
    // 在串行循环里凭 done map 跳过 t1-t5，从 t6 续跑。
    const restored: PlanExecState = {
      status: 'failed',
      failedTaskId: ps.currentTaskId,
      done: Object.fromEntries((ps.done ?? []).map((id) => [id, true]))
    };
    expect(restored.failedTaskId).toBe('t6');
    expect(restored.done['t1']).toBe(true);
    expect(restored.done['t5']).toBe(true);
    expect(restored.done['t6']).toBeUndefined();
  });

  it('失败终态落盘的镜像：failed+failedTaskId 原样还原（不收敛不降级）', () => {
    const exec: PlanExecState = {
      status: 'failed',
      failedTaskId: 't6',
      done: { t1: true, t2: true, t3: true, t4: true, t5: true }
    };
    const planCard: ChatMsg = { id: 7, role: 'assistant', content: 'x', plan };
    const stamped = stampPlanStatus([planCard], { 7: exec }) as Array<
      Record<string, unknown>
    >;
    const lookup = buildPlanStatusLookup(stamped as never);
    const ps = lookup.get(plan.goal)!;
    expect(ps.status).toBe('failed');
    expect(ps.failedTaskId).toBe('t6');
    expect(ps.done).toEqual(['t1', 't2', 't3', 't4', 't5']);
  });
});

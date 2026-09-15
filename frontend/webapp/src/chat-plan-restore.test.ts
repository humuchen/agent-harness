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

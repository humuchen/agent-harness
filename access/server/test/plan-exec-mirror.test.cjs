'use strict';
/**
 * 计划执行进度镜像单测（计划卡片「已执行完成却仍显示待确认 / 执行失败」回归防护）。
 *
 * 覆盖：
 * - extractPlanTaskId：run:start 的任务 id 提取（宽匹配 tN / 1 / task-1）
 * - updatePlanStatus：任务派发 → running + currentTaskId；任务完成 → 计入 done
 * - 全部任务完成后镜像收敛为 done（此前恒为 running，导致刷新后前端把已成功的计划
 *   显示为「执行失败」）
 * - 归属校验 / 无计划消息 / cancelled、failed 不被覆盖
 *
 * 运行：pnpm --filter @agent-harness/server run build && node --test access/server/test/plan-exec-mirror.test.cjs
 */
const assert = require('assert');
const { test } = require('node:test');

const mod = require('../dist/chat-sessions.js');

const OWNER = 'u-plan';
const PLAN = {
  goal: '分析报告',
  tasks: [
    { id: 't1', title: '文本', steps: [], dependsOn: [], expectedOutput: 'x' },
    { id: 't2', title: '插画', steps: [], dependsOn: [], expectedOutput: 'x' },
    { id: 't3', title: '配色', steps: [], dependsOn: [], expectedOutput: 'x' }
  ]
};

/** 建一个「已生成计划」的会话，返回 session id。 */
function sessionWithPlan(plan = PLAN) {
  const s = mod.createChatSession('计划会话', OWNER);
  mod.appendChatMessage(
    s.id,
    { role: 'assistant', content: `📋 ${plan.goal}`, ts: Date.now(), plan },
    OWNER
  );
  return s.id;
}

const mirrorOf = (sid, owner = OWNER) => {
  const s = mod.peekChatSession(sid, owner);
  return s.messages.filter((m) => m.plan).at(-1).planStatus;
};

/** 复刻 server.ts 的两处镜像写入（run:start 派发 / run:end 完成）。 */
function dispatch(sid, taskId) {
  mod.updatePlanStatus(
    sid,
    (prev) => ({ ...prev, status: 'running', currentTaskId: taskId, failedTaskId: undefined }),
    OWNER
  );
}
function finishCurrent(sid) {
  mod.updatePlanStatus(
    sid,
    (prev) => {
      if (!prev.currentTaskId || prev.done.includes(prev.currentTaskId)) return prev;
      return {
        ...prev,
        status: 'running',
        done: [...prev.done, prev.currentTaskId],
        currentTaskId: undefined
      };
    },
    OWNER
  );
}

test('extractPlanTaskId: 宽匹配任务 id（tN / 数字 / 其它命名）', () => {
  assert.strictEqual(mod.extractPlanTaskId('【计划任务 t1】提取文本'), 't1');
  assert.strictEqual(mod.extractPlanTaskId('【计划任务 1】提取文本'), '1');
  assert.strictEqual(mod.extractPlanTaskId('【计划任务 task-2】提取文本'), 'task-2');
  assert.strictEqual(mod.extractPlanTaskId('【计划任务 t 12】提取文本'), 't 12');
  assert.strictEqual(mod.extractPlanTaskId('普通用户提问'), null);
  assert.strictEqual(mod.extractPlanTaskId('prefix 【计划任务 t1】x'), null);
  assert.strictEqual(mod.extractPlanTaskId(undefined), null);
  assert.strictEqual(mod.extractPlanTaskId({ a: 1 }), null);
  // 不含 id 的畸形前缀不得被当作任务派发。
  assert.strictEqual(mod.extractPlanTaskId('【计划任务 】x'), null);
});

test('任务派发：currentTaskId 写入镜像且状态为 running', () => {
  const sid = sessionWithPlan();
  dispatch(sid, 't1');
  const ps = mirrorOf(sid);
  assert.strictEqual(ps.status, 'running');
  assert.strictEqual(ps.currentTaskId, 't1');
  assert.deepStrictEqual(ps.done, []);
});

test('任务完成：计入 done、清空 currentTaskId，未全完成时仍为 running', () => {
  const sid = sessionWithPlan();
  dispatch(sid, 't1');
  finishCurrent(sid);
  const ps = mirrorOf(sid);
  assert.strictEqual(ps.status, 'running');
  assert.strictEqual(ps.currentTaskId, undefined);
  assert.deepStrictEqual(ps.done, ['t1']);
});

test('全部任务完成：镜像收敛为 done（核心回归：此前恒为 running）', () => {
  const sid = sessionWithPlan();
  for (const id of ['t1', 't2', 't3']) {
    dispatch(sid, id);
    finishCurrent(sid);
  }
  const ps = mirrorOf(sid);
  assert.strictEqual(ps.status, 'done');
  assert.deepStrictEqual(ps.done, ['t1', 't2', 't3']);
  assert.strictEqual(ps.currentTaskId, undefined);
  assert.strictEqual(ps.failedTaskId, undefined);
});

test('重复完成同一任务不会重复计入 done', () => {
  const sid = sessionWithPlan();
  dispatch(sid, 't1');
  finishCurrent(sid);
  finishCurrent(sid); // run-queue 会补发一次 run:end
  assert.deepStrictEqual(mirrorOf(sid).done, ['t1']);
});

test('failed 不被 done 收敛覆盖（不掩盖错误）', () => {
  const sid = sessionWithPlan();
  for (const id of ['t1', 't2', 't3']) {
    dispatch(sid, id);
    finishCurrent(sid);
  }
  mod.updatePlanStatus(
    sid,
    () => ({ status: 'failed', failedTaskId: 't3', done: ['t1', 't2', 't3'] }),
    OWNER
  );
  assert.strictEqual(mirrorOf(sid).status, 'failed');
});

test('cancelled 不被 done 收敛覆盖', () => {
  const sid = sessionWithPlan();
  mod.updatePlanStatus(
    sid,
    () => ({ status: 'cancelled', done: ['t1', 't2', 't3'] }),
    OWNER
  );
  assert.strictEqual(mirrorOf(sid).status, 'cancelled');
});

test('宽匹配引入的非计划 id：不影响完成判定，也不会促成 done', () => {
  const sid = sessionWithPlan();
  // 形如「【计划任务 x】…」的非计划消息（用户手输 / 其它计划）：只记进度、不判定完成。
  dispatch(sid, 't99');
  finishCurrent(sid);
  assert.strictEqual(mirrorOf(sid).status, 'running');
  assert.deepStrictEqual(mirrorOf(sid).done, ['t99']);

  // 计划内任务补齐后才收敛为 done（计划间互不干扰）。
  for (const id of ['t1', 't2', 't3']) {
    dispatch(sid, id);
    finishCurrent(sid);
  }
  assert.strictEqual(mirrorOf(sid).status, 'done');
  assert.deepStrictEqual(mirrorOf(sid).done, ['t99', 't1', 't2', 't3']);
});

test('owner 不符：静默跳过，不写入镜像', () => {
  const sid = sessionWithPlan();
  mod.updatePlanStatus(
    sid,
    (prev) => ({ ...prev, status: 'running', currentTaskId: 't1' }),
    'someone-else'
  );
  assert.strictEqual(mirrorOf(sid), undefined);
});

test('会话无计划消息：不做任何事（普通问答不受影响）', () => {
  const s = mod.createChatSession('普通会话', OWNER);
  mod.appendChatMessage(s.id, { role: 'user', content: '你好', ts: Date.now() }, OWNER);
  mod.updatePlanStatus(
    s.id,
    (prev) => ({ ...prev, status: 'running', currentTaskId: 't1' }),
    OWNER
  );
  const msgs = mod.peekChatSession(s.id, OWNER).messages;
  assert.strictEqual(msgs.every((m) => m.planStatus === undefined), true);
});

/** 复刻 server.ts run 事件流 error 分支的镜像写入（t6 失败场景，前端刷新恢复的权威源）。 */
function failCurrent(sid) {
  mod.updatePlanStatus(
    sid,
    (prev) => ({
      ...prev,
      status: 'failed',
      failedTaskId: prev.currentTaskId,
      currentTaskId: undefined
    }),
    OWNER
  );
}

test('任务失败（error 事件）：镜像置 failed + failedTaskId，done 保留已完成集合', () => {
  const sid = sessionWithPlan();
  // t1-t2 顺序完成，t3 失败（贴近实测 t6 失败场景的最小等价）。
  for (const id of ['t1', 't2']) {
    dispatch(sid, id);
    finishCurrent(sid);
  }
  dispatch(sid, 't3');
  failCurrent(sid);
  const ps = mirrorOf(sid);
  assert.strictEqual(ps.status, 'failed');
  assert.strictEqual(ps.failedTaskId, 't3');
  assert.strictEqual(ps.currentTaskId, undefined);
  assert.deepStrictEqual(ps.done, ['t1', 't2']);
});

test('失败后的 run:end（final 带错误前缀）：currentTaskId 已空 → done 不重复记、failed 不被覆盖', () => {
  const sid = sessionWithPlan();
  dispatch(sid, 't1');
  finishCurrent(sid);
  dispatch(sid, 't2');
  failCurrent(sid);
  // harness 失败时先 emit error 再 emit run:end（final = ERROR_PREFIX + message）；
  // run:end 的完成 mutate 必须因 currentTaskId 已空而原样返回。
  finishCurrent(sid);
  const ps = mirrorOf(sid);
  assert.strictEqual(ps.status, 'failed');
  assert.strictEqual(ps.failedTaskId, 't2');
  assert.deepStrictEqual(ps.done, ['t1']);
});

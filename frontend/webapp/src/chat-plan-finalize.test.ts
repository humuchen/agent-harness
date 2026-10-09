/**
 * P1-11：plan 终态交付链「先置 done 再 attach」时序守护。
 *
 * 背景：attachPlanDeliverables 有状态门禁 —— 仅 planExec.status==='done' 才归档
 * 「计划执行报告」并追加「📎 交付文件」区（与后端「仅 done run 归档」同语义）。
 * 历史事故：串行回退路径旧顺序是「saveHistory 后才置 done」，attach 在门禁处被
 * 静默挡掉，用户拿不到可下载的结果文件 —— 且不报任何错。
 *
 * chat.ts 是 5820 行的 Lit 组件，接线编排依赖 DOM / authedFetch / localStorage，
 * 无法按既有纯函数范式直测（chat-plan-artifacts.test.ts 注释亦明示「靠 tsc +
 * vite build 兜底」）。因此本文件用两层守护锁住交付闭环：
 *
 * 1. 门禁纯函数单测（planDeliverablesEnabled，单源抽到 chat-render-utils）；
 * 2. chat.ts 源码锚点守护：4 处 attach 调用点逐一断言「先置 done 再 attach」，
 *    且串行路径 attach 之后必须 saveHistory（交付区改动不落盘 = 刷新即丢）。
 *
 * 锚点全部选用稳定的代码语句（非注释），修改实现时若锚点失配会显式失败 ——
 * 此时请同步更新锚点，而不是放松断言。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planDeliverablesEnabled } from './chat-render-utils';

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
const chatSrc = fs.readFileSync(path.join(SRC_DIR, 'chat.ts'), 'utf8');

/** 唯一锚点定位（找不到 / 重复出现都显式失败，防止守护被静默架空）。 */
function anchor(needle: string): number {
  const first = chatSrc.indexOf(needle);
  expect(first, `锚点应存在于 chat.ts：${needle}`).toBeGreaterThanOrEqual(0);
  expect(
    chatSrc.indexOf(needle, first + 1),
    `锚点应唯一（否则切片窗口失真）：${needle}`
  ).toBe(-1);
  return first;
}

/** 在 [from, to) 窗口内断言子串存在，返回其绝对索引。 */
function within(needle: string, from: number, to: number, what: string): number {
  const hit = chatSrc.indexOf(needle, from);
  expect(
    hit >= from && hit < to,
    `${what}：应在指定窗口内找到「${needle}」（窗口 ${from}..${to}，实际 ${
      hit < 0 ? '未找到' : hit
    }）`
  ).toBe(true);
  return hit;
}

describe('planDeliverablesEnabled（交付门禁纯函数）', () => {
  it('仅 done 放行', () => {
    expect(planDeliverablesEnabled('done')).toBe(true);
  });

  it('非终态 / 失败 / 取消 / 缺失一律拦截', () => {
    expect(planDeliverablesEnabled(undefined)).toBe(false);
    expect(planDeliverablesEnabled('')).toBe(false);
    expect(planDeliverablesEnabled('pending')).toBe(false);
    expect(planDeliverablesEnabled('running')).toBe(false);
    expect(planDeliverablesEnabled('awaiting')).toBe(false);
    expect(planDeliverablesEnabled('failed')).toBe(false);
    expect(planDeliverablesEnabled('cancelled')).toBe(false);
  });
});

describe('chat.ts 交付链时序守护（4 处 attach 调用点）', () => {
  it('attachPlanDeliverables 恰好 4 处调用（漏接线 / 重复接线都失败）', () => {
    const calls = chatSrc.match(/this\.attachPlanDeliverables\(/g) ?? [];
    expect(calls.length).toBe(4);
  });

  it('门禁已单源化：attachPlanDeliverables 内走 planDeliverablesEnabled，且是第一道关卡', () => {
    const fnStart = anchor('private async attachPlanDeliverables(');
    const fnEnd = anchor('private async reattachPlanDeliverables(');
    const gate = within('planDeliverablesEnabled(', fnStart, fnEnd, '门禁接线');
    // 门禁必须先于 derivePlanWfId / fetch 等重活（拦截语义 = 未 done 时零副作用）。
    const derive = within('derivePlanWfId(', gate, fnEnd, '门禁之后的首个动作');
    expect(gate).toBeLessThan(derive);
  });

  it('串行回退路径（confirmPlan 收尾）：先置 done 再 attach，attach 后 saveHistory', () => {
    const attach = anchor(
      'await this.attachPlanDeliverables(sid, m, summaryMsgId, taskOutputs);'
    );
    // 紧邻前置窗口：置 done 块（cur = { ...cur, status: 'done', ... }）必须出现在
    // attach 之前且相距不远 —— 若被挪回 saveHistory 之后，窗口内将找不到该置位。
    const before = chatSrc.slice(Math.max(0, attach - 700), attach);
    expect(before).toContain("status: 'done',");
    // attach 会修改摘要消息（追加交付文件区）→ 必须有 saveHistory 落盘兜底。
    const after = chatSrc.slice(attach, attach + 500);
    expect(after).toContain('this.saveHistory(sid)');
  });

  it('DAG 主路径（wf:done 帧）：状态机先写入 planExec，分支内才 attach', () => {
    const apply = anchor('const next = applyPlanWfEvent(prev, e, taskIds);');
    const write = anchor(
      'this.planExec = { ...this.planExec, [m.id]: next };'
    );
    const branch = anchor(
      "if (e.type === 'wf:done' || e.type === 'wf:failed') {"
    );
    const attach = within(
      'this.attachPlanDeliverables(',
      branch,
      anchor("if (e.type === '_wf_done') {"),
      'wf:done 分支内 attach'
    );
    // applyPlanWfEvent 对 wf:done 置 status:'done'（纯函数语义由
    // chat-plan-wf-state.test.ts 锁定）→ 写入 planExec 先于 attach，门禁才放行。
    expect(apply).toBeLessThan(write);
    expect(write).toBeLessThan(branch);
    expect(branch).toBeLessThan(attach);
  });

  it('DAG 兜底路径（_wf_done 帧）：done 分支内先就地置 done 再 attach', () => {
    const start = anchor("if (e.type === '_wf_done') {");
    const end = anchor("if (e.type === 'wf:error') {");
    const branch = within("if (rs === 'done') {", start, end, 'done 收敛分支');
    const setStatus = within(
      "{ ...s, status: 'done', currentTaskId: undefined }",
      branch,
      end,
      '_wf_done 置 done'
    );
    const attach = within(
      'this.attachPlanDeliverables(',
      branch,
      end,
      '_wf_done attach'
    );
    expect(setStatus).toBeLessThan(attach);
  });

  it('断连自愈（reconcilePlanWfOnDisconnect poll）：先收敛终态再 attach，attach 改动了摘要就落盘', () => {
    const fnStart = anchor('private reconcilePlanWfOnDisconnect(');
    const fnEnd = anchor('private renderCtx(): ChatRenderCtx {');
    const terminal = within(
      "if (state === 'done' || state === 'failed') {",
      fnStart,
      fnEnd,
      '终态收敛分支'
    );
    const setStatus = within('status: state,', terminal, fnEnd, '置终态');
    const attach = within(
      'this.attachPlanDeliverables(',
      terminal,
      fnEnd,
      '断连自愈 attach'
    );
    expect(setStatus).toBeLessThan(attach);
    // 此入口无调用方统一落盘（注释明示「attach 修改了摘要消息时就地 saveHistory」）。
    within('this.saveHistory(sid)', attach, fnEnd, '断连自愈落盘');
  });
});

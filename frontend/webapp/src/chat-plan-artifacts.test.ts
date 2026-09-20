/**
 * 计划交付文件（P4.6 延伸：执行报告汇总归档）单测。
 *
 * 背景：plan 执行结束后用户拿不到可下载的结果文件 —— DAG 归档只有逐任务文件、
 * 串行路径完全没有归档，且前端「📎 交付文件」渲染函数从未接线。本文件锁定
 * 汇总报告生成的纯函数契约（文件名安全化 / run 快照产出提取 / 报告全文组装），
 * 接线编排（attachPlanDeliverables）在 chat.ts 内，靠 tsc + vite build 兜底。
 */
import { describe, it, expect } from 'vitest';
import {
  buildPlanReportFileName,
  buildPlanFinalReport,
  planOutputsFromRun,
  PLAN_FINAL_ARTIFACT_NOTE,
  PLAN_REPORT_TASK_MAX
} from './chat-render-utils';

describe('buildPlanReportFileName', () => {
  it('普通 goal 生成「计划报告-<goal>.md」', () => {
    expect(buildPlanReportFileName('分析报告')).toBe('计划报告-分析报告.md');
  });

  it('文件系统/URL 非法字符被剔除，不破坏下载链接', () => {
    const name = buildPlanReportFileName('做 A/B 测试: v2? 最终*版');
    expect(name).not.toMatch(/[/\\:*?"<>|]/);
    expect(name).toBe('计划报告-做 AB 测试 v2 最终版.md');
  });

  it('goal 为空/全非法字符时回落固定名（不产出空文件名）', () => {
    expect(buildPlanReportFileName('')).toBe('计划报告-执行结果.md');
    expect(buildPlanReportFileName('///')).toBe('计划报告-执行结果.md');
  });

  it('超长 goal 截断到 40 字符（防下载头 filename 爆炸）', () => {
    const name = buildPlanReportFileName('长'.repeat(100));
    expect(name.length).toBeLessThanOrEqual('计划报告-.md'.length + 40);
  });
});

describe('planOutputsFromRun', () => {
  it('仅提取 done 且非空的字符串产出', () => {
    const out = planOutputsFromRun({
      steps: {
        t1: { state: 'done', output: '产出一' },
        t2: { state: 'failed', output: '不该出现' },
        t3: { state: 'done', output: '   ' },
        t4: { state: 'pending', output: '不该出现' }
      }
    });
    expect(out).toEqual({ t1: '产出一' });
  });

  it('非字符串产出按 JSON 序列化（与摘要回挂同语义）', () => {
    const out = planOutputsFromRun({
      steps: { t1: { state: 'done', output: { key: 'v', n: 1 } } }
    });
    expect(out.t1).toBeTruthy();
    expect(JSON.parse(out.t1!)).toEqual({ key: 'v', n: 1 });
  });

  it('null/undefined output 与 null run 安全回落空对象', () => {
    expect(planOutputsFromRun({ steps: { t1: { state: 'done' } } })).toEqual({});
    expect(planOutputsFromRun(null)).toEqual({});
    expect(planOutputsFromRun(undefined)).toEqual({});
  });
});

describe('buildPlanFinalReport', () => {
  const tasks = [
    { id: 't1', title: '提取文本', state: 'done' },
    { id: 't2', title: '整合排版', state: 'done' }
  ];

  it('含标题、元信息、状态清单与逐任务产出全文', () => {
    const report = buildPlanFinalReport('整理资料', tasks, {
      t1: '原始文本内容',
      t2: '最终整合稿'
    });
    expect(report).toContain('# 计划执行报告：整理资料');
    expect(report).toContain('共 2 个任务，完成 2 个');
    expect(report).toContain('- ✅ **t1** 提取文本（done）');
    expect(report).toContain('### t1 · 提取文本');
    expect(report).toContain('原始文本内容');
    expect(report).toContain('最终整合稿');
  });

  it('缺产出任务显式标注（不留空白章节）', () => {
    const report = buildPlanFinalReport('g', tasks, { t1: '只有 t1' });
    expect(report).toContain('只有 t1');
    expect(report).toContain('（该任务已完成，但未产出可归档的内容。）');
  });

  it('超长产出截断并标注（单任务上限 PLAN_REPORT_TASK_MAX）', () => {
    const long = 'x'.repeat(PLAN_REPORT_TASK_MAX + 1000);
    const report = buildPlanFinalReport('g', [tasks[0]!], { t1: long });
    expect(report).toContain('…（产出超长已截断');
    expect(report.length).toBeLessThan(PLAN_REPORT_TASK_MAX + 500);
  });

  it('幂等键常量：__plan_final__（与服务端去重语义共用，防漂移钉死）', () => {
    expect(PLAN_FINAL_ARTIFACT_NOTE).toBe('__plan_final__');
  });
});

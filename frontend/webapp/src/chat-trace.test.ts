import { describe, it, expect } from 'vitest';
import { buildInsights, parseCostBreakdown } from './chat-trace';
import type { TraceNode } from '@agent-harness/client';

/**
 * 「关键信息」面板的 Token 口径回归。
 *
 * 背景（真实故障）：harness 每步发一条 run:cost，节点 meta.tokens 是该步结束时的
 * **累计值**。此前 buildInsights 用 find() 取 DFS 首节点 → 5 步运行只显示第 1 步的累计，
 * 用户看到「步骤 5 / Token 11278」却对不上整轮消耗。这里锁死「整轮累计」语义。
 */

/** 造一个 cost 节点（meta 键与 chat.ts traceHandle 写入的完全一致）。 */
function costNode(tokens: string, est?: Record<string, string>): TraceNode {
  return {
    id: `c${tokens}`,
    kind: 'cost',
    label: '成本 / 用量',
    status: 'ok',
    meta: { tokens, ...(est ?? {}) },
    children: []
  };
}

/** 造 step 节点（cost 挂在 step 下，与前端 traceHandle 一致）。 */
function stepNode(idx: number, children: TraceNode[]): TraceNode {
  return {
    id: `s${idx}`,
    kind: 'step',
    label: `第 ${idx} 步`,
    status: 'ok',
    children
  };
}

function rootNode(children: TraceNode[]): TraceNode {
  return {
    id: 't0',
    kind: 'run',
    label: '运行',
    status: 'ok',
    meta: { model: 'dots-studio/x', agent: 'medical-aesthetics-lead', mode: 'real' },
    children
  };
}

describe('buildInsights · Token 取整轮累计（不是第 1 步）', () => {
  it('多步运行取累计峰值：5 步时不再显示第 1 步的用量', () => {
    const ins = buildInsights([
      rootNode([
        stepNode(1, [costNode('5000', { 系统: '1200', 工具: '3600', 历史: '10', 输出: '6' })]),
        stepNode(2, [costNode('8600')]),
        stepNode(3, [costNode('11278')])
      ])
    ]);
    expect(ins.costTokens).toBe('11278');
    expect(ins.steps).toBe(3);
  });

  it('节点乱序也取峰值（不依赖遍历顺序）', () => {
    const ins = buildInsights([
      rootNode([
        stepNode(1, [costNode('11278')]),
        stepNode(2, [costNode('5000')])
      ])
    ]);
    expect(ins.costTokens).toBe('11278');
  });

  it('成本同样取累计峰值；priced 取最后一个有效值', () => {
    const a = costNode('5000');
    a.meta = { ...a.meta, cost: '$0.0031', priced: 'true' };
    const b = costNode('11278');
    b.meta = { ...b.meta, cost: '$0.0124', priced: 'false' };
    const ins = buildInsights([rootNode([stepNode(1, [a]), stepNode(2, [b])])]);
    expect(ins.costValue).toBe('$0.0124');
    expect(ins.costPriced).toBe('false');
  });

  it('tokens 为占位符（?）时不产出脏数据', () => {
    const ins = buildInsights([rootNode([stepNode(1, [costNode('?')])])]);
    expect(ins.costTokens).toBeUndefined();
  });
});

describe('buildInsights · Token 拆解跨步聚合', () => {
  it('四项按步求和，占比分母为四项之和', () => {
    const ins = buildInsights([
      rootNode([
        stepNode(1, [
          costNode('5000', { 系统: '1200', 工具: '3600', 历史: '10', 输出: '6' })
        ]),
        stepNode(2, [
          costNode('11278', { 系统: '1705', 工具: '6484', 历史: '10', 输出: '6' })
        ])
      ])
    ]);
    expect(ins.costBreakdown).toEqual([
      { label: '系统', tokens: 2905, pct: 22 },
      { label: '工具', tokens: 10084, pct: 77 },
      { label: '历史', tokens: 20, pct: 0 },
      { label: '输出', tokens: 12, pct: 0 }
    ]);
    // 分母是四项之和，与面板 Token 不同基准（11278 来自 provider 实测累计）。
    expect(ins.costTokens).toBe('11278');
  });

  it('单步运行行为不变（回归保护）', () => {
    const ins = buildInsights([
      rootNode([
        stepNode(1, [
          costNode('11278', {
            系统: '1705',
            工具: '6484 (79%)',
            历史: '10 (0%)',
            输出: '6'
          })
        ])
      ])
    ]);
    expect(ins.costTokens).toBe('11278');
    expect(ins.costBreakdown).toEqual([
      { label: '系统', tokens: 1705, pct: 21 },
      { label: '工具', tokens: 6484, pct: 79 },
      { label: '历史', tokens: 10, pct: 0 },
      { label: '输出', tokens: 6, pct: 0 }
    ]);
  });

  it('只有部分步带分项时不丢数据，也保留出现顺序', () => {
    const ins = buildInsights([
      rootNode([
        stepNode(1, [costNode('5000', { 系统: '1200', 工具: '3600' })]),
        stepNode(2, [costNode('11278')])
      ])
    ]);
    expect(ins.costBreakdown).toEqual([
      { label: '系统', tokens: 1200, pct: 25 },
      { label: '工具', tokens: 3600, pct: 75 }
    ]);
  });

  it('任何步都没有分项 → undefined（由 UI 展示降级文案）', () => {
    const ins = buildInsights([
      rootNode([stepNode(1, [costNode('11278')]), stepNode(2, [costNode('12000')])])
    ]);
    expect(ins.costTokens).toBe('12000');
    expect(ins.costBreakdown).toBeUndefined();
  });

  it('无 cost 节点（mock / 无 usage）时整体留空', () => {
    const ins = buildInsights([rootNode([stepNode(1, [])])]);
    expect(ins.costTokens).toBeUndefined();
    expect(ins.costBreakdown).toBeUndefined();
  });
});

describe('buildInsights · Token 缓存命中率取最新快照', () => {
  const cacheNode = (rate: string): TraceNode => ({
    id: `tc${rate}`,
    kind: 'tokencache',
    label: 'Token 缓存命中率',
    status: 'ok',
    meta: { 命中率: rate, 命中: '~1/2' },
    children: []
  });

  it('多个缓存节点时取最后一个（进程级累计快照，越后越完整）', () => {
    const ins = buildInsights([
      rootNode([
        stepNode(1, [cacheNode('~0.0%')]),
        stepNode(2, [cacheNode('~42.0%')])
      ])
    ]);
    expect(ins.cacheHitRate).toBe('~42.0%');
  });
});

describe('parseCostBreakdown · 单节点解析保持原语义', () => {
  it('百分比缺失时按四项之和兜底', () => {
    expect(
      parseCostBreakdown({ 系统: '100', 工具: '300' })
    ).toEqual([
      { label: '系统', tokens: 100, pct: 25 },
      { label: '工具', tokens: 300, pct: 75 }
    ]);
  });

  it('无 meta 返回 undefined', () => {
    expect(parseCostBreakdown(undefined)).toBeUndefined();
  });
});

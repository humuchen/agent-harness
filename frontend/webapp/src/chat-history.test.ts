import { describe, it, expect } from 'vitest';
import {
  truncateForSize,
  sanitizeMessages,
  type MirroredMsg,
  type MirroredUsage
} from './chat-history';

/** 构造 n 条 assistant 消息，每条 content 长为 contentLen。 */
function makeMsgs(n: number, contentLen: number): MirroredMsg[] {
  const s = 'x'.repeat(contentLen);
  return Array.from({ length: n }, (_, i) => ({
    role: 'assistant',
    content: s,
  }));
}

describe('truncateForSize', () => {
  const usage: MirroredUsage = {
    backendUsage: {
      window: 128000,
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      breakdown: { system: 10, tools: 20, messages: 100, mcp: 5, skills: 3, completion: 50 }
    },
    runCumulative: { tokens: 150, cost: 0.01 }
  };

  it('空数组原样返回', () => {
    expect(truncateForSize([], usage)).toEqual([]);
  });

  it('体积在限制内时原样返回全部消息', () => {
    const msgs = makeMsgs(3, 100);
    const result = truncateForSize(msgs, usage, 10_000);
    expect(result).toBe(msgs);
    expect(result.length).toBe(3);
  });

  it('超出上限时从最旧的开始裁剪，保留尾部最新消息', () => {
    // 5 条消息，每条 1000 字符 → 序列化 ≈ 5000 字节，设上限 3000
    const msgs = makeMsgs(5, 1000);
    const result = truncateForSize(msgs, usage, 3000);
    expect(result.length).toBeLessThan(5);
    expect(result.length).toBeGreaterThanOrEqual(1);
    // 保留的是尾部（最新）消息，不是头部
    expect(result[0]).toBe(msgs[msgs.length - result.length]);
  });

  it('单条消息本身就超限时，保留最后 1 条（无法再裁剪）', () => {
    const msgs = makeMsgs(2, 100_000);
    const result = truncateForSize(msgs, usage, 100); // 100 字节上限
    expect(result.length).toBe(1);
    expect(result[0]).toBe(msgs[1]);
  });

  it('不带 usage 的上限计算正确', () => {
    const msgs = makeMsgs(5, 1000);
    // 只带 msgs（无 usage）时的上限
    const result = truncateForSize(msgs, null, 3000);
    expect(result.length).toBeLessThan(5);
  });

  it('默认上限为 512KB', () => {
    // 200 条消息，每次 1000 字符 → 约 200KB，应在默认 512KB 内不被裁剪
    const msgs = makeMsgs(200, 1000);
    const result = truncateForSize(msgs, null); // 用默认上限
    expect(result.length).toBe(200);
  });

  it('裁剪后序列化体积确实 <= 上限', () => {
    const msgs = makeMsgs(20, 10_000);
    const limit = 50_000;
    const result = truncateForSize(msgs, null, limit);
    const serialized = new TextEncoder().encode(
      JSON.stringify({ msgs: result })
    ).length;
    expect(serialized).toBeLessThanOrEqual(limit);
  });
});
